import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ownerActors = {
  a: { subject: 'qualification-owner-a', name: 'Qualification owner A', email: 'owner-a@example.test' },
  b: { subject: 'qualification-owner-b', name: 'Qualification owner B', email: 'owner-b@example.test' },
  viewer: { subject: 'qualification-viewer', name: 'Qualification viewer', email: 'viewer@example.test' },
  admin: { subject: 'qualification-administrator', name: 'Qualification administrator', email: 'administrator@example.test', groups: 'fixture-admin' },
};

export async function ownerRequest({ origin, ssoSecret, actor = 'a', path, body, method, headers = {}, includeOrigin = true, registerSecret = () => {} }) {
  const identity = typeof actor === 'string' ? ownerActors[actor] : actor;
  const verb = method ?? (body === undefined ? 'GET' : 'POST');
  const multipart = body instanceof FormData;
  const response = await fetch(origin + path, {
    method: verb,
    headers: {
      'X-LLMGW-SSO-Secret': ssoSecret, 'X-Authentik-Uid': identity.subject, 'X-Authentik-Name': identity.name,
      'X-Authentik-Email': identity.email, ...(identity.groups ? { 'X-Authentik-Groups': identity.groups } : {}),
      ...(!multipart ? { 'Content-Type': 'application/json' } : {}),
      ...(includeOrigin && !['GET', 'HEAD'].includes(verb) ? { Origin: origin } : {}), ...headers,
    },
    ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
  });
  const text = await response.text(); let json;
  try { json = JSON.parse(text); } catch { /* callers assert the expected response class */ }
  registerSecret(json?.token);
  return { status: response.status, text, json, headers: Object.fromEntries(response.headers) };
}

export async function ensureOwnerFixture({ origin, adminKey, ssoSecret, artifacts = '/artifacts' }) {
  const path = join(artifacts, 'owner-seed-private.json');
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(ssoSecret, 'the isolated owner fixture requires its synthetic SSO assertion secret');
  const secrets = [adminKey, ssoSecret, 'fixture-iam-system', 'fixture-iam-a-one', 'fixture-iam-b'];
  const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[temporary-key]'), String(value));
  const admin = async (route, body) => {
    const response = await fetch(origin + '/admin/api/' + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + adminKey, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    const text = await response.text(); assert.ok(response.ok, route + ': ' + response.status + ' ' + redact(text));
    const json = JSON.parse(text); if (json.token) secrets.push(json.token); return json;
  };
  const user = async (actor, route, body) => {
    const response = await ownerRequest({ origin, ssoSecret, actor, path: '/user/api/' + route, body, registerSecret: value => { if (value) secrets.push(value); } });
    assert.ok(response.status >= 200 && response.status < 300, route + ': ' + response.status + ' ' + redact(response.text)); return response.json;
  };
  for (const kind of ['chat', 'tools']) {
    await admin('providers', { id: 'iam-' + kind, registry_id: 'openrouter', base_url: 'http://upstream:18889/iam/' + kind + '/v1', api_key: 'fixture-iam-system' });
    await admin('providers/iam-' + kind + '/refresh', {});
  }
  const actors = {};
  for (const name of ['a', 'b', 'viewer']) actors[name] = (await user(name, 'me')).principal;
  const project = await admin('projects', { slug: 'qualification-owner', name: 'Qualification owner project' });
  const foreign = await admin('projects', { slug: 'qualification-foreign', name: 'Qualification foreign project' });
  for (const [actor, role] of [['a', 'owner'], ['b', 'member'], ['viewer', 'viewer']]) await admin('memberships', { project_id: project.id, principal_id: actors[actor].id, role });
  await admin('memberships', { project_id: foreign.id, principal_id: actors.b.id, role: 'owner' });
  const connections = {};
  for (const [actor, secret] of [['a', 'fixture-iam-a-one'], ['b', 'fixture-iam-b']]) {
    const response = await user(actor, 'connections', { provider_id: 'iam-chat', connection_name: 'owner-primary', credential_kind: 'api_key', secret, make_default: true });
    connections[actor] = response.connection ?? response;
    await user(actor, 'connections', { provider_id: 'iam-tools', connection_name: 'owner-tools', credential_kind: 'api_key', secret, make_default: true });
    for (const id of ['iam-chat', 'iam-tools']) await admin('providers/' + id + '/refresh?principal_id=' + actors[actor].id, {});
  }
  const keys = {};
  for (const actor of ['a', 'b']) keys[actor] = await user(actor, 'keys', { project_id: project.id, name: 'Qualification owner ' + actor.toUpperCase() + ' key', daily_requests: 100 });
  const extension = await admin('extensions', { id: 'qualification-daemon', name: 'Qualification daemon', url: 'http://upstream:18889/daemon', secret: 'fixture-extension-secret' });
  await admin('providers', { id: 'ext-browser-oauth', type: 'fixture_oauth', extension: extension.id });
  const seed = { actors, project, foreign, keys, connections, extension: { id: extension.id, name: extension.name, url: extension.url } };
  writeFileSync(path, JSON.stringify(seed, null, 2) + '\n', { mode: 0o600 });
  return seed;
}
