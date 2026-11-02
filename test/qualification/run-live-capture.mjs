#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { assessGatewayAnswer } from './capture-assessment.mjs';

// All credentials and installed-state paths are supplied at runtime. This
// runner never registers a provider, refreshes a catalog, or retries inference.
for (const name of ['LLMGW_CAPTURE_GATEWAY', 'LLMGW_ADMIN_KEY_FILE', 'LLMGW_CAPTURE_MANIFEST', 'LLMGW_CAPTURE_DIR', 'LLMGW_CAPTURE_RESULT']) {
  assert.ok(process.env[name], `${name} must point to the existing local capture setup`);
}
const origin = process.env.LLMGW_CAPTURE_GATEWAY.replace(/\/$/, '');
assert.ok(/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin), 'capture only the existing loopback Gateway');
const adminKey = readFileSync(process.env.LLMGW_ADMIN_KEY_FILE, 'utf8').trim();
assert.ok(adminKey);
const manifest = JSON.parse(readFileSync(process.env.LLMGW_CAPTURE_MANIFEST, 'utf8'));
const recordsDir = resolve(process.env.LLMGW_CAPTURE_DIR), output = resolve(process.env.LLMGW_CAPTURE_RESULT);
assert.ok(existsSync(recordsDir) && existsSync(dirname(output)) && !existsSync(output), 'use existing private capture storage and a new result file');
const cases = manifest.cases;
const allowRetry = process.env.LLMGW_CAPTURE_ALLOW_RETRY === '1';
assert.ok(Array.isArray(cases) && cases.length > 0 && cases.length <= 30);
const limits = new Map();
for (const entry of cases) {
  assert.ok(/^[A-Za-z0-9._:-]{1,128}$/.test(entry.id) && entry.model?.startsWith(entry.provider + '/') && /^\/v1\//.test(entry.path));
  limits.set(entry.provider, (limits.get(entry.provider) ?? 0) + 1);
}
assert.ok([...limits.values()].every(count => count <= 10), 'the manifest must reserve no more than ten calls per provider');
assert.equal(new Set(cases.map(item => item.id)).size, cases.length, 'capture request IDs must be unique');

const request = async (path, method = 'GET', body, token = adminKey, id) => {
  const response = await fetch(origin + path, { method, headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(id ? { 'X-Request-ID': id } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90000) });
  const raw = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, body: raw, json: () => JSON.parse(raw.toString('utf8')) };
};
const state = (await request('/admin/api/state')).json();
const unavailable = new Set(cases.filter(item => !state.providers?.some(provider => provider.id === item.provider && !provider.disabled)).map(item => item.id));
if (process.argv.includes('--preflight')) {
  console.log(JSON.stringify({ configuredCases: cases.length - unavailable.size, unavailableCases: [...unavailable], perProvider: Object.fromEntries(limits), existingCaptureFiles: readdirSync(recordsDir).filter(file => file.endsWith('.json')).length }));
  process.exit(0);
}
const results = { boundary: 'Existing installed Gateway HTTP with configured real providers, at most ten upstream attempts each', cases: [], captureDirectory: recordsDir, image: '', cleanup: false };
const save = () => writeFileSync(output, JSON.stringify(results, null, 2) + '\n', { flag: existsSync(output) ? 'w' : 'wx', mode: 0o600 });
const captures = id => readdirSync(recordsDir).filter(file => file.endsWith('.json')).map(file => {
  try { return JSON.parse(readFileSync(join(recordsDir, file), 'utf8')); } catch { return null; }
}).filter(record => record?.request_id === id);
let keyID = '';
try {
  const healthy = await request('/health', 'GET', undefined, adminKey);
  assert.equal(healthy.status, 200);
  const project = await request('/admin/api/projects', 'POST', { slug: 'capture-' + randomBytes(6).toString('hex'), name: 'Controlled capture project' });
  assert.equal(project.status, 201, 'a disposable project must be created through the management API');
  const projectID = project.json().id;
  const issued = await request('/admin/api/keys', 'POST', { project_id: projectID, name: 'Bounded provider capture', allowed_providers: [...limits.keys()], allowed_models: cases.map(item => item.model), daily_requests: 30 });
  assert.equal(issued.status, 200);
  const caller = issued.json(); keyID = caller.key.id;
  for (const entry of cases) {
    const row = { id: entry.id, provider: entry.provider, route: entry.path, model: entry.model, pass: false };
    results.cases.push(row);
    try {
      if (unavailable.has(entry.id)) { row.result = 'provider_not_configured_or_disabled'; continue; }
      if (captures(entry.id).length && !allowRetry) { row.result = 'already_captured_never_replayed_live'; continue; }
      const already = captures(entry.id).length;
      const before = readdirSync(recordsDir).filter(file => file.endsWith('.json')).length;
      const body = { model: entry.model, ...entry.body };
      const response = await fetch(origin + entry.path, { method: 'POST', headers: { Authorization: 'Bearer ' + caller.token, 'Content-Type': 'application/json', 'X-Request-ID': entry.id, 'X-LLMGW-Compatibility': entry.compatibility }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
      const bytes = Buffer.from(await response.arrayBuffer());
      const answer = { status: response.status, headers: response.headers, body: bytes };
      const bodyFile = join(dirname(output), entry.id + '.' + basename(output, '.json') + '.gateway-response.body');
      writeFileSync(bodyFile, bytes, { flag: 'wx', mode: 0o600 });
      row.gatewayBody = bodyFile; row.answer = assessGatewayAnswer(entry, answer.status, answer.headers.get('content-type') ?? '', answer.body);
      for (let wait = 0; wait < 30 && captures(entry.id).length <= already; wait++) await new Promise(resolve => setTimeout(resolve, 100));
      const actual = captures(entry.id).slice(already);
      row.sourceAttempts = actual.map(record => ({ host: record.host, path: record.path, status: record.status, complete: record.complete, terminal: record.terminal_event ?? '', bytes: record.response_bytes, authForms: record.auth_forms ?? [], failure: record.failure ?? '' }));
      row.pass = row.answer.successfulAnswer && actual.length > 0 && actual.every(record => record.complete && !record.request_truncated && !record.response_truncated);
      row.result = row.pass ? 'successful_provider_wire_captured' : actual.length ? 'provider_wire_recorded_but_not_accepted' : 'no_provider_dispatch';
      row.newCaptureFiles = readdirSync(recordsDir).filter(file => file.endsWith('.json')).length - before;
    } catch (error) { row.result = error.name === 'TimeoutError' ? 'request_timed_out' : 'client_or_fixture_error'; }
    finally { save(); console.log(JSON.stringify({ case: entry.id, result: row.result, status: row.answer?.status, upstreamAttempts: row.sourceAttempts?.length ?? 0 })); }
  }
} finally {
  if (keyID) {
    try { const revoked = await fetch(origin + '/admin/api/keys?id=' + encodeURIComponent(keyID), { method: 'DELETE', headers: { Authorization: 'Bearer ' + adminKey }, signal: AbortSignal.timeout(10000) }); results.cleanup = revoked.ok; await revoked.text(); }
    catch { results.cleanup = false; }
  }
  save();
}
if (!results.cleanup || results.cases.some(row => !row.pass)) process.exitCode = 1;
