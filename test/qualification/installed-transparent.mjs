import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function runInstalledTransparentRecovery(mode) {
  assert.equal(mode, 'restart'); const root = process.env.REPLAY_ARTIFACTS ?? '/artifacts';
  const seed = JSON.parse(readFileSync(join(root, 'transparent-seed-private.json'), 'utf8'));
  const result = { mode, boundary: 'Synthetic catalog-confirmed native Responses transparency on a stopped disposable copy; no upstream vendor provenance claim', pass: false, cases: [] };
  const test = async (name, run) => { const row = { name, pass: false }; result.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = error.message; } };
  await test('confirmed-native-transparent-response-preserves-opaque-upstream-instructions', async row => {
    const metrics = async () => (await (await fetch('http://127.0.0.1:18889/metrics', { signal: AbortSignal.timeout(2000) })).json()).clients;
    const before = (await metrics())?.calls?.length ?? 0;
    const response = await fetch(process.env.REPLAY_ORIGIN + '/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.REPLAY_ADMIN_KEY, 'Content-Type': 'application/json', 'X-LLMGW-Transport-Mode': 'transparent', 'X-LLMGW-Compatibility': 'deny' }, body: JSON.stringify({ model: seed.provider + '/' + seed.model, input: 'opaque fixture', instructions: 'caller instructions', metadata: { fixture_instructions: 'upstream instructions' } }), signal: AbortSignal.timeout(10000) });
    const text = await response.text(); assert.equal(response.status, 200, text); assert.equal(response.headers.get('x-llmgw-transport-mode'), 'transparent');
    const payload = JSON.parse(text); assert.equal(payload.instructions, 'upstream instructions');
    assert.equal(payload.output[0].content[0].text, 'fixture-client-ok');
    assert.equal((await metrics()).calls.length - before, 1); row.nativeCalls = 1; row.originalInstructionsNotSubstituted = true;
  });
  result.pass = result.cases.length === 1 && result.cases.every(row => row.pass);
  writeFileSync(join(root, 'transparent-restart-results.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(result)); if (!result.pass) process.exitCode = 1;
  return result;
}
