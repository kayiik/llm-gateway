import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureOwnerFixture } from './owner-fixture.mjs';
import { runInstalledOwnerRecovery } from './installed-owner.mjs';

const fixture = JSON.parse(readFileSync(new URL('../integration/fixtures/conversation.json', import.meta.url), 'utf8'));
const provider = 'preserved-provider';
const route = 'preserved-route';
const fields = (value, names) => Object.fromEntries(names.map(name => [name, value?.[name] ?? null]));
const sorted = values => values.sort((a, b) => a.id.localeCompare(b.id));

export async function runInstalledState(mode) {
  const origin = process.env.REPLAY_ORIGIN;
  const adminKey = process.env.REPLAY_ADMIN_KEY;
  assert.ok(origin && adminKey, 'isolated runner environment required');
  const artifactRoot = process.env.REPLAY_ARTIFACTS ?? '/artifacts';
  const save = (name, value) => writeFileSync(join(artifactRoot, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const secrets = [adminKey, 'fixture-preserved-system', 'fixture-preserved-human'];
  const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[temporary-key]'), String(value));
  const result = { mode, boundary: 'Installed Gateway HTTP and persisted state; synthetic local provider credentials', cases: [], liveProviderCalls: 0 };
  async function request(path, body, token = adminKey, requestId) {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(requestId ? { 'X-Request-ID': requestId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    return { status: response.status, text, response };
  }
  async function admin(path, body) {
    const response = await request('/admin/api/' + path, body);
    assert.ok(response.status >= 200 && response.status < 300, `${path}: ${response.status} ${redact(response.text)}`);
    return JSON.parse(response.text);
  }
  async function test(name, run) {
    try { await run(); result.cases.push({ name, pass: true }); }
    catch (error) { result.cases.push({ name, pass: false, error: redact(error.message) }); }
  }
  const metrics = async () => (await fetch('http://upstream:18889/metrics', { signal: AbortSignal.timeout(2000) })).json();
  async function exercise(seed, phase) {
    for (const kind of ['human', 'service']) {
      const before = await metrics();
      const response = await request('/v1/chat/completions', { model: route, messages: [{ role: 'user', content: fixture.tool.result }] }, seed.keys[kind].token, `preserved-${phase}-${kind}`);
      assert.equal(response.status, 200, redact(response.text));
      const body = JSON.parse(response.text);
      assert.equal(body.choices[0].message.content, 'complete-fixture');
      assert.deepEqual(body.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
      const after = await metrics();
      const credential = kind === 'human' ? 'human' : 'system';
      const other = kind === 'human' ? 'system' : 'human';
      assert.equal(after.preserved[credential], before.preserved[credential] + 1, `${kind}: saved encrypted credential must reach the provider`);
      assert.equal(after.preserved[other], before.preserved[other], `${kind}: another credential must not substitute for it`);
    }
  }
  async function snapshot(seed) {
    const state = await admin('state');
    result.build = fields(state, ['version', 'commit', 'build_time']);
    const principals = (await admin('principals?limit=100')).principals;
    const keys = (await admin(`keys?project_id=${seed.project.id}&limit=100`)).keys;
    const connections = (await admin(`principals/${seed.human.id}/connections`)).connections;
    const ids = Object.values(seed.keys).map(item => item.key.principal_id);
    const selectedKeys = Object.values(seed.keys).map(item => item.key.id);
    const quota = [];
    for (const kind of ['human', 'service']) {
      const limits = await admin(`keys/${seed.keys[kind].key.id}/limits`);
      for (const limit of limits.limits.filter(item => item.field === 'daily_requests')) quota.push({ key_id: limits.key_id, ...fields(limit, ['scope', 'field', 'limit', 'used', 'resets_at']) });
    }
    let history;
    for (let i = 0; i < 40; i++) {
      const response = await admin(`requests?project_id=${seed.project.id}&limit=100`);
      history = Array.isArray(response) ? response : (response.requests ?? response.rows ?? []);
      if (['human', 'service'].every(kind => history.some(row => row.request_id === `preserved-seed-${kind}`))) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return {
      control: {
        provider: fields(state.providers.find(item => item.id === provider), ['id', 'type', 'registry_id', 'base_url', 'disabled', 'api_key_set']),
        route: state.endpoints?.[route] ?? state.categories?.[route] ?? null,
        project: fields(state.projects.find(item => item.id === seed.project.id), ['id', 'slug', 'name', 'status']),
        principals: sorted(principals.filter(item => ids.includes(item.id)).map(item => fields(item, ['id', 'kind', 'external_subject', 'display_name', 'status']))),
        memberships: state.memberships.filter(item => item.project_id === seed.project.id).sort((a, b) => a.principal_id.localeCompare(b.principal_id)).map(item => fields(item, ['project_id', 'principal_id', 'role'])),
        connections: sorted(connections.map(item => fields(item, ['id', 'principal_id', 'provider_id', 'connection_name', 'credential_kind', 'private_to_principal', 'is_default', 'status']))),
        projectPolicy: fields(await admin(`projects/${seed.project.id}/policy`), ['project_id', 'allowed_providers', 'daily_requests']),
      },
      keys: sorted(keys.filter(item => selectedKeys.includes(item.id)).map(item => fields(item, ['id', 'project_id', 'principal_id', 'name', 'status', 'allowed_routes', 'routes_only', 'allowed_providers', 'daily_requests', 'revealable']))),
      quota,
      history: history.filter(item => ['preserved-seed-human', 'preserved-seed-service'].includes(item.request_id)).sort((a, b) => a.request_id.localeCompare(b.request_id)).map(item => fields(item, ['request_id', 'project_id', 'principal_id', 'key_id', 'endpoint', 'provider', 'requested_model', 'routed_model', 'status_code', 'input_tokens', 'output_tokens', 'source_usage'])),
    };
  }
  try {
    let healthy = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(origin + '/health', { signal: AbortSignal.timeout(1000) })).ok) { healthy = true; break; } } catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(healthy, 'installed Gateway did not become healthy');
    if (mode === 'seed') {
      await admin('providers', { id: provider, registry_id: 'groq', base_url: 'http://upstream:18889/preserved/chat/v1', api_key: 'fixture-preserved-system' });
      await admin(`providers/${provider}/refresh`, {});
      await admin('endpoints', { name: route, ingress: ['/v1/chat/completions'], failover: [{ provider, model: 'fixture' }] });
      const human = await admin('principals', { kind: 'human', external_subject: 'preserved-human', display_name: 'Preserved human' });
      const project = await admin('projects', { slug: 'preserved-project', name: 'Preserved project' });
      await admin('memberships', { project_id: project.id, principal_id: human.id, role: 'owner' });
      await admin(`projects/${project.id}/policy`, { allowed_providers: [provider], daily_requests: 200 });
      await admin(`principals/${human.id}/connections`, { provider_id: provider, connection_name: 'preserved-private', credential_kind: 'api_key', secret: 'fixture-preserved-human', make_default: true });
      await admin(`providers/${provider}/refresh?principal_id=${human.id}`, {});
      const keys = {};
      for (const kind of ['human', 'service', 'disabled']) {
        keys[kind] = await admin('keys', { project_id: project.id, ...(kind === 'human' ? { principal_id: human.id } : {}), name: 'Preserved ' + kind, allowed_routes: [route], routes_only: true, allowed_providers: [provider], daily_requests: 50 });
        secrets.push(keys[kind].token);
      }
      await admin('keys/update', { id: keys.disabled.key.id, disabled: true });
      const seed = { human, project, keys };
      await exercise(seed, 'seed');
      seed.snapshot = await snapshot(seed);
      assert.equal(seed.snapshot.control.principals.length, 3);
      assert.equal(seed.snapshot.control.connections.length, 1);
      assert.equal(seed.snapshot.history.length, 2);
      for (const kind of ['human', 'service']) {
        const limits = seed.snapshot.quota.filter(item => item.key_id === keys[kind].key.id);
        assert.ok(limits.some(item => item.scope === 'key' && item.limit === 50 && item.used === 1), kind + ': seed key counter must be populated');
        assert.ok(limits.some(item => item.scope === 'project' && item.limit === 200 && item.used === 2), kind + ': seed project counter must be populated');
      }
      // Only the isolated client reads these generated tokens; public receipts contain IDs and assertions.
      save('state-seed-private.json', seed);
      save('state-seed-snapshot.json', seed.snapshot);
      if (process.env.REPLAY_SSO_SECRET) {
        await ensureOwnerFixture({ origin, adminKey, ssoSecret: process.env.REPLAY_SSO_SECRET, artifacts: artifactRoot });
        result.ownerSeeded = true;
      }
      result.cases.push({ name: 'seeded-installed-state', pass: true });
    } else {
      const seed = JSON.parse(readFileSync(join(artifactRoot, 'state-seed-private.json'), 'utf8'));
      secrets.push(...Object.values(seed.keys).map(item => item.token));
      const current = await snapshot(seed);
      save(`state-${mode}-snapshot.json`, current);
      await test('preserved-control-state', async () => {
        assert.deepEqual(current.control, seed.snapshot.control);
      });
      await test('preserved-key-policy-and-recovery', async () => {
        assert.deepEqual(current.keys, seed.snapshot.keys);
        for (const kind of ['human', 'service']) {
          const recovered = await admin(`keys/${seed.keys[kind].key.id}/reveal`, {});
          assert.ok(recovered.token === seed.keys[kind].token, kind + ': the original key must remain decryptable');
          const before = (await metrics()).inference;
          const refused = await request('/v1/chat/completions', { model: provider + '/fixture', messages: [{ role: 'user', content: fixture.tool.result }] }, seed.keys[kind].token);
          assert.equal(refused.status, 404, 'routes-only key must still hide a direct selector');
          assert.equal((await metrics()).inference, before);
          assert.equal((await request('/admin/api/state', undefined, seed.keys[kind].token)).status, 401, 'data-plane keys must not become administrators');
        }
        const before = (await metrics()).inference;
        assert.equal((await request('/v1/chat/completions', { model: route, messages: [{ role: 'user', content: fixture.tool.result }] }, seed.keys.disabled.token)).status, 401);
        assert.equal((await metrics()).inference, before, 'disabled key must remain disabled before dispatch');
      });
      await test('preserved-quota-counters', async () => {
        for (const expected of seed.snapshot.quota) {
          const actual = current.quota.find(item => item.key_id === expected.key_id && item.scope === expected.scope && item.field === expected.field);
          assert.ok(actual, 'seeded quota scope must still exist');
          assert.equal(actual.limit, expected.limit);
          assert.equal(actual.resets_at, expected.resets_at, 'compare the same quota window');
          const added = mode.endsWith('restart') ? (expected.scope === 'project' ? 2 : 1) : 0;
          assert.equal(actual.used, expected.used + added, 'preserve the exact seed plus the two first-start verification calls');
        }
      });
      await test('preserved-request-history', async () => {
        assert.deepEqual(current.history, seed.snapshot.history, 'old ledger rows, including absent source evidence, must survive without fabrication');
      });
      await test('preserved-credential-decryption', async () => {
        await exercise(seed, mode);
      });
      await test('installed-console-delivery', async () => {
        const page = await request('/console/');
        assert.equal(page.status, 200);
        assert.match(page.text, /<title>LLM Gateway Console<\/title>/);
        const assets = [...page.text.matchAll(/(?:src|href)="([^\"]+\.(?:js|css))"/g)].map(match => match[1]);
        assert.ok(assets.some(asset => asset.endsWith('.js')), 'embedded console must reference a local script');
        for (const asset of assets) {
          const url = new URL(asset, origin + '/console/');
          assert.equal(url.origin, origin, 'console assets must be local');
          const response = await request(url.pathname);
          assert.equal(response.status, 200, asset);
          assert.doesNotMatch(response.response.headers.get('content-type') ?? '', /text\/html/, asset + ': missing assets must not be replaced with the SPA shell');
          assert.ok(response.text.length > 0, asset);
        }
      });
      if (existsSync(join(artifactRoot, 'owner-seed-private.json'))) {
        result.ownerRecovery = await runInstalledOwnerRecovery({ origin, adminKey, ssoSecret: process.env.REPLAY_SSO_SECRET, artifacts: artifactRoot, mode });
      }
    }
  } catch (error) { result.setupError = redact(error.message); }
  result.pass = !result.setupError && result.cases.length === (mode === 'seed' ? 1 : 6) && result.cases.every(item => item.pass) && (!result.ownerRecovery || result.ownerRecovery.pass);
  save(`state-${mode}-results.json`, result);
  console.log(JSON.stringify(result));
  if (!result.pass) process.exitCode = 1;
  return result;
}
