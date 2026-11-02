import assert from 'node:assert/strict';

const input = (model, extra = {}) => ({ model, messages: [{ role: 'user', content: 'routing:fail' }], temperature: 0.125, max_tokens: 17, ...extra });
const leaf = (provider, model = 'fixture') => ({ provider: 'routing-' + provider, model });

export async function runRoutingMatrix({ admin, publicCall, request, metrics, save }) {
  const evidence = { boundary: 'Installed Gateway routing, admission, actual target attempts and open/cancel boundaries', pass: false, cases: [] };
  const test = async (name, run) => {
    const row = { name, pass: false }; evidence.cases.push(row);
    try { await run(row); row.pass = true; } catch (error) { row.error = error.message; }
    finally { save('routing-matrix.json', evidence); }
  };
  const calls = async () => (await metrics()).routing?.calls ?? [];
  const start = (await calls()).length;
  let composedRequest;
  const route = (name, failover, extra = {}) => admin('endpoints', { name, ingress: ['/v1/chat/completions'], failover, ...extra });
  async function invoke(name, model, want, extra = {}, token) {
    const before = (await calls()).length;
    const result = await publicCall('routing-' + name, '/v1/chat/completions', input(model, extra), token);
    assert.equal(result.status, 200, result.text);
    const body = JSON.parse(result.text);
    assert.equal(body.choices[0].message.content, `served:${want.target}:${want.model ?? 'fixture'}`);
    assert.deepEqual(body.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    return { response: result, attempts: (await calls()).slice(before) };
  }
  async function noDispatch(name, model, status, token) {
    const before = (await metrics()).inference;
    const result = await publicCall('routing-' + name, '/v1/chat/completions', input(model), token);
    assert.equal(result.status, status, result.text);
    assert.equal((await metrics()).inference, before, 'refused selection must never dispatch another target');
  }
  const targets = ['healthy', 'other', 'credit-compose', 'shape-compose', 'credit-repeat', 'credit-scopes', 'shape-repeat', 'shape-affinity-a', 'shape-affinity-b', 'unknown-catalog', 'changing-catalog', 'transient-retry', 'long-retry-cap', 'slow-answer', 'slow-fail', 'slow-open', 'opened-slow', 'opened-broken', 'cancel-stream'];
  for (const target of targets) {
    await admin('providers', { id: 'routing-' + target, registry_id: 'openai', base_url: `http://upstream:18889/routing/${target}/v1`, api_key: 'fixture-routing-token' });
    await admin(`providers/routing-${target}/refresh`, {});
  }
  await route('routing-child', [leaf('credit-compose'), leaf('shape-compose')]);
  await route('routing-composed', [{ route: 'routing-child' }, { route: 'routing-child' }, leaf('healthy')]);
  await route('routing-transient', [leaf('transient-retry'), leaf('healthy')]);
  await route('routing-long-retry', [leaf('long-retry-cap'), leaf('healthy')]);
  for (const target of ['slow-answer', 'slow-fail', 'slow-open', 'opened-slow', 'opened-broken', 'cancel-stream']) await route('routing-' + target + '-route', [leaf(target), leaf('healthy')]);
  await route('routing-affinity', [leaf('healthy'), leaf('other')]);
  const project = await admin('projects', { slug: 'routing-matrix', name: 'Routing matrix' });
  const caller = await admin('keys', { project_id: project.id, name: 'Routing matrix caller' });

  await test('exact-selector-preserves-vendor-namespace', async row => {
    const result = await invoke('exact', 'routing-healthy/vendor/native-model', { target: 'healthy', model: 'vendor/native-model' });
    assert.deepEqual(result.attempts.map(item => [item.target, item.model]), [['healthy', 'vendor/native-model']]); row.attempts = result.attempts;
  });
  await test('unique-alias-roundtrip-and-route-precedence', async row => {
    const result = await invoke('unique-alias', 'routing-unique', { target: 'healthy', model: 'routing-unique' });
    assert.equal(result.attempts.length, 1);
    await route('routing-unique', [leaf('other')]);
    const precedence = await invoke('route-precedence', 'routing-unique', { target: 'other' });
    assert.equal(precedence.attempts.length, 1); row.aliasThenRoute = true;
  });
  await test('unknown-and-ambiguous-alias-refuse-without-substitution', async () => {
    await noDispatch('unknown', 'routing-nonexistent-selector', 404);
    await noDispatch('ambiguous', 'shared-routing-alias', 404);
  });
  await test('caller-and-project-scope-filter-aliases-and-catalog', async row => {
    const restricted = await admin('keys', { project_id: project.id, name: 'Routing scoped alias', allowed_providers: ['routing-healthy'] });
    const result = await invoke('scoped-alias', 'shared-routing-alias', { target: 'healthy', model: 'shared-routing-alias' }, {}, restricted.token);
    assert.equal(result.attempts.length, 1);
    const catalog = await request('/v1/models', undefined, restricted.token);
    assert.equal(catalog.status, 200);
    const ids = JSON.parse(catalog.text).data.map(item => item.id);
    assert.ok(ids.includes('routing-healthy/shared-routing-alias'));
    assert.ok(!ids.some(id => id.startsWith('routing-other/')));
    const limitedProject = await admin('projects', { slug: 'routing-project-scope', name: 'Routing project scope' });
    await admin(`projects/${limitedProject.id}/policy`, { allowed_providers: ['routing-other'] });
    const projectKey = await admin('keys', { project_id: limitedProject.id, name: 'Routing project filtered alias' });
    const projectCall = await invoke('project-alias', 'shared-routing-alias', { target: 'other', model: 'shared-routing-alias' }, {}, projectKey.token);
    assert.equal(projectCall.attempts.length, 1); row.filteredCatalogAndDispatch = true;
  });
  await test('composed-routes-preserve-depth-first-order-and-duplicate-leaves', async row => {
    const result = await invoke('composed', 'routing-composed', { target: 'healthy' }, {}, caller.token);
    assert.deepEqual(result.attempts.map(item => item.target), ['credit-compose', 'shape-compose', 'credit-compose', 'shape-compose', 'healthy']);
    composedRequest = result.response.requestId;
    row.attempts = result.attempts;
  });
  await test('invalid-route-graphs-and-deletion-are-atomic', async row => {
    const before = (await admin('state')).endpoints;
    const invalid = [
      { name: 'routing-invalid-missing', failover: [{ route: 'routing-missing-child' }] },
      { name: 'routing-invalid-self', failover: [{ route: 'ROUTING-INVALID-SELF' }] },
      { name: 'routing-child', failover: [{ route: 'routing-composed' }] },
      { name: 'routing-invalid-mixed', failover: [{ route: 'routing-child', provider: 'routing-healthy', model: 'fixture' }] },
      { name: 'ROUTING-CHILD', failover: [leaf('healthy')] },
    ];
    for (let index = 0; index < invalid.length; index++) {
      const result = await publicCall('routing-invalid-graph-' + index, '/admin/api/endpoints', invalid[index]);
      assert.equal(result.status, 400, result.text);
      assert.deepEqual((await admin('state')).endpoints, before, 'invalid route save must not partly mutate configuration');
    }
    const removed = await fetch(process.env.REPLAY_ORIGIN + '/admin/api/endpoints/routing-child', { method: 'DELETE', headers: { Authorization: 'Bearer ' + process.env.REPLAY_ADMIN_KEY }, signal: AbortSignal.timeout(5000) });
    assert.equal(removed.status, 409, await removed.text());
    assert.deepEqual((await admin('state')).endpoints, before, 'a referenced route must remain intact');
    row.refusals = invalid.length + 1;
  });
  await test('route-expansion-leaf-and-depth-bounds-refuse-atomically', async row => {
    const remove = async name => {
      const response = await fetch(process.env.REPLAY_ORIGIN + '/admin/api/endpoints/' + name, { method: 'DELETE', headers: { Authorization: 'Bearer ' + process.env.REPLAY_ADMIN_KEY }, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200, await response.text());
    };
    for (const [kind, maximum] of [['leaves', 12], ['depth', 127]]) {
      const names = [];
      try {
        for (let index = 0; index <= maximum; index++) {
          const name = `routing-bound-${kind}-${index}`;
          const member = index === 0 ? leaf('healthy') : { route: names.at(-1) };
          await route(name, kind === 'leaves' && index > 0 ? [member, member] : [member]); names.push(name);
        }
        const before = (await admin('state')).endpoints;
        const member = { route: names.at(-1) };
        const response = await publicCall('routing-bound-' + kind, '/admin/api/endpoints', { name: 'routing-bound-' + kind + '-rejected', failover: kind === 'leaves' ? [member, member] : [member] });
        assert.equal(response.status, 400, response.text);
        assert.deepEqual((await admin('state')).endpoints, before, 'oversized expansion must not partly mutate the route graph');
      } finally { for (const name of names.reverse()) await remove(name); }
    }
    row.maximumLeaves = 4096; row.maximumEdges = 127;
  });
  await test('only-outer-route-policy-and-grants-govern-references', async row => {
    await route('routing-policy-child', [leaf('healthy')], { allow_adaptation: true });
    await route('routing-policy-denied', [{ route: 'routing-policy-child' }], { ingress: ['/v1/chat/completions'], allow_adaptation: false });
    const denied = await admin('keys', { project_id: project.id, name: 'Routing denied outer policy', allowed_routes: ['routing-policy-denied'], routes_only: true, allowed_providers: ['routing-healthy'] });
    const body = { model: 'routing-policy-denied', messages: [{ role: 'user', content: 'routing:fail' }], max_tokens: 17, temperature: 0.125 };
    const before = (await calls()).length;
    const refused = await publicCall('routing-outer-policy-denied', '/v1/messages', body, denied.token, 'allow');
    assert.equal(refused.status, 400, refused.text); assert.match(refused.text, /not declared/);
    assert.equal((await calls()).length, before, 'child permission or request headers cannot broaden the outer route');
    await route('routing-policy-child', [leaf('healthy')], { allow_adaptation: false });
    await route('routing-policy-allowed', [{ route: 'routing-policy-child' }], { ingress: ['/v1/messages'], allow_adaptation: true });
    const allowed = await admin('keys', { project_id: project.id, name: 'Routing allowed outer policy', allowed_routes: ['routing-policy-allowed'], routes_only: true, allowed_providers: ['routing-healthy'] });
    const answer = await publicCall('routing-outer-policy-allowed', '/v1/messages', { ...body, model: 'routing-policy-allowed' }, allowed.token, '');
    assert.equal(answer.status, 200, answer.text);
    const payload = JSON.parse(answer.text);
    assert.equal(payload.content.filter(part => part.type === 'text').map(part => part.text).join(''), 'served:healthy:fixture');
    assert.equal((await calls()).length, before + 1, 'references add no extra invocation layer');
    await noDispatch('child-not-granted', 'routing-policy-child', 404, allowed.token);
    row.outerPolicyAndRouteGrant = true;
  });
  await test('reference-telemetry-records-original-route-and-each-actual-attempt', async row => {
    assert.ok(composedRequest, 'the composed-route invocation must have completed');
    let entries = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      const value = await admin('requests?request_id=' + encodeURIComponent(composedRequest));
      entries = Array.isArray(value) ? value : (value.requests ?? value.rows ?? []);
      if (entries.length) break; await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(entries.length, 1);
    const entry = entries[0]; assert.equal(entry.requested_model, 'routing-composed'); assert.equal(entry.provider, 'routing-healthy');
    assert.equal(entry.source_usage.selected_attempt, 4);
    assert.deepEqual(entry.source_usage.attempts.map(item => item.provider), ['routing-credit-compose', 'routing-shape-compose', 'routing-credit-compose', 'routing-shape-compose', 'routing-healthy']);
    row.actualAttempts = entry.source_usage.attempts.length;
  });
  await test('positive-only-catalog-endpoints-never-invent-chat-denials', async row => {
    const unknown = await invoke('unknown-capabilities', 'routing-unknown-catalog/fixture', { target: 'unknown-catalog' });
    assert.equal(unknown.attempts.length, 1);
    await route('routing-changed-catalog', [leaf('changing-catalog'), leaf('healthy')]);
    const changed = await fetch('http://127.0.0.1:18889/routing/changing-catalog/v1/control', { method: 'POST', body: JSON.stringify({ mode: 'embedding' }), signal: AbortSignal.timeout(2000) });
    assert.equal(changed.status, 200); await changed.json();
    await admin('providers/routing-changing-catalog/refresh', {});
    const before = (await calls()).length;
    const direct = await publicCall('routing-known-incompatible', '/v1/chat/completions', input('routing-changing-catalog/fixture'));
    assert.equal(direct.status, 200, direct.text); assert.equal((await calls()).length, before + 1);
    const eligible = await invoke('positive-only-catalog-route', 'routing-changed-catalog', { target: 'changing-catalog' });
    assert.deepEqual(eligible.attempts.map(item => item.target), ['changing-catalog']); row.missingChatEvidenceStayedUnknown = true;
  });
  await test('billing-refusals-are-not-retried-and-open-their-own-circuit', async row => {
    const before = (await calls()).length;
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await publicCall('routing-credit-' + attempt, '/v1/chat/completions', input('routing-credit-repeat/fixture'));
      assert.equal(response.status, 402, response.text);
    }
    assert.equal((await calls()).length - before, 4, 'billing refusals must not retry');
    const blocked = await publicCall('routing-credit-circuit', '/v1/chat/completions', input('routing-credit-repeat/fixture'));
    assert.equal(blocked.status, 503, blocked.text); assert.match(blocked.text, /circuit breaker open/);
    assert.equal((await calls()).length - before, 4, 'an open circuit must refuse before I/O'); row.upstreamRefusals = 4;
  });
  await test('request-shape-refusals-never-poison-a-healthy-circuit', async row => {
    const before = (await calls()).length;
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await publicCall('routing-shape-' + attempt, '/v1/chat/completions', input('routing-shape-repeat/fixture'));
      assert.equal(response.status, 400, response.text);
    }
    const result = await invoke('shape-after', 'routing-shape-repeat/fixture', { target: 'shape-repeat' }, { messages: [{ role: 'user', content: 'routing:success' }] });
    assert.equal(result.attempts.length, 1, 'a refused request shape must leave the healthy circuit alone');
    assert.equal((await calls()).length - before, 6); row.upstreamRefusals = 5;
  });
  await test('circuits-isolate-shared-human-and-service-project-callers', async row => {
    const model = 'routing-credit-scopes/fixture';
    const humans = {};
    for (const name of ['a', 'b']) {
      const principal = await admin('principals', { kind: 'human', external_subject: 'routing-human-' + name, display_name: 'Routing human ' + name });
      await admin('memberships', { project_id: project.id, principal_id: principal.id, role: 'owner' });
      await admin(`principals/${principal.id}/connections`, { provider_id: 'routing-credit-scopes', connection_name: 'routing-private', credential_kind: 'api_key', secret: 'fixture-routing-human-' + name, make_default: true });
      await admin('providers/routing-credit-scopes/refresh?principal_id=' + principal.id, {});
      humans[name] = await admin('keys', { project_id: project.id, principal_id: principal.id, name: 'Routing human ' + name });
    }
    const secondProject = await admin('projects', { slug: 'routing-service-b', name: 'Routing second service project' });
    const secondService = await admin('keys', { project_id: secondProject.id, name: 'Routing second service caller' });
    const success = async (name, key) => {
      const result = await invoke('scope-' + name, model, { target: 'credit-scopes' }, { messages: [{ role: 'user', content: 'routing:success' }] }, key?.token);
      assert.equal(result.attempts.length, 1); return result.attempts[0];
    };
    const open = async (name, key, interleave) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const before = (await calls()).length;
        const failed = await publicCall(`routing-scope-${name}-${attempt}`, '/v1/chat/completions', input(model), key?.token);
        assert.equal(failed.status, 402, failed.text); assert.equal((await calls()).length, before + 1);
        if (interleave) await interleave();
      }
      const before = (await calls()).length;
      const refused = await publicCall('routing-scope-' + name + '-open', '/v1/chat/completions', input(model), key?.token);
      assert.equal(refused.status, 503, refused.text); assert.match(refused.text, /circuit breaker open/);
      assert.equal((await calls()).length, before);
    };
    await open('shared');
    assert.equal((await success('human-a', humans.a)).credential, 'human-a');
    assert.equal((await success('service-a', caller)).credential, 'system');
    await open('human-a', humans.a, () => success('interleaved-human-b', humans.b));
    await open('service-a', caller, () => success('interleaved-service-b', secondService));
    assert.equal((await success('human-b-final', humans.b)).credential, 'human-b');
    assert.equal((await success('service-b-final', secondService)).credential, 'system');
    row.isolatedScopes = ['shared', 'human-a', 'human-b', 'service-project-a', 'service-project-b'];
  });
  await test('transient-retries-stay-on-one-target-before-fallback', async row => {
    const result = await invoke('transient', 'routing-transient', { target: 'healthy' }, {}, caller.token);
    assert.deepEqual(result.attempts.map(item => item.target), ['transient-retry', 'transient-retry', 'healthy']); row.attempts = result.attempts;
  });
  await test('retry-after-above-cap-advances-without-real-time-wait', async row => {
    const result = await invoke('retry-after', 'routing-long-retry', { target: 'healthy' }, {}, caller.token);
    assert.deepEqual(result.attempts.map(item => item.target), ['long-retry-cap', 'healthy']);
    assert.ok(result.response.elapsedMs < 2500, 'the controlled one-hour Retry-After must not be slept'); row.elapsedMs = result.response.elapsedMs;
  });
  await test('nonstream-answer-outlives-selection-budget', async row => {
    const result = await invoke('slow-answer', 'routing-slow-answer-route', { target: 'slow-answer' }, { fallback_timeout_ms: 40 }, caller.token);
    assert.deepEqual(result.attempts.map(item => item.target), ['slow-answer']);
    assert.ok(result.response.elapsedMs >= 150); row.elapsedMs = result.response.elapsedMs;
  });
  await test('expired-budget-prevents-retry-and-next-target-after-inflight-failure', async row => {
    const before = (await calls()).length;
    const result = await publicCall('routing-slow-fail', '/v1/chat/completions', input('routing-slow-fail-route', { fallback_timeout_ms: 40 }), caller.token);
    assert.ok(result.status >= 400, result.text);
    const actual = (await calls()).slice(before);
    assert.deepEqual(actual.map(item => item.target), ['slow-fail']); row.attempts = actual;
  });
  await test('unopened-stream-is-bounded-by-selection-budget', async row => {
    const before = (await calls()).length;
    const response = await publicCall('routing-slow-open', '/v1/chat/completions', input('routing-slow-open-route', { fallback_timeout_ms: 40, stream: true }), caller.token);
    assert.ok(response.status >= 400, response.text);
    assert.ok(response.elapsedMs < 1500);
    const actual = (await calls()).slice(before); assert.deepEqual(actual.map(item => item.target), ['slow-open']); row.attempts = actual;
  });
  await test('opened-stream-outlives-selection-budget-without-fallback', async row => {
    const before = (await calls()).length;
    const response = await publicCall('routing-opened-slow', '/v1/chat/completions', input('routing-opened-slow-route', { fallback_timeout_ms: 40, stream: true }), caller.token);
    assert.equal(response.status, 200, response.text); assert.match(response.text, /served:opened-slow:fixture/); assert.match(response.text, /data: \[DONE\]/);
    assert.ok(response.elapsedMs >= 150); assert.deepEqual((await calls()).slice(before).map(item => item.target), ['opened-slow']); row.elapsedMs = response.elapsedMs;
  });
  await test('stream-open-before-text-commits-against-fallback', async row => {
    const before = (await calls()).length;
    let text = '';
    const response = await fetch(process.env.REPLAY_ORIGIN + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + caller.token, 'Content-Type': 'application/json' }, body: JSON.stringify(input('routing-opened-broken-route', { stream: true })), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    try { text = await response.text(); } catch { /* aborted delivery is an observable failure */ }
    assert.doesNotMatch(text, /served:healthy|\[DONE\]/);
    assert.deepEqual((await calls()).slice(before).map(item => item.target), ['opened-broken']); row.noSuccessfulTerminal = true;
  });
  await test('caller-cancellation-closes-upstream-and-never-fails-over', async row => {
    const before = (await calls()).length;
    const controller = new AbortController();
    const response = await fetch(process.env.REPLAY_ORIGIN + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + caller.token, 'Content-Type': 'application/json' }, body: JSON.stringify(input('routing-cancel-stream-route', { stream: true })), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(); assert.equal((await reader.read()).done, false);
    controller.abort(); await assert.rejects(reader.read());
    for (let attempt = 0; attempt < 40 && !((await metrics()).routing.cancelled['cancel-stream']); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok((await metrics()).routing.cancelled['cancel-stream'] > 0);
    assert.deepEqual((await calls()).slice(before).map(item => item.target), ['cancel-stream']); row.cancelled = true;
  });
  await test('affinity-is-stable-and-empty-key-preserves-configured-order', async row => {
    const plain = await invoke('ordinary-order', 'routing-affinity', { target: 'healthy' }, {}, caller.token);
    assert.equal(plain.attempts.length, 1);
    const selected = [];
    for (const [index, affinity_key] of ['pinned-a', 'pinned-a', 'pinned-b', 'pinned-b'].entries()) {
      const before = (await calls()).length;
      const response = await publicCall('routing-affinity-' + index, '/v1/chat/completions', input('routing-affinity', { affinity_key }), caller.token);
      assert.equal(response.status, 200, response.text);
      const actual = (await calls()).slice(before); assert.equal(actual.length, 1); selected.push(actual[0].target);
    }
    assert.equal(selected[0], selected[1]); assert.equal(selected[2], selected[3]); row.selected = selected;
    await route('routing-affinity-wrap', [leaf('shape-affinity-a'), leaf('healthy'), leaf('shape-affinity-b')]);
    let wrap;
    for (let index = 0; index < 32 && !wrap; index++) {
      const key = 'wrap-' + index;
      const answer = await invoke('wrap-probe-' + index, 'routing-affinity-wrap', { target: 'healthy' }, { affinity_key: key }, caller.token);
      if (answer.attempts.length === 3) wrap = { key, attempts: answer.attempts.map(item => item.target) };
    }
    assert.ok(wrap, 'the explicit affinity keys must exercise configured wrap order');
    assert.deepEqual(wrap.attempts, ['shape-affinity-b', 'shape-affinity-a', 'healthy']);
    const again = await invoke('wrap-repeat', 'routing-affinity-wrap', { target: 'healthy' }, { affinity_key: wrap.key }, caller.token);
    assert.deepEqual(again.attempts.map(item => item.target), wrap.attempts); row.wrap = wrap;
  });
  evidence.upstreamCalls = (await calls()).length - start;
  evidence.pass = evidence.cases.length === 22 && evidence.cases.every(row => row.pass);
  save('routing-matrix.json', evidence);
  assert.equal(evidence.pass, true, evidence.cases.filter(row => !row.pass).map(row => row.name + ': ' + row.error).join('\n'));
}
