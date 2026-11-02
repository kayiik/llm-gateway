import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';

// Only this ingress proxy joins the host-access network; Gateway and its fixture stay isolated.
const handler = (request, response) => {
  if (request.url === '/__qualification__/axe.min.js' && process.env.REPLAY_AXE_SCRIPT) {
    response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(readFileSync(process.env.REPLAY_AXE_SCRIPT)); return;
  }
  const headers = { ...request.headers };
  for (const name of Object.keys(headers)) if (name.startsWith('x-authentik-') || name === 'x-llmgw-sso-secret' || name === 'x-forwarded-proto') delete headers[name];
  const owner = process.env.REPLAY_SSO_SUBJECT;
  headers.host = owner ? request.headers.host : 'gateway:8787';
  if (owner) {
    headers['x-llmgw-sso-secret'] = process.env.REPLAY_SSO_SECRET;
    headers['x-authentik-uid'] = owner;
    headers['x-authentik-name'] = process.env.REPLAY_SSO_NAME;
    headers['x-authentik-email'] = process.env.REPLAY_SSO_EMAIL;
    headers['x-authentik-groups'] = process.env.REPLAY_SSO_GROUPS ?? '';
    headers['x-forwarded-proto'] = request.socket.encrypted ? 'https' : 'http';
  }
  const upstream = http.request({
    hostname: 'gateway', port: 8787, method: request.method, path: request.url,
    headers,
  }, answer => {
    response.writeHead(answer.statusCode, answer.headers);
    answer.pipe(response);
  });
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain' });
    response.end('Isolated Gateway is unavailable');
  });
  request.on('aborted', () => upstream.destroy());
  // SDKs usually cancel while reading a response, after the request body was
  // sent; aborting only the request leaves the provider stream running.
  response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
  request.pipe(upstream);
};
const server = process.env.REPLAY_TLS_KEY && process.env.REPLAY_TLS_CERT
  ? https.createServer({ key: readFileSync(process.env.REPLAY_TLS_KEY), cert: readFileSync(process.env.REPLAY_TLS_CERT) }, handler)
  : http.createServer(handler);
server.listen(8787, '0.0.0.0');
