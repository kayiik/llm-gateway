import { Buffer } from 'node:buffer';

const authForms = headers => {
  const forms = [];
  if (headers.authorization) {
    const scheme = headers.authorization.split(' ', 1)[0].toLowerCase();
    forms.push(['bearer', 'basic'].includes(scheme) ? scheme : 'authorization');
  }
  for (const name of ['api-key', 'x-api-key', 'xi-api-key', 'x-goog-api-key']) if (headers[name]) forms.push(name);
  return forms;
};

// Captured wire is a finite set of cases, not a synthetic provider API. A
// changed request cannot borrow a success response from an unrelated case.
export function createCapturedWireReplay(cases, hostAliases = {}) {
  if (!cases.length || cases.some(record => !record.complete || !record.request_complete || record.request_truncated || record.response_truncated || !record.status)) {
    throw new Error('only complete and untruncated outbound captures can become replay cases');
  }
  if (new Set(cases.map(record => record.host).filter(Boolean)).size > 1 && !Object.keys(hostAliases).length) throw new Error('distinct recorded hosts need explicit local aliases');
  const metrics = { served: [], rejected: 0 };
  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > (32 << 20)) { metrics.rejected++; res.writeHead(413); res.end(); return; } chunks.push(chunk); }
    const body = Buffer.concat(chunks);
    const candidate = cases.find(record => (!record.host || !Object.keys(hostAliases).length || hostAliases[record.host] === req.headers.host?.split(':')[0]) && record.method === req.method && record.path === url.pathname && (record.query ?? '') === url.searchParams.toString() &&
      body.equals(Buffer.from(record.request_body_base64 ?? '', 'base64')) &&
      JSON.stringify(record.auth_forms ?? []) === JSON.stringify(authForms(req.headers)) &&
      Object.entries(record.request_headers ?? {}).every(([key, value]) => req.headers[key.toLowerCase()] === value));
    if (!candidate) { metrics.rejected++; res.writeHead(422, { 'Content-Type': 'application/json' }); res.end('{"error":"captured source request did not match"}'); return; }
    metrics.served.push({ path: candidate.path, status: candidate.status, terminal: candidate.terminal_event ?? '' });
    res.writeHead(candidate.status, Object.fromEntries(Object.entries(candidate.response_headers ?? {}).filter(([key]) => ['content-type', 'retry-after', 'etag'].includes(key.toLowerCase()))));
    res.end(Buffer.from(candidate.response_body_base64 ?? '', 'base64'));
  };
  return { handle, metrics };
}
