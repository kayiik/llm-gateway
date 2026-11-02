import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mediaMP4 } from '../integration/media-fixture.mjs';

export async function runInstalledMediaRecovery(mode) {
  assert.equal(mode, 'restart');
  const root = process.env.REPLAY_ARTIFACTS ?? '/artifacts';
  const seed = JSON.parse(readFileSync(join(root, 'media-seed-private.json'), 'utf8'));
  const result = { boundary: 'Installed restart with the original caller key and opaque video handles; no new generation', mode, pass: false, cases: [] };
  const metrics = async () => (await fetch('http://upstream:18889/metrics', { signal: AbortSignal.timeout(2000) })).json();
  const before = (await metrics()).media.calls;
  for (const kind of ['inline', 'download']) {
    const row = { name: 'video-' + kind + '-operation-survives-restart', pass: false }; result.cases.push(row);
    try {
      const start = (await metrics()).media.calls.length;
      const response = await fetch(process.env.REPLAY_ORIGIN + '/v1/videos/generations', {
        method: 'POST', headers: { Authorization: 'Bearer ' + seed.caller.token, 'Content-Type': 'application/json', 'X-Request-ID': 'media-recovery-' + kind },
        body: JSON.stringify({ model: 'media-video-route', operation: seed[kind + 'Job'].operation }), signal: AbortSignal.timeout(10000),
      });
      const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.status, 'completed'); assert.equal(body.provider, 'media-studio');
      assert.equal(body.operation, seed[kind + 'Job'].operation); assert.deepEqual(Buffer.from(body.video_base64, 'base64'), mediaMP4);
      const actual = (await metrics()).media.calls.slice(start);
      assert.deepEqual(actual.map(item => item.kind), kind === 'inline' ? ['video-poll'] : ['video-poll', 'file']);
      row.pass = true;
    } catch (error) { row.error = error.message.replaceAll(seed.caller.token, '[temporary-key]'); }
  }
  const after = (await metrics()).media.calls;
  assert.equal(after.filter(item => item.kind === 'video-start').length, before.filter(item => item.kind === 'video-start').length, 'recovery must not start another provider generation');
  result.pass = result.cases.length === 2 && result.cases.every(row => row.pass);
  writeFileSync(join(root, 'media-restart-results.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result)); if (!result.pass) process.exitCode = 1;
  return result;
}
