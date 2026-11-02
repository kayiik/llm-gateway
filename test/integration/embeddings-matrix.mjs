import assert from 'node:assert/strict';

const samples = {
  single: { input: 'Qualification embedding one.', vectors: [[0.125, -0.5, 0.75]], tokens: 7 },
  batch: { input: ['Qualification embedding one.', 'Qualification embedding two.'], vectors: [[0.125, -0.5, 0.75], [-0.25, 0.625, 0.5]], tokens: 11 },
  zero: { input: 'Qualification reported-zero embedding.', vectors: [[0.5, 0, -0.25]], tokens: 0 },
  absent: { input: 'Qualification unreported-usage embedding.', vectors: [[-0.5, 0.25, 0]], tokens: null },
};

export function embeddingRequest(sample, model = 'fixture-embedding') {
  assert.ok(samples[sample], 'known embedding sample required');
  return { model, input: structuredClone(samples[sample].input), encoding_format: 'float', dimensions: 3, user: 'qualification-embedding-user' };
}

export function embeddingReply(body) {
  const sample = Object.keys(samples).find(name => JSON.stringify(samples[name].input) === JSON.stringify(body.input));
  assert.ok(sample, 'embedding input must match a declared sample');
  assert.deepEqual(body, embeddingRequest(sample), 'the selected model, input and native options must survive');
  const { vectors, tokens } = samples[sample];
  return {
    object: 'list', model: 'fixture-embedding',
    data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
    ...(tokens === null ? {} : { usage: { prompt_tokens: tokens, total_tokens: tokens } }),
  };
}

export async function runEmbeddingsMatrix({ admin, publicCall, metrics, save }) {
  const evidence = { boundary: 'Installed Gateway embeddings HTTP, caller policy, selected target and durable accounting', pass: false, cases: [] };
  const expectedRows = [];
  const providers = ['primary', 'secondary', 'ineligible', 'unavailable', 'siliconflow'];
  const providerId = target => 'embedding-' + target;
  const direct = providerId('primary') + '/fixture-embedding';
  const firstRoute = 'embedding-first-eligible';
  const filteredRoute = 'embedding-policy-filtered';
  const ids = providers.map(providerId);
  const beforeMatrix = (await metrics()).inference;
  async function test(name, run) {
    const row = { name, pass: false };
    evidence.cases.push(row);
    try { await run(row); row.pass = true; }
    catch (error) { row.error = error.message; }
    finally { save('embeddings-matrix.json', evidence); }
  }
  const counts = async () => (await metrics()).embeddings ?? {};
  async function refused(name, body, token, status) {
    const before = await metrics();
    const response = await publicCall('embedding-' + name, '/v1/embeddings', body, token);
    assert.equal(response.status, status, response.text);
    assert.ok(JSON.parse(response.text).error, 'refusal must have a public error envelope');
    const after = await metrics();
    assert.equal(after.inference, before.inference, 'local refusal must precede upstream dispatch');
    assert.deepEqual(after.embeddings, before.embeddings, 'no embedding target may receive a refused request');
    return { status: response.status, upstreamCalls: 0 };
  }
  async function complete(name, sample, model, caller, target = 'primary') {
    const before = await metrics();
    const body = embeddingRequest(sample, model);
    const response = await publicCall('embedding-' + name, '/v1/embeddings', body, caller.token);
    assert.equal(response.status, 200, response.text);
    assert.match(response.contentType, /application\/json/);
    assert.deepEqual(JSON.parse(response.text), embeddingReply(embeddingRequest(sample)));
    const after = await metrics();
    assert.equal(after.inference, before.inference + 1, 'one embedding request must make exactly one upstream call');
    assert.equal(after.embeddings[target].accepted, (before.embeddings?.[target]?.accepted ?? 0) + 1);
    for (const other of providers.filter(item => item !== target)) assert.deepEqual(after.embeddings[other], before.embeddings?.[other], 'another embedding space must not be used');
    expectedRows.push({ name, response, model, sample, target, key: caller.key });
    return { status: response.status, upstreamCalls: 1, target: providerId(target), inputTokens: samples[sample].tokens };
  }
  async function key(name, scope = {}, project) {
    return admin('keys', { project_id: project?.id ?? mainProject.id, name: 'Embedding ' + name, ...scope });
  }
  for (const target of providers) {
    const id = providerId(target);
    await admin('providers', { id, registry_id: target === 'siliconflow' ? 'siliconflow' : 'openai', base_url: `http://upstream:18889/embedding-matrix/${target}/v1`, api_key: 'fixture-embedding-token' });
    await admin(`providers/${id}/refresh`, {});
  }
  const route = (name, targets, ingress = ['/v1/embeddings']) => admin('endpoints', { name, ingress, failover: targets.map(target => ({ provider: providerId(target), model: target === 'ineligible' ? 'fixture-chat' : 'fixture-embedding' })) });
  await route(firstRoute, ['primary', 'secondary']);
  await route(filteredRoute, ['secondary', 'primary']);
  await route('embedding-no-failover', ['unavailable', 'secondary']);
  await route('embedding-wrong-ingress', ['primary'], ['/v1/chat/completions']);
  const mainProject = await admin('projects', { slug: 'embedding-matrix', name: 'Embedding matrix' });
  await admin(`projects/${mainProject.id}/policy`, { allowed_providers: ids });
  const caller = await key('standard', { allowed_providers: ids });

  await test('mixed-operation-route-refused', async row => {
    const before = await metrics();
    const response = await publicCall('embedding-mixed-operation-route', '/admin/api/endpoints', {
      name: 'embedding-mixed-operations', ingress: ['/v1/embeddings'],
      failover: [{ provider: providerId('ineligible'), model: 'fixture-chat' }, { provider: providerId('primary'), model: 'fixture-embedding' }],
    });
    assert.equal(response.status, 400, response.text);
    assert.match(response.text, /incompatible/);
    assert.equal((await metrics()).inference, before.inference, 'invalid route creation must not invoke a provider');
    Object.assign(row, { status: response.status, upstreamCalls: 0 });
  });
  for (const [name, input] of [['missing', undefined], ['null', null], ['empty', ''], ['blank', '   '], ['empty-array', []]]) {
    await test('invalid-input-' + name, async row => {
      const body = { model: direct, ...(input === undefined ? {} : { input }) };
      Object.assign(row, await refused('invalid-input-' + name, body, caller.token, 400));
    });
  }
  await test('missing-model', async row => { Object.assign(row, await refused('missing-model', { input: 'Qualification embedding one.' }, caller.token, 400)); });
  await test('unknown-target', async row => { Object.assign(row, await refused('unknown-target', embeddingRequest('single', 'missing-embedding-provider/fixture-embedding'), caller.token, 404)); });
  for (const [name, token] of [['missing-auth', ''], ['invalid-auth', 'fixture-invalid-embedding-key']]) {
    await test(name, async row => { Object.assign(row, await refused(name, embeddingRequest('single', direct), token, 401)); });
  }
  await test('key-model-policy', async row => {
    const restricted = await key('model excluded', { allowed_models: [providerId('primary') + '/another-model'] });
    Object.assign(row, await refused('key-model-policy', embeddingRequest('single', direct), restricted.token, 403));
  });
  await test('key-provider-policy', async row => {
    const restricted = await key('provider excluded', { allowed_providers: [providerId('secondary')] });
    Object.assign(row, await refused('key-provider-policy', embeddingRequest('single', direct), restricted.token, 403));
  });
  await test('project-provider-policy', async row => {
    const project = await admin('projects', { slug: 'embedding-project-policy', name: 'Embedding project policy' });
    await admin(`projects/${project.id}/policy`, { allowed_providers: [providerId('secondary')] });
    const restricted = await key('project provider excluded', {}, project);
    Object.assign(row, await refused('project-provider-policy', embeddingRequest('single', direct), restricted.token, 403));
  });
  const routed = await key('routes only', { allowed_routes: [firstRoute], routes_only: true, allowed_providers: ids });
  await test('routes-only-hides-direct-selector', async row => { Object.assign(row, await refused('routes-only-direct', embeddingRequest('single', direct), routed.token, 404)); });
  await test('route-scope-hides-other-route', async row => { Object.assign(row, await refused('route-scope', embeddingRequest('single', filteredRoute), routed.token, 404)); });
  await test('route-ingress-refusal', async row => { Object.assign(row, await refused('route-ingress', embeddingRequest('single', 'embedding-wrong-ingress'), caller.token, 400)); });

  for (const sample of Object.keys(samples)) await test('native-' + sample, async row => { Object.assign(row, await complete('native-' + sample, sample, direct, caller)); });
  await test('siliconflow-compatible-single-vector', async row => { Object.assign(row, await complete('siliconflow-single', 'single', providerId('siliconflow') + '/fixture-embedding', caller, 'siliconflow')); });
  await test('route-selects-first-eligible-member', async row => { Object.assign(row, await complete('first-eligible', 'batch', firstRoute, routed)); });
  await test('route-filters-provider-policy', async row => {
    const filtered = await key('filtered route', { allowed_routes: [filteredRoute], routes_only: true, allowed_providers: [providerId('primary')] });
    Object.assign(row, await complete('policy-filtered', 'single', filteredRoute, filtered));
  });
  await test('selected-upstream-failure-never-fails-over', async row => {
    const before = await metrics();
    const response = await publicCall('embedding-no-failover', '/v1/embeddings', embeddingRequest('single', 'embedding-no-failover'), caller.token);
    assert.equal(response.status, 503, response.text);
    assert.equal(JSON.parse(response.text).error.type, 'api_error', 'upstream failure must retain the sanitized public error shape');
    const after = await metrics();
    assert.equal(after.inference, before.inference + 1, 'selected embedding failure must not retry');
    assert.equal(after.embeddings.unavailable.accepted, (before.embeddings?.unavailable?.accepted ?? 0) + 1);
    assert.deepEqual(after.embeddings.secondary, before.embeddings?.secondary, 'a failed embedding must not switch vector spaces');
    expectedRows.push({ name: 'no-failover', response, model: 'embedding-no-failover', target: 'unavailable', key: caller.key, status: 503 });
    Object.assign(row, { status: response.status, upstreamCalls: 1, target: providerId('unavailable') });
  });
  await test('key-request-quota', async row => {
    const limited = await key('one request', { daily_requests: 1, allowed_providers: [providerId('primary')] });
    await complete('key-quota-first', 'single', direct, limited);
    Object.assign(row, await refused('key-quota-second', embeddingRequest('single', direct), limited.token, 429));
    row.refusedUpstreamCalls = row.upstreamCalls; row.upstreamCalls = 1;
    const limits = (await admin(`keys/${limited.key.id}/limits`)).limits;
    assert.ok(limits.some(limit => limit.scope === 'key' && limit.field === 'daily_requests' && limit.limit === 1 && limit.used === 1), 'one admitted request must consume exactly one key quota unit');
  });
  await test('project-request-quota-across-keys', async row => {
    const project = await admin('projects', { slug: 'embedding-project-quota', name: 'Embedding project quota' });
    await admin(`projects/${project.id}/policy`, { allowed_providers: [providerId('primary')], daily_requests: 1 });
    const first = await key('project first', {}, project);
    const second = await key('project second', {}, project);
    await complete('project-quota-first', 'single', direct, first);
    Object.assign(row, await refused('project-quota-second', embeddingRequest('single', direct), second.token, 429));
    row.refusedUpstreamCalls = row.upstreamCalls; row.upstreamCalls = 1;
    for (const identity of [first, second]) {
      const limits = (await admin(`keys/${identity.key.id}/limits`)).limits;
      assert.ok(limits.some(limit => limit.scope === 'project' && limit.field === 'daily_requests' && limit.limit === 1 && limit.used === 1), 'both keys must see the same single project quota unit');
    }
  });
  await test('correlated-selected-target-and-usage-ledger', async row => {
    let rows;
    for (let attempt = 0; attempt < 40; attempt++) {
      const value = await admin('requests?limit=500');
      rows = Array.isArray(value) ? value : (value.requests ?? value.rows ?? []);
      if (expectedRows.every(item => rows.some(entry => entry.request_id === item.response.requestId))) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    for (const expected of expectedRows) {
      const matched = rows.filter(entry => entry.request_id === expected.response.requestId);
      assert.equal(matched.length, 1, expected.name + ': exactly one correlated usage row');
      const actual = matched[0];
      assert.equal(actual.endpoint, 'openai.embeddings', expected.name);
      assert.equal(actual.status_code, expected.status ?? 200, expected.name);
      assert.equal(actual.requested_model, expected.model, expected.name + ': original public selector must remain attributable');
      assert.equal(actual.provider, providerId(expected.target), expected.name);
      assert.equal(actual.routed_model, 'fixture-embedding', expected.name);
      for (const field of ['project_id', 'principal_id']) assert.equal(actual[field], expected.key[field], expected.name);
      assert.equal(actual.key_id, expected.key.id, expected.name);
      assert.equal(actual.input_tokens, samples[expected.sample]?.tokens ?? 0, expected.name);
      assert.equal(actual.output_tokens, 0, 'embedding vectors do not generate output tokens');
    }
    row.rows = expectedRows.length;
    row.reportedZeroAndAbsentUsage = true;
  });
  await test('exact-target-dispatch-budget', async row => {
    evidence.upstreamCalls = (await metrics()).inference - beforeMatrix;
    evidence.targets = await counts();
    assert.equal(evidence.upstreamCalls, 10, 'nine successes and one selected upstream failure require exactly ten dispatches');
    assert.deepEqual(evidence.targets, {
      primary: { attempts: 8, accepted: 8, rejected: 0 },
      siliconflow: { attempts: 1, accepted: 1, rejected: 0 },
      unavailable: { attempts: 1, accepted: 1, rejected: 0 },
    }, 'secondary/ineligible providers must never receive inference, and no request may retry');
    row.upstreamCalls = evidence.upstreamCalls;
  });
  assert.equal(evidence.cases.length, 28, 'the declared embedding matrix must execute completely');
  evidence.pass = evidence.cases.every(row => row.pass);
  save('embeddings-matrix.json', evidence);
  assert.equal(evidence.pass, true, evidence.cases.filter(row => !row.pass).map(row => row.name + ': ' + row.error).join('\n'));
}
