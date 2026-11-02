import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

export async function runTransparentMatrix({ admin, metrics, save }) {
  const result = { boundary: 'Installed transparent mode refuses unconfirmed native evidence, compatibility allowance, streaming and non-exact selectors before I/O', pass: false, cases: [] };
  const test = async (name, run) => { const row = { name, pass: false }; result.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = error.message; } finally { save('transparent-matrix.json', result); } };
  await test('transparent-refuses-unconfirmed-allow-stream-and-alias-before-provider-io', async row => {
    await admin('providers', { id: 'transport-confirmed', registry_id: 'openai', base_url: 'http://upstream:18889/clients/openai/v1', api_key: 'fixture-client-upstream-key' });
    await admin('providers/transport-confirmed/refresh', {});
    const catalog = await admin('providers/transport-confirmed/catalog');
    const declaration = catalog.models.find(model => model.id === 'fixture-client-responses');
    row.declaration = { surfaces: declaration?.supported_endpoints, wire: declaration?.wire_preservation, provenance: declaration?.capabilities?.provenance, streaming: declaration?.capabilities?.streaming };
    await admin('providers', { id: 'transport-unknown', registry_id: 'openai', base_url: 'http://upstream:18889/routing/unknown-catalog/v1', api_key: 'fixture-routing-token' });
    await admin('providers/transport-unknown/refresh', {});
    const origin = process.env.REPLAY_ORIGIN, token = process.env.REPLAY_ADMIN_KEY;
    const body = { model: 'transport-confirmed/fixture-client-responses', input: 'opaque fixture', instructions: 'caller instructions', metadata: { fixture_instructions: 'upstream instructions' } };
    const invoke = async (value, compatibility = 'deny') => {
      const response = await fetch(origin + '/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-LLMGW-Transport-Mode': 'transparent', 'X-LLMGW-Compatibility': compatibility }, body: JSON.stringify(value), signal: AbortSignal.timeout(10000) });
      return { status: response.status, mode: response.headers.get('x-llmgw-transport-mode'), body: await response.json() };
    };
    const before = (await metrics()).clients?.calls?.length ?? 0;
    for (const [value, compatibility] of [[body, 'deny'], [body, 'allow'], [{ ...body, stream: true }, 'deny'], [{ ...body, model: 'fixture-client-responses' }, 'deny']]) {
      const refused = await invoke(value, compatibility); assert.ok(refused.status >= 400, JSON.stringify(refused));
      assert.equal((await metrics()).clients?.calls?.length ?? 0, before, 'unconfirmed transparent requirements must not dispatch');
    }
    const unknownBefore = (await metrics()).routing?.calls?.filter(call => call.target === 'unknown-catalog').length ?? 0;
    const unknown = await invoke({ model: 'transport-unknown/fixture', input: 'unconfirmed transport' });
    assert.ok(unknown.status >= 400, JSON.stringify(unknown));
    assert.equal((await metrics()).routing?.calls?.filter(call => call.target === 'unknown-catalog').length ?? 0, unknownBefore);
    row.nativeDispatches = 0; row.preIODenials = 5;
  });
  result.pass = result.cases.length === 1 && result.cases.every(row => row.pass); save('transparent-matrix.json', result);
  assert.equal(result.pass, true, result.cases.filter(row => !row.pass).map(row => row.error).join('\n'));
  writeFileSync('/artifacts/transparent-seed-private.json', JSON.stringify({ provider: 'transport-confirmed', model: 'fixture-client-responses' }) + '\n', { mode: 0o600 });
}
