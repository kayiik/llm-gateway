import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { ensureOwnerFixture, ownerRequest } from '../qualification/owner-fixture.mjs';

const body = (model, label) => ({ model, messages: [{ role: 'user', content: 'routing:success' }], temperature: 0.125, max_tokens: 17, user: label });

export async function runOperationalMatrix({ admin, publicCall, request, metrics, save, registerSecret }) {
  const evidence = { boundary: 'Installed quota admission, target settlement, policy intersection and durable limit edits against controlled actual HTTP', pass: false, cases: [] };
  const test = async (name, run) => {
    const row = { name, pass: false }; evidence.cases.push(row);
    try { await run(row); row.pass = true; } catch (error) { row.error = error.message; }
    finally { save('operational-matrix.json', evidence); }
  };
  const calls = async () => (await metrics()).routing?.calls ?? [];
  let projectQuotaSeed;
  const provider = async (id, target = 'healthy') => {
    await admin('providers', { id, registry_id: 'openai', base_url: `http://upstream:18889/routing/${target}/v1`, api_key: 'fixture-routing-token' });
    await admin(`providers/${id}/refresh`, {});
  };
  const edit = async (id, usage_limits) => {
    const response = await fetch(process.env.REPLAY_ORIGIN + `/admin/api/providers/${id}/usage-limits`, {
      method: 'PATCH', headers: { Authorization: 'Bearer ' + process.env.REPLAY_ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ usage_limits }), signal: AbortSignal.timeout(5000),
    });
    const text = await response.text(); return { status: response.status, text, json: JSON.parse(text) };
  };
  const invoke = (name, model, token, extra = {}) => publicCall('ops-' + name, '/v1/chat/completions', { ...body(model, name), ...extra }, token);
  const noDispatch = async (name, model, token, statuses = [429]) => {
    const before = (await metrics()).inference; const response = await invoke(name, model, token);
    assert.ok(statuses.includes(response.status), `${name}: ${response.status} ${response.text}`);
    assert.equal((await metrics()).inference, before, `${name}: admission refusal dispatched upstream`); return response;
  };

  await test('limits-only-edit-is-validates-and-preserves-provider-settings', async row => {
    await provider('ops-edit'); const initial = (await admin('state')).providers.find(item => item.id === 'ops-edit'); assert.ok(initial);
    assert.equal((await edit('ops-edit', { rpm: -1 })).status, 400);
    assert.equal((await edit('ops-edit', { models: { '': { rpm: 1 } } })).status, 400);
    const saved = await edit('ops-edit', { rpm: 2, models: { fixture: { rpm: 1 } } }); assert.equal(saved.status, 200, saved.text);
    const current = (await admin('state')).providers.find(item => item.id === 'ops-edit');
    assert.equal(current.base_url, initial.base_url); assert.equal(current.credential_set, initial.credential_set);
    assert.equal(current.usage_limits.rpm, 2); assert.equal(current.usage_limits.models.fixture.rpm, 1);
    const clear = await edit('ops-edit', {}); assert.equal(clear.status, 200, clear.text);
    const cleared = (await admin('state')).providers.find(item => item.id === 'ops-edit'); assert.equal(cleared.usage_limits?.rpm ?? 0, 0);
    row.rejectedInvalidEdits = 2;
  });
  await test('exact-model-limit-rolls-back-provider-slot-and-clearing-restores-admission', async row => {
    await provider('ops-model'); assert.equal((await edit('ops-model', { rpm: 3, models: { fixture: { rpm: 1 } } })).status, 200);
    assert.equal((await invoke('model-first', 'ops-model/fixture')).status, 200);
    const refused = await noDispatch('model-second', 'ops-model/fixture'); assert.match(refused.text, /provider_model.*rpm|quota/i);
    assert.equal((await invoke('model-other', 'ops-model/routing-unique')).status, 200, 'rejected model must not consume the provider-wide slot');
    assert.equal((await edit('ops-model', {})).status, 200);
    assert.equal((await invoke('model-cleared', 'ops-model/fixture')).status, 200); row.dispatched = 3;
  });
  await test('provider-limit-falls-back-only-to-an-eligible-target-and-all-limited-refuses', async row => {
    for (const id of ['ops-first', 'ops-second']) { await provider(id); assert.equal((await edit(id, { rpm: 1 })).status, 200); }
    await admin('endpoints', { name: 'ops-limited-route', ingress: ['/v1/chat/completions'], failover: [{ provider: 'ops-first', model: 'fixture' }, { provider: 'ops-second', model: 'fixture' }] });
    const start = (await calls()).length;
    assert.equal((await invoke('route-first', 'ops-limited-route')).status, 200);
    assert.equal((await invoke('route-second', 'ops-limited-route')).status, 200);
    assert.deepEqual((await calls()).slice(start).map(call => call.target), ['healthy', 'healthy']);
    const refused = await noDispatch('route-exhausted', 'ops-limited-route', undefined, [429, 503]);
    row.upstreamCalls = (await calls()).length - start; row.refusal = refused.status;
  });
  await test('six-simultaneous-admissions-at-capacity-two-dispatch-exactly-twice', async row => {
    await provider('ops-concurrent', 'slow-answer'); assert.equal((await edit('ops-concurrent', { rpm: 2 })).status, 200);
    const start = (await calls()).length;
    const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => invoke('concurrent-' + index, 'ops-concurrent/fixture')));
    const statuses = responses.map(response => response.status); assert.equal(statuses.filter(status => status === 200).length, 2, JSON.stringify(statuses));
    assert.equal(statuses.filter(status => status === 429).length, 4, JSON.stringify(statuses));
    assert.equal((await calls()).length - start, 2, 'only admitted requests may reach the controlled provider');
    row.statuses = statuses; row.dispatches = 2;
  });
  await test('admitted-request-can-settle-above-token-threshold-before-next-refusal', async row => {
    await provider('ops-token'); assert.equal((await edit('ops-token', { daily_tokens: 1 })).status, 200);
    const start = (await calls()).length; const first = await invoke('token-first', 'ops-token/fixture'); assert.equal(first.status, 200, first.text);
    assert.equal(JSON.parse(first.text).usage.total_tokens, 5);
    const refused = await noDispatch('token-after-settlement', 'ops-token/fixture'); assert.match(refused.text, /daily_tokens|quota/i);
    assert.equal((await calls()).length - start, 1); row.admittedTokens = 5; row.threshold = 1;
  });
  await test('two-held-open-admissions-can-settle-above-one-token-with-no-third-dispatch', async row => {
    await provider('ops-inflight', 'slow-answer'); assert.equal((await edit('ops-inflight', { daily_tokens: 1 })).status, 200);
    const before = (await calls()).length;
    const responses = await Promise.all([invoke('inflight-a', 'ops-inflight/fixture'), invoke('inflight-b', 'ops-inflight/fixture')]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    assert.ok(responses.every(response => JSON.parse(response.text).usage.total_tokens === 5));
    assert.equal((await calls()).length - before, 2);
    const refused = await noDispatch('inflight-after-settlement', 'ops-inflight/fixture'); assert.match(refused.text, /daily_tokens|quota/i);
    row.admitted = 2; row.observedTokens = 10; row.threshold = 1;
  });
  await test('reported-token-overage-and-unknown-price-retain-distinct-budget-counters', async row => {
    await provider('ops-budget'); const project = await admin('projects', { slug: 'ops-budget-project', name: 'Installed budget project' });
    await admin(`projects/${project.id}/policy`, { daily_output_tokens: 1 });
    const key = await admin('keys', { project_id: project.id, name: 'Budget key', daily_input_tokens: 2, daily_cost_microusd: 1, daily_credits_milli: 1 });
    const before = (await calls()).length; const first = await invoke('budget-first', 'ops-budget/fixture', key.token); assert.equal(first.status, 200, first.text);
    assert.deepEqual(JSON.parse(first.text).usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    const keyLimits = (await admin(`keys/${key.key.id}/limits`)).limits;
    assert.ok(keyLimits.some(limit => limit.scope === 'key' && limit.field === 'daily_input_tokens' && limit.used === 3 && limit.limit === 2));
    assert.ok(keyLimits.some(limit => limit.scope === 'project' && limit.field === 'daily_output_tokens' && limit.used === 2 && limit.limit === 1));
    assert.ok(keyLimits.some(limit => limit.scope === 'key' && limit.field === 'daily_cost_microusd' && limit.used === 0), 'unknown price must not invent monetary cost');
    assert.ok(keyLimits.some(limit => limit.scope === 'key' && limit.field === 'daily_credits_milli' && limit.used === 1000), 'successful non-stub inference uses the distinct neutral model-credit');
    const denied = await noDispatch('budget-after-settlement', 'ops-budget/fixture', key.token); assert.match(denied.text, /input tokens\/day quota exceeded \(limit 2\)/);
    assert.equal((await calls()).length - before, 1); row.observed = { inputTokens: 3, outputTokens: 2, costMicroUSD: 0, creditsMilli: 1000 };
  });
  await test('project-and-key-quotas-aggregate-across-keys-without-consuming-invalid-selection', async row => {
    await provider('ops-project'); const project = await admin('projects', { slug: 'ops-quota-project', name: 'Installed quota project' });
    await admin(`projects/${project.id}/policy`, { daily_requests: 3 });
    const a = await admin('keys', { project_id: project.id, name: 'Quota key A', daily_requests: 2 });
    const b = await admin('keys', { project_id: project.id, name: 'Quota key B' });
    const start = (await calls()).length;
    const invalidBefore = (await calls()).length;
    const invalid = await request('/v1/completions', body('ops-project/fixture', 'invalid-wire'), a.token);
    assert.equal(invalid.status, 404, invalid.text);
    assert.equal((await calls()).length, invalidBefore, 'an absent wire cannot consume the project quota');
    for (let index = 0; index < 2; index++) assert.equal((await invoke('quota-a-' + index, 'ops-project/fixture', a.token)).status, 200);
    await noDispatch('quota-key-refusal', 'ops-project/fixture', a.token);
    assert.equal((await invoke('quota-b-0', 'ops-project/fixture', b.token)).status, 200);
    await noDispatch('quota-project-refusal', 'ops-project/fixture', b.token);
    const aLimits = (await admin(`keys/${a.key.id}/limits`)).limits;
    const bLimits = (await admin(`keys/${b.key.id}/limits`)).limits;
    assert.ok(aLimits.some(limit => limit.scope === 'key' && limit.field === 'daily_requests' && limit.used === 2 && limit.limit === 2));
    assert.ok(bLimits.some(limit => limit.scope === 'project' && limit.field === 'daily_requests' && limit.used === 3 && limit.limit === 3));
    assert.equal((await calls()).length - start, 3); row.admitted = 3; row.refusedWithoutDispatch = 3;
    projectQuotaSeed = { projectId: project.id, keyId: b.key.id, token: b.token };
  });
  await test('key-project-provider-model-policy-intersects-catalog-and-public-dispatch', async row => {
    await provider('ops-policy'); await provider('ops-policy-other', 'other');
    const project = await admin('projects', { slug: 'ops-policy-project', name: 'Installed policy project' });
    await admin(`projects/${project.id}/policy`, { allowed_providers: ['ops-policy'] });
    const key = await admin('keys', { project_id: project.id, name: 'Policy intersection key', allowed_providers: ['ops-policy', 'ops-policy-other'], allowed_models: ['ops-policy/fixture'] });
    const beforePrime = (await metrics()).inference;
    await admin('keys/update', { id: key.key.id, allowed_models: [] });
    try {
      const count = await request('/v1/messages/count_tokens', { model: 'fixture', messages: [{ role: 'user', content: 'prime the policy-scoped catalog' }] }, key.token);
      assert.equal(count.status, 200, count.text);
    } finally { await admin('keys/update', { id: key.key.id, allowed_models: key.key.policy.allowed_models }); }
    assert.equal((await metrics()).inference, beforePrime);
    const catalog = await request('/v1/models', undefined, key.token); assert.equal(catalog.status, 200);
    const ids = JSON.parse(catalog.text).data.map(item => item.id);
    assert.ok(ids.includes('ops-policy/fixture'), JSON.stringify({ ids, providerModels: await admin('providers/ops-policy/models', {}), projectPolicy: await admin(`projects/${project.id}/policy`), keyPolicy: key.key.policy }));
    assert.ok(!ids.some(id => id.startsWith('ops-policy-other/') || id === 'ops-policy/routing-unique'));
    await noDispatch('policy-wrong-provider', 'ops-policy-other/fixture', key.token, [403]);
    await noDispatch('policy-wrong-model', 'ops-policy/routing-unique', key.token, [403]);
    assert.equal((await invoke('policy-allowed', 'ops-policy/fixture', key.token)).status, 200); row.visibleModel = 'ops-policy/fixture';
  });
  await test('disabled-provider-stays-hidden-and-never-dispatches-on-public-surfaces', async row => {
    await provider('ops-disabled');
    const project = await admin('projects', { slug: 'ops-disabled-project', name: 'Disabled provider policy project' });
    await admin(`projects/${project.id}/policy`, { allowed_providers: ['ops-disabled'] });
    const key = await admin('keys', { project_id: project.id, name: 'Disabled provider caller', allowed_providers: ['ops-disabled'], allowed_models: ['ops-disabled/fixture'] });
    await admin('providers/ops-disabled/enabled', { enabled: false });
    const catalog = await request('/v1/models', undefined, key.token); assert.equal(catalog.status, 200);
    assert.ok(!JSON.parse(catalog.text).data.some(item => item.id.startsWith('ops-disabled/')));
    const before = (await metrics()).inference;
    const requests = [
      ['/v1/chat/completions', body('ops-disabled/fixture', 'disabled-chat')],
      ['/v1/responses', { model: 'ops-disabled/fixture', input: 'disabled responses' }],
      ['/v1/messages', { model: 'ops-disabled/fixture', max_tokens: 17, messages: [{ role: 'user', content: 'disabled messages' }] }],
      ['/v1/messages/count_tokens', { model: 'ops-disabled/fixture', messages: [{ role: 'user', content: 'disabled count' }] }],
      ['/v1/embeddings', { model: 'ops-disabled/fixture', input: 'disabled embedding' }],
      ['/v1/audio/speech', { model: 'ops-disabled/fixture', input: 'disabled speech', voice: 'fixture' }],
      ['/v1/images/generations', { model: 'ops-disabled/fixture', prompt: 'disabled image' }],
      ['/v1/videos/generations', { model: 'ops-disabled/fixture', prompt: 'disabled video' }],
    ];
    for (const [path, input] of requests) {
      const response = await request(path, input, key.token); assert.ok(response.status >= 400, path + ': ' + response.text);
      assert.equal((await metrics()).inference, before, path + ' must never dispatch a disabled target');
    }
    await admin('providers/ops-disabled/enabled', { enabled: true });
    const allowed = await invoke('disabled-reenabled', 'ops-disabled/fixture', key.token); assert.equal(allowed.status, 200, allowed.text);
    assert.equal((await metrics()).inference, before + 1); row.refusedOperations = requests.length; row.reenabled = true;
  });
  await test('owner-and-admin-limit-views-report-scope-window-reset-and-refusing-layer', async row => {
    const origin = process.env.REPLAY_ORIGIN, ssoSecret = process.env.REPLAY_SSO_SECRET;
    const seed = await ensureOwnerFixture({ origin, adminKey: process.env.REPLAY_ADMIN_KEY, ssoSecret });
    const project = await admin('projects', { slug: 'ops-owner-limit-view', name: 'Owner limit view project' });
    await admin('memberships', { project_id: project.id, principal_id: seed.actors.a.id, role: 'owner' });
    await admin(`projects/${project.id}/policy`, { daily_requests: 2 });
    const keyResponse = await ownerRequest({ origin, ssoSecret, actor: 'a', path: '/user/api/keys', body: { project_id: project.id, name: 'Owner limit view key', daily_requests: 1 }, registerSecret });
    assert.equal(keyResponse.status, 200, keyResponse.text); const key = keyResponse.json;
    const first = await invoke('owner-limit-first', 'iam-chat/fixture', key.token); assert.equal(first.status, 200, first.text);
    const mine = await ownerRequest({ origin, ssoSecret, actor: 'a', path: '/user/api/keys/' + key.key.id + '/limits' }); assert.equal(mine.status, 200, mine.text);
    const foreign = await ownerRequest({ origin, ssoSecret, actor: 'b', path: '/user/api/keys/' + key.key.id + '/limits' }); assert.equal(foreign.status, 404);
    const adminView = await admin(`keys/${key.key.id}/limits`); const projectView = await admin(`projects/${project.id}/limits`);
    assert.deepEqual(mine.json.limits, adminView.limits);
    assert.ok(mine.json.limits.some(limit => limit.scope === 'key' && limit.field === 'daily_requests' && limit.metric === 'requests' && limit.period === 'day' && limit.limit === 1 && limit.used === 1 && limit.closest === true && limit.resets_at > Date.now() / 1000));
    assert.ok(projectView.limits.some(limit => limit.scope === 'project' && limit.field === 'daily_requests' && limit.used === 1 && limit.limit === 2));
    const refusal = await noDispatch('owner-limit-refusal', 'iam-chat/fixture', key.token); assert.match(refusal.text, /requests\/day quota exceeded \(limit 1\)/);
    row.ownerRestricted = true; row.refusingLayer = 'key';
  });
  evidence.pass = evidence.cases.length === 11 && evidence.cases.every(row => row.pass);
  save('operational-matrix.json', evidence);
  assert.equal(evidence.pass, true, evidence.cases.filter(row => !row.pass).map(row => row.name + ': ' + row.error).join('\n'));
  writeFileSync('/artifacts/operational-seed-private.json', JSON.stringify({ projectQuotaSeed }, null, 2) + '\n', { mode: 0o600 });
}
