import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

export async function runCallerRateMatrix({ admin, request, publicCall, metrics, save }) {
  const result = { boundary: 'Installed process-local caller ceiling is separate from persistent project requests and returns bounded Retry-After', pass: false, cases: [] };
  const test = async (name, run) => { const row = { name, pass: false }; result.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = error.message; } finally { save('caller-rate-matrix.json', result); } };
  await test('two-caller-admissions-refuse-the-third-with-retry-after-and-no-provider-io', async row => {
    assert.equal(Number(process.env.REPLAY_CALLER_RATE_LIMIT), 2);
    await admin('providers', { id: 'caller-rate-fixture', registry_id: 'openai', base_url: 'http://upstream:18889/routing/healthy/v1', api_key: 'fixture-routing-token' });
    await admin('providers/caller-rate-fixture/refresh', {});
    const project = await admin('projects', { slug: 'caller-rate-qualified', name: 'Isolated caller-rate project' });
    await admin(`projects/${project.id}/policy`, { daily_requests: 10 });
    const key = await admin('keys', { project_id: project.id, name: 'Isolated rate caller' });
    const untilNextMinute = 60000 - Date.now() % 60000;
    if (untilNextMinute < 20000) await new Promise(resolve => setTimeout(resolve, untilNextMinute + 100));
    const minute = Math.floor(Date.now() / 60000), before = (await metrics()).routing?.calls?.length ?? 0;
    const payload = { model: 'caller-rate-fixture/fixture', messages: [{ role: 'user', content: 'routing:success' }], temperature: 0.125, max_tokens: 17 };
    for (let index = 0; index < 2; index++) { const response = await publicCall('caller-rate-' + index, '/v1/chat/completions', payload, key.token); assert.equal(response.status, 200, response.text); }
    const denied = await request('/v1/chat/completions', payload, key.token);
    assert.equal(denied.status, 429, denied.text); assert.match(denied.text, /Rate limit exceeded: this gateway admits 2 requests per minute/);
    const retry = Number(denied.headers['retry-after']); assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 60, 'Retry-After must be bounded by the current UTC minute');
    assert.equal((await metrics()).routing.calls.length - before, 2, 'the refused caller cannot reach the source');
    const limits = (await admin(`keys/${key.key.id}/limits`)).limits;
    assert.ok(limits.some(limit => limit.scope === 'caller' && limit.field === 'rate_limit_per_minute' && limit.used === 2 && limit.limit === 2));
    assert.ok(limits.some(limit => limit.scope === 'project' && limit.field === 'daily_requests' && limit.used === 2 && limit.limit === 10));
    assert.equal(Math.floor(Date.now() / 60000), minute, 'the admitted and refused requests must share the same UTC minute');
    writeFileSync('/artifacts/caller-rate-seed-private.json', JSON.stringify({ keyId: key.key.id, token: key.token, minute, projectId: project.id }) + '\n', { mode: 0o600 });
    row.dispatched = 2; row.refused = 1; row.retryAfterSeconds = retry;
  });
  result.pass = result.cases.length === 1 && result.cases.every(row => row.pass); save('caller-rate-matrix.json', result);
  assert.equal(result.pass, true, result.cases.filter(row => !row.pass).map(row => row.error).join('\n'));
}
