import assert from 'node:assert/strict';
import https from 'node:https';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPlaywright } from '../browser-runtime.mjs';
import { playgroundPayload } from '../live-acceptance/core.mjs';

const conversation = JSON.parse(readFileSync(new URL('../integration/fixtures/conversation.json', import.meta.url), 'utf8'));

export async function runOwnerBrowser({ origins, artifacts, runtime, phase, knownSecrets = [], fixtureMode = async () => {}, fixtureStreamCut = () => 0 }) {
  const seed = JSON.parse(readFileSync(join(artifacts, 'owner-seed-private.json'), 'utf8'));
  const secrets = new Set([...knownSecrets, ...Object.values(seed.keys).map(item => item.token)]);
  const redact = value => [...secrets].reduce((text, secret) => text.replaceAll(secret, '[temporary-key]'), String(value));
  const result = { phase, boundary: 'Actual browser over pinned loopback TLS and fixed trusted proxy identities', pass: false, cases: [], pageErrors: [], blockedOrigins: [], audits: [] };
  const save = () => writeFileSync(join(artifacts, `owner-browser-${phase}.json`), redact(JSON.stringify(result, null, 2)) + '\n', { mode: 0o600 });
  const test = async (name, run) => { const row = { name, pass: false }; result.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = redact(error.message); } finally { save(); } };
  const certificate = new X509Certificate(readFileSync(join(runtime, 'owner-cert.pem')));
  const spki = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  let browser;
  let ownedRequestID;
  const sessions = {};
  try {
    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({ headless: true, channel: process.env.LLMGW_BROWSER_CHANNEL || 'chrome', args: ['--ignore-certificate-errors-spki-list=' + spki] });
    result.browserVersion = browser.version();
    const session = async name => {
      if (sessions[name]) return sessions[name];
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' }); context.setDefaultTimeout(12000);
      const modelRequests = [];
      await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origins[name]) return route.continue(); result.blockedOrigins.push(url.origin); return route.abort('blockedbyclient'); });
      context.on('page', page => { page.on('pageerror', error => result.pageErrors.push(redact(error.message))); page.on('request', request => { if (new URL(request.url()).pathname === '/user/api/models') modelRequests.push(request.url()); }); });
      const page = await context.newPage(); sessions[name] = { context, page, modelRequests }; return sessions[name];
    };
    const me = page => page.evaluate(async () => { const response = await fetch('/user/api/me'); return { status: response.status, body: await response.json() }; });
    await test('pinned-tls-owner-entry-keeps-proxy-secret-and-admin-key-server-side', async row => {
      const tls = await new Promise((resolve, reject) => {
        const request = https.get(origins.a + '/health', { ca: readFileSync(join(runtime, 'owner-cert.pem')), agent: false }, response => { const details = { authorized: response.socket.authorized, protocol: response.socket.getProtocol(), fingerprint256: response.socket.getPeerCertificate().fingerprint256 }; response.resume(); response.on('end', () => resolve(details)); });
        request.setTimeout(5000, () => request.destroy(new Error('pinned TLS deadline'))); request.on('error', reject);
      });
      assert.equal(tls.authorized, true); assert.equal(tls.fingerprint256, certificate.fingerprint256); assert.match(tls.protocol, /^TLSv1\.[23]$/); row.tls = tls;
      const { page } = await session('a'); await page.goto(origins.a + '/portal/', { waitUntil: 'networkidle' }); await page.getByRole('main').waitFor();
      const identity = await me(page); assert.equal(identity.status, 200); assert.equal(identity.body.principal.id, seed.actors.a.id);
      assert.deepEqual(await page.evaluate(() => ({ session: sessionStorage.getItem('llmgw.console.static-admin-key'), local: localStorage.getItem('llmgw.console.static-admin-key') })), { session: null, local: null });
      const body = await page.locator('body').innerText(); for (const secret of knownSecrets) assert.ok(!body.includes(secret), 'assertion and administrator credentials must never render in the portal');
    });
    await test('fixed-proxy-identities-isolate-owner-and-sso-administrator', async row => {
      const { page: a } = await session('a');
      await a.goto(origins.a + '/portal/', { waitUntil: 'networkidle' });
      const spoof = await a.evaluate(async () => {
        const response = await fetch('/admin/api/state', { headers: { 'X-Authentik-Uid': 'qualification-administrator', 'X-Authentik-Groups': 'fixture-admin', 'X-LLMGW-SSO-Secret': 'client-spoof' } });
        return response.status;
      });
      assert.equal(spoof, 403, 'the fixed proxy must overwrite all client identity and role assertions');
      const { page: b } = await session('b'); await b.goto(origins.b + '/portal/', { waitUntil: 'networkidle' }); const identity = await me(b); assert.equal(identity.body.principal.id, seed.actors.b.id); assert.ok(!identity.body.keys.some(item => item.id === seed.keys.a.key.id));
      const { page: administrator } = await session('admin'); await administrator.goto(origins.admin + '/console/', { waitUntil: 'networkidle' });
      const status = await administrator.evaluate(async () => (await fetch('/admin/api/state')).status); assert.equal(status, 200); assert.equal(await administrator.evaluate(() => sessionStorage.getItem('llmgw.console.static-admin-key')), null); row.isolatedActors = ['owner-a', 'owner-b', 'sso-administrator'];
    });
    await test('browser-device-sign-in-binds-the-chosen-owner-and-tests-the-private-catalog', async row => {
      const { page, context } = await session('admin');
      // A locally fulfilled verification page prevents a test device hand-off
      // from ever contacting the synthetic provider URL on the public network.
      await context.route('https://verification.example.test/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Controlled device verification</title>' }));
      await page.goto(origins.admin + '/console/#/providers', { waitUntil: 'networkidle' });
      await page.locator('[data-extension-trigger="qualification-daemon"]').click();
      await page.getByRole('button', { name: 'Add account for Controlled private device sign-in', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: /Connect Controlled private device sign-in/ }); await dialog.waitFor();
      await dialog.getByRole('combobox', { name: 'Whose account is this?', exact: true }).selectOption(seed.actors.a.id);
      const name = 'browser-device-' + phase; await dialog.getByLabel('Connection name', { exact: true }).fill(name);
      const start = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/admin/api/principals/${seed.actors.a.id}/connections/ext-browser-oauth/oauth/start`);
      await dialog.getByRole('button', { name: /Continue with Controlled private device sign-in/ }).click(); assert.equal((await start).status(), 200);
      await dialog.getByRole('button', { name: /^Copy device code / }).waitFor();
      await dialog.getByRole('heading', { name: 'Connected and tested', exact: true }).waitFor({ timeout: 18000 });
      const own = await page.evaluate(async id => (await (await fetch('/admin/api/principals/' + id + '/connections')).json()).connections, seed.actors.a.id);
      const foreign = await page.evaluate(async id => (await (await fetch('/admin/api/principals/' + id + '/connections')).json()).connections, seed.actors.b.id);
      const connection = own.find(item => item.provider_id === 'ext-browser-oauth' && item.connection_name === name); assert.ok(connection);
      assert.ok(!foreign.some(item => item.id === connection.id));
      await dialog.getByRole('button', { name: 'Done', exact: true }).click(); row.owner = seed.actors.a.id; row.privateCatalogVerified = true;
    });
    await test('extension-card-model-count-and-drilldown-follow-the-selected-owner', async row => {
      const { page } = await session('admin');
      const trigger = page.locator('[data-extension-trigger="qualification-daemon"]');
      if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
      const table = page.getByRole('table', { name: 'Providers Qualification daemon serves', exact: true });
      const entry = table.getByRole('row', { name: /Controlled private device sign-in/ });
      const owner = page.getByRole('combobox', { name: 'Catalog owner', exact: true });
      await owner.selectOption(seed.actors.a.id);
      const summary = entry.locator('details.extension-models > summary');
      await summary.getByText('2 models', { exact: true }).waitFor(); await summary.click();
      await entry.getByText('ext-browser-oauth/private-chat', { exact: true }).waitFor();
      await entry.getByText('ext-browser-oauth/private-responses', { exact: true }).waitFor();
      await owner.selectOption(seed.actors.b.id);
      await entry.getByText('0 models', { exact: true }).waitFor();
      assert.equal(await entry.getByText('ext-browser-oauth/private-chat', { exact: true }).count(), 0);
      await owner.selectOption(seed.actors.a.id); await summary.getByText('2 models', { exact: true }).waitFor();
      row.ownerScopedModels = 2; row.foreignModels = 0;
    });
    await test('extension-private-model-handoff-preserves-owner-and-exact-playground-selection', async row => {
      const { page } = await session('admin');
      await page.goto(origins.admin + '/console/#/providers', { waitUntil: 'networkidle' });
      const trigger = page.locator('[data-extension-trigger="qualification-daemon"]');
      if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
      const details = await page.locator('[aria-label*="details"]').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')).filter(Boolean));
      assert.ok(details.includes('Open Controlled private device sign-in details'), 'extension detail action absent: ' + JSON.stringify(details.slice(0, 16)));
      await page.getByRole('button', { name: 'Open Controlled private device sign-in details', exact: true }).click();
      const owner = page.getByRole('combobox', { name: 'Catalog owner', exact: true }); await owner.selectOption(seed.actors.a.id);
      const chosen = page.getByRole('row').filter({ hasText: 'ext-browser-oauth/private-chat' }); await chosen.waitFor();
      await chosen.getByRole('button', { name: 'Try in Playground', exact: true }).click();
      await page.getByRole('heading', { name: 'Playground', exact: true }).waitFor();
      const selectedModel = page.locator('.playground-settings__toggle').getByText('ext-browser-oauth/private-chat', { exact: true });
      if (!await selectedModel.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
        const project = page.getByRole('combobox', { name: 'Project', exact: true });
        if (await project.isVisible().catch(() => false)) await project.selectOption(seed.project.id, { timeout: 8000 }).catch(async error => { if (!await selectedModel.count()) throw error; });
      }
      await selectedModel.waitFor();
      await page.locator('.playground-settings__toggle').click();
      assert.equal(await page.getByRole('combobox', { name: 'Human owner', exact: true }).inputValue(), seed.actors.a.id);
      assert.equal(await page.getByRole('combobox', { name: 'Project', exact: true }).inputValue(), seed.project.id); row.chosenOwnerPreserved = true;
    });
    await test('generic-private-api-key-model-catalog-follows-the-selected-human', async row => {
      const { page } = await session('admin');
      await page.goto(origins.admin + '/console/#/providers/openrouter', { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: 'OpenRouter', exact: true }).waitFor();
      const owner = page.getByRole('combobox', { name: 'Catalog owner', exact: true });
      await owner.selectOption(seed.actors.a.id);
      const catalog = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Models from this provider', exact: true }) });
      await catalog.getByText('iam-chat/fixture-owner-a', { exact: true }).waitFor();
      assert.equal(await catalog.getByText('iam-chat/fixture-owner-b', { exact: true }).count(), 0);
      await owner.selectOption(seed.actors.b.id);
      await catalog.getByText('iam-chat/fixture-owner-b', { exact: true }).waitFor();
      assert.equal(await catalog.getByText('iam-chat/fixture-owner-a', { exact: true }).count(), 0, 'a late or global catalog cannot replace the chosen owner');
      await owner.selectOption('');
      await page.getByRole('heading', { name: 'Select a catalog owner', exact: true }).waitFor();
      assert.equal(await catalog.getByText('iam-chat/fixture-owner-b', { exact: true }).count(), 0);
      row.ownerModels = ['fixture-owner-a', 'fixture-owner-b'];
    });
    await test('expired-device-code-offers-a-retry-without-creating-the-failed-connection', async row => {
      const { page } = await session('admin');
      await fixtureMode('expired');
      try {
        await page.goto(origins.admin + '/console/#/providers', { waitUntil: 'networkidle' });
        const extension = page.locator('[data-extension-trigger="qualification-daemon"]');
        if (await extension.getAttribute('aria-expanded') !== 'true') await extension.click();
        await page.getByRole('button', { name: 'Add account for Controlled private device sign-in', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: /Connect Controlled private device sign-in/ }); await dialog.waitFor();
        await dialog.getByRole('combobox', { name: 'Whose account is this?', exact: true }).selectOption(seed.actors.a.id);
        const expired = 'browser-expired-' + phase; await dialog.getByLabel('Connection name', { exact: true }).fill(expired);
        await dialog.getByRole('button', { name: /Continue with Controlled private device sign-in/ }).click();
        await dialog.getByRole('heading', { name: 'Connection was not completed', exact: true }).waitFor({ timeout: 12000 });
        await dialog.getByText('The device code expired. Start a new sign-in.', { exact: true }).waitFor();
        const before = await page.evaluate(async id => (await (await fetch('/admin/api/principals/' + id + '/connections')).json()).connections, seed.actors.a.id);
        assert.ok(!before.some(connection => connection.connection_name === expired));
        await fixtureMode('absent'); await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
        const retried = 'browser-retried-' + phase; await dialog.getByLabel('Connection name', { exact: true }).fill(retried);
        await dialog.getByRole('button', { name: /Continue with Controlled private device sign-in/ }).click();
        await dialog.getByRole('heading', { name: 'Connected and tested', exact: true }).waitFor({ timeout: 18000 });
        const after = await page.evaluate(async id => (await (await fetch('/admin/api/principals/' + id + '/connections')).json()).connections, seed.actors.a.id);
        assert.ok(after.some(connection => connection.provider_id === 'ext-browser-oauth' && connection.connection_name === retried));
        assert.ok(!after.some(connection => connection.connection_name === expired));
        await dialog.getByRole('button', { name: 'Done', exact: true }).click(); row.failedConnectionAbsent = true; row.retryAuthorized = true;
      } finally { await fixtureMode('absent'); }
    });
    await test('zero-project-playground-never-loads-an-implicit-catalog', async row => {
      const { page, modelRequests } = await session('empty');
      await page.goto(origins.empty + '/portal/#/overview', { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: 'Review workspace access', exact: true }).waitFor();
      assert.equal(modelRequests.length, 0);
      await page.goto(origins.empty + '/portal/#/playground', { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: 'No eligible project is available', exact: true }).waitFor();
      const identity = await me(page); assert.deepEqual(identity.body.projects, []); assert.equal(modelRequests.length, 0); row.catalogRequests = 0;
    });
    await test('viewer-project-exclusion-and-submit-validation-prevent-key-issuance', async row => {
      const { page } = await session('viewer'); await page.goto(origins.viewer + '/portal/#/keys', { waitUntil: 'networkidle' }); await page.getByRole('main').waitFor();
      const create = page.getByRole('button', { name: /^(Create|Issue).*key/i });
      if (await create.count()) {
        let issued = 0; page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/user/api/keys') issued++; });
        await create.first().click(); const editor = page.locator('form.key-editor'); await editor.waitFor();
        const choices = await editor.getByRole('combobox', { name: 'Project', exact: true }).locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean)); assert.deepEqual(choices, []);
        await editor.getByLabel('Name', { exact: true }).fill('Viewer must not issue'); await editor.getByRole('button', { name: 'Create key', exact: true }).click();
        await page.getByRole('status').getByText('An active project with key-management permission and a key name are required.', { exact: true }).waitFor(); assert.equal(issued, 0);
        await editor.getByRole('button', { name: 'Close key editor', exact: true }).click();
      }
      row.keyIssuanceRequests = 0;
    });
    await test('owner-key-create-local-expiry-clear-reveal-revoke-and-delete-work-in-browser', async row => {
      const { page, context } = await session('a'); await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: origins.a });
      await page.goto(origins.a + '/portal/#/keys', { waitUntil: 'networkidle' }); await page.bringToFront(); await page.getByRole('heading', { name: 'API keys', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Create key', exact: true }).click(); const editor = page.locator('form.key-editor'); await editor.waitFor();
      await editor.getByRole('combobox', { name: 'Project', exact: true }).selectOption(seed.project.id);
      const name = 'Browser owner ' + phase; await editor.getByLabel('Name', { exact: true }).fill(name);
      const localExpiry = await page.evaluate(() => { const value = new Date(Date.now() + 3600000); const pad = number => String(number).padStart(2, '0'); return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`; });
      await editor.getByLabel('Expires (optional)', { exact: true }).fill(localExpiry); await editor.locator('[name="daily_requests"]').fill('2');
      const createdResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/user/api/keys');
      await editor.getByRole('button', { name: 'Create key', exact: true }).click(); const response = await createdResponse; const created = await response.json(); if (created.token) secrets.add(created.token);
      assert.equal(response.status(), 200); assert.equal(created.key.principal_id, seed.actors.a.id); assert.equal(created.key.project_id, seed.project.id); assert.ok(created.key.expires_at > Date.now() / 1000);
      const secret = page.getByRole('dialog', { name: 'API key', exact: true }); await secret.waitFor(); await secret.getByRole('button', { name: 'Copy key', exact: true }).click(); await secret.getByRole('button', { name: 'Copied', exact: true }).waitFor();
      assert.ok(await page.evaluate(async token => (await navigator.clipboard.readText()) === token, created.token), 'copy must return the actual issued key');
      for (let index = 0; index < 6; index++) { await page.keyboard.press('Tab'); assert.equal(await secret.evaluate(element => element.contains(document.activeElement)), true, 'key secret keyboard focus must remain in its modal'); }
      await page.keyboard.press('Escape'); await secret.waitFor({ state: 'hidden' });
      await page.getByRole('searchbox', { name: 'Search keys', exact: true }).fill(name);
      await page.getByRole('button', { name: 'Edit ' + name, exact: true }).click(); await editor.waitFor(); await editor.getByLabel('Expires (optional)', { exact: true }).fill(''); await editor.locator('[name="daily_requests"]').fill('3');
      const updatedResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/user/api/keys/' + created.key.id + '/update'); await editor.getByRole('button', { name: 'Save key', exact: true }).click(); assert.equal((await updatedResponse).status(), 200);
      const identity = await me(page); const current = identity.body.keys.find(item => item.id === created.key.id); assert.equal(current.expires_at ?? 0, 0); assert.equal(current.policy.daily_requests, 3);
      const revealResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/user/api/keys/' + created.key.id + '/reveal'); await page.getByRole('button', { name: 'Reveal ' + name, exact: true }).click(); const recovered = await (await revealResponse).json(); if (recovered.token) secrets.add(recovered.token); assert.ok(recovered.token === created.token);
      await page.getByRole('button', { name: 'Hide ' + name, exact: true }).click();
      const use = await page.evaluate(async token => { const response = await fetch('/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'iam-chat/fixture', messages: [{ role: 'user', content: 'identity' }] }) }); return { status: response.status, requestId: response.headers.get('x-request-id'), body: await response.json() }; }, created.token);
      assert.equal(use.status, 200); assert.equal(use.body.choices[0].message.content, 'credential:a-one'); assert.ok(use.requestId); ownedRequestID = use.requestId;
      page.once('dialog', dialog => dialog.accept()); const revoke = page.waitForResponse(response => response.request().method() === 'DELETE' && new URL(response.url()).pathname === '/user/api/keys/' + created.key.id); await page.getByRole('button', { name: 'Revoke ' + name, exact: true }).click(); assert.equal((await revoke).status(), 200);
      await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('all'); await page.getByRole('button', { name: 'Delete ' + name, exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Edit ' + name, exact: true }).isDisabled(), true);
      const refused = await page.evaluate(async token => (await fetch('/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'iam-chat/fixture', messages: [] }) })).status, created.token); assert.equal(refused, 401);
      page.once('dialog', dialog => dialog.accept()); const deleted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/user/api/keys/delete'); await page.getByRole('button', { name: 'Delete ' + name, exact: true }).click(); assert.equal((await deleted).status(), 200); await page.getByRole('button', { name: 'Delete ' + name, exact: true }).waitFor({ state: 'hidden' });
      row.serverDerivedOwner = true; row.expiryRoundtrip = 'local-create and explicit blank clear'; row.keyLifecycleCompleted = true;
    });
    await test('owner-request-browser-filters-persisted-key-history-without-foreign-caller-leakage', async row => {
      assert.ok(ownedRequestID, 'a real owner-key call must precede the Requests journey');
      const { page: b } = await session('b');
      const foreign = await b.evaluate(async token => { const response = await fetch('/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'iam-chat/fixture', messages: [{ role: 'user', content: 'identity' }] }) }); return { status: response.status, id: response.headers.get('x-request-id') }; }, seed.keys.b.token);
      assert.equal(foreign.status, 200); assert.ok(foreign.id);
      for (const [actor, ownID, otherID] of [['a', ownedRequestID, foreign.id], ['b', foreign.id, ownedRequestID]]) {
        const { page } = await session(actor);
        await page.goto(origins[actor] + '/portal/#/requests', { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: 'Requests', exact: true }).waitFor();
        await page.getByLabel('Request ID', { exact: true }).fill(ownID); await page.getByRole('button', { name: 'Search', exact: true }).click();
        const found = page.locator('table tbody tr').filter({ hasText: ownID }); await found.waitFor();
        assert.match(await found.innerText(), /iam-chat\/fixture/); assert.match(await found.innerText(), /iam-chat/);
        await page.getByLabel('Request ID', { exact: true }).fill(otherID); await page.getByRole('button', { name: 'Search', exact: true }).click();
        await page.getByRole('heading', { name: 'No recorded requests', exact: true }).waitFor();
        assert.equal(await page.getByText(otherID, { exact: true }).count(), 0);
      }
      const { page: administrator } = await session('admin'); await administrator.goto(origins.admin + '/console/#/requests', { waitUntil: 'networkidle' });
      await administrator.getByLabel('Request ID', { exact: true }).fill(foreign.id); await administrator.getByRole('button', { name: 'Search', exact: true }).click();
      await administrator.locator('table tbody tr').filter({ hasText: foreign.id }).waitFor();
      row.ownerScoped = true; row.adminCanFindBoth = true;
    });
    await test('admin-audit-browser-filters-safe-records-and-owner-activity-api-is-scoped', async row => {
      const { page: administrator } = await session('admin'); await administrator.goto(origins.admin + '/console/#/audit', { waitUntil: 'networkidle' });
      await administrator.getByRole('heading', { name: 'Audit log', exact: true }).waitFor();
      await administrator.getByLabel('Action', { exact: true }).fill('api_key.'); await administrator.getByRole('button', { name: 'Search', exact: true }).click();
      await administrator.locator('table tbody tr').filter({ hasText: 'api_key.create' }).first().waitFor();
      for (const secret of secrets) assert.ok(!(await administrator.locator('main').innerText()).includes(secret), 'audit must not display key or provider credentials');
      const { page: owner } = await session('a'); await owner.goto(origins.a + '/portal/', { waitUntil: 'networkidle' });
      const scoped = await owner.evaluate(async foreignID => {
        const response = await fetch('/user/api/audit?target_id=' + encodeURIComponent(foreignID));
        return { status: response.status, body: await response.json() };
      }, seed.keys.b.key.id);
      assert.equal(scoped.status, 200); assert.ok((scoped.body.events ?? []).every(event => event.target_id !== seed.keys.b.key.id));
      assert.ok(!(await owner.locator('main').innerText()).includes(seed.keys.b.token)); row.foreignAuditVisible = false;
    });
    await test('portal-settings-show-private-activity-and-admin-off-inherit-automation-roundtrips', async row => {
      const { page: owner } = await session('a'); await owner.goto(origins.a + '/portal/#/settings', { waitUntil: 'networkidle' });
      await owner.getByRole('heading', { name: 'Private portal session', exact: true }).waitFor();
      await owner.getByRole('heading', { name: 'Your operational activity', exact: true }).waitFor();
      await owner.getByRole('table').getByText('api_key.create', { exact: true }).first().waitFor();
      const ownActivity = await owner.getByRole('main').innerText();
      assert.ok(!ownActivity.includes(seed.keys.b.key.id) && !ownActivity.includes(seed.keys.b.token));
      const { page: administrator } = await session('admin'); await administrator.goto(origins.admin + '/console/#/settings', { waitUntil: 'networkidle' });
      await administrator.getByRole('heading', { name: 'Automatic anonymous providers', exact: true }).waitFor();
      const defaultState = await administrator.evaluate(async () => { const response = await fetch('/admin/api/settings/anonymous-provider-automation'); return { status: response.status, body: await response.json() }; });
      assert.equal(defaultState.status, 200); assert.equal(defaultState.body.deployment_default, false, 'this fixture must never activate an external-provider sweep');
      const form = administrator.locator('form.provider-automation__form');
      const choice = form.getByRole('combobox', { name: 'Connection and verification', exact: true }); await choice.selectOption('off');
      const saved = administrator.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/admin/api/settings/anonymous-provider-automation');
      await form.getByRole('button', { name: 'Save automation setting', exact: true }).click(); assert.equal((await saved).status(), 200);
      await administrator.reload({ waitUntil: 'networkidle' }); assert.equal(await choice.inputValue(), 'off');
      await choice.selectOption('inherit'); const restored = administrator.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/admin/api/settings/anonymous-provider-automation');
      await form.getByRole('button', { name: 'Save automation setting', exact: true }).click(); assert.equal((await restored).status(), 200);
      await administrator.reload({ waitUntil: 'networkidle' }); assert.equal(await choice.inputValue(), 'inherit');
      await administrator.getByText('Effective: Off', { exact: true }).waitFor(); row.privateActivity = true; row.inheritedOffRestored = true;
    });
    await test('owner-usage-quota-advisory-never-promotes-unverified-zero-to-a-limit', async row => {
      for (const actor of ['a', 'b']) {
        const { page } = await session(actor); await page.goto(origins[actor] + '/portal/#/usage', { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: 'Usage & quotas', exact: true }).waitFor();
        const quota = page.locator('article.metric-card').filter({ hasText: 'Provider quota' }); await quota.getByText('Unknown', { exact: true }).waitFor();
        const advisory = page.getByRole('heading', { name: 'Verified limits only', exact: true }).locator('xpath=ancestor::section[1]');
        if (phase === 'restart') {
          const owned = advisory.locator('table tbody tr').filter({ hasText: 'quota-advisory' }); await owned.waitFor();
          assert.match(await owned.innerText(), /Unknown/);
          assert.ok(!(await owned.innerText()).includes('Verified 0'), 'a synthetic zero allowance is not a verified quota');
        } else assert.equal(await advisory.locator('table tbody tr').filter({ hasText: 'quota-advisory' }).count(), 0);
      }
      row.verifiedLimitClaimed = false;
    });
    await test('portal-tool-result-uses-actual-returned-identity-and-substantive-followup', async row => {
      const { page } = await session('a'); await page.goto(origins.a + '/portal/#/playground', { waitUntil: 'networkidle' }); await page.getByRole('heading', { name: 'Playground', exact: true }).waitFor();
      await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption(seed.project.id);
      const combo = page.locator('.model-combo input'); await combo.fill('iam-tools/fixture'); const option = page.locator('.model-combo [role="option"]', { hasText: 'iam-tools/fixture' }).first(); await option.waitFor(); await option.dispatchEvent('mousedown');
      await page.locator('details.playground-tools > summary').click();
      const definitions = [{ type: 'function', function: { name: conversation.tool.name, parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } }];
      await page.getByLabel('Tool definitions (JSON array)', { exact: true }).fill(JSON.stringify(definitions));
      const composer = page.locator('.chat-composer textarea[placeholder^="Send a message"]'); await composer.fill('lookup fixture');
      const path = '/user/api/playground/v1/chat/completions'; const firstResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === path); await page.getByRole('button', { name: 'Send', exact: true }).click(); const first = await firstResponse;
      const firstPayload = playgroundPayload(first.headers()['content-type'], await first.text()); assert.equal(first.status(), 200); const call = firstPayload.raw_response?.choices?.[0]?.message?.tool_calls?.[0]; assert.equal(call?.id, conversation.tool.id); assert.equal(call.function.name, conversation.tool.name);
      let submittedRequests = 0; page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === path) submittedRequests++; });
      await page.getByLabel('Tool call ID', { exact: true }).fill('unrelated-tool-call'); await page.getByLabel('Tool result for follow-up (optional)', { exact: true }).fill(conversation.tool.result); await composer.fill('Use this tool result.');
      await page.getByRole('button', { name: 'Send', exact: true }).click(); await page.getByText('The tool result must match a pending call in the last provider answer.', { exact: true }).waitFor(); assert.equal(submittedRequests, 0, 'an unrelated result must be refused before a request or state mutation');
      await page.getByLabel('Tool call ID', { exact: true }).fill(call.id);
      const secondResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === path); await page.getByRole('button', { name: 'Send', exact: true }).click(); const second = await secondResponse;
      const submitted = second.request().postDataJSON(); const assistant = submitted.messages.findIndex(item => item.role === 'assistant' && item.tool_calls?.some(tool => tool.id === call.id)); const tool = submitted.messages.findIndex(item => item.role === 'tool' && item.tool_call_id === call.id);
      assert.equal(tool, assistant + 1, 'actual tool result must immediately follow its assistant call, before any followup user note');
      const payload = playgroundPayload(second.headers()['content-type'], await second.text()); assert.equal(second.status(), 200); assert.equal(payload.raw_response?.choices?.[0]?.message?.content, conversation.text);
      await page.locator('.chat-turn--assistant').getByText(conversation.text, { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Tool result for follow-up (optional)', { exact: true }).inputValue(), '');
      await composer.fill('One more turn.'); const thirdResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === path); await page.getByRole('button', { name: 'Send', exact: true }).click(); const third = await thirdResponse;
      assert.equal(third.request().postDataJSON().messages.filter(item => item.role === 'tool').length, 1, 'later history must keep exactly the actual resolved result');
      const last = playgroundPayload(third.headers()['content-type'], await third.text()); assert.equal(third.status(), 200); assert.equal(last.raw_response?.choices?.[0]?.message?.content, conversation.text); row.actualToolId = call.id; row.finalAnswer = conversation.text; row.laterHistoryRetained = true;
    });
    await test('owner-raw-response-overflow-is-keyboard-reachable-and-axe-clean-after-actual-result', async row => {
      const { page } = await session('a');
      const pane = page.locator('.raw-response pre'); await pane.waitFor();
      const measurements = await pane.evaluate(element => ({ tabIndex: element.tabIndex, overflow: element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth }));
      assert.equal(measurements.tabIndex, 0); assert.equal(measurements.overflow, true, 'audit the actually overflowing raw result that failed the original browser run');
      await page.locator('.raw-response summary').focus(); await page.keyboard.press('Tab');
      assert.equal(await pane.evaluate(element => document.activeElement === element), true, 'a real keyboard Tab must reach the scrollable response pane');
      await page.addScriptTag({ url: origins.a + '/__qualification__/axe.min.js' });
      const audit = await page.evaluate(async () => { const report = await window.axe.run(document.querySelector('.playground-outcome'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }); return { version: window.axe.version, violations: report.violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) })) }; });
      assert.equal(audit.version, '4.11.0'); assert.deepEqual(audit.violations, []); row.keyboardFocusedOverflow = true; row.affectedViewAudit = audit;
    });
    await test('portal-backend-refusal-retains-safe-status-and-readable-recovery', async row => {
      const { page } = await session('a'); await page.goto(origins.a + '/portal/#/playground', { waitUntil: 'networkidle' }); await page.getByRole('heading', { name: 'Playground', exact: true }).waitFor();
      await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption(seed.project.id); const combo = page.locator('.model-combo input'); await combo.fill('iam-chat/blocked');
      const option = page.locator('.model-combo [role="option"]', { hasText: 'iam-chat/blocked' }).first(); await option.waitFor(); await option.dispatchEvent('mousedown');
      await page.locator('.chat-composer textarea[placeholder^="Send a message"]').fill('identity'); const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/user/api/playground/v1/chat/completions'); await page.getByRole('button', { name: 'Send', exact: true }).click(); const response = await responsePromise;
      assert.equal(response.status(), 402); await page.getByText('Request failed', { exact: true }).waitFor(); await page.getByText('HTTP 402', { exact: true }).first().waitFor();
      assert.ok(!(await page.locator('.playground-outcome').innerText()).includes('fixture-iam-a-one')); row.status = 402; row.failureIsExplicit = true;
    });
    await test('owner-playground-shows-actual-chat-trace-and-usage', async row => {
      const { page } = await session('a'); await page.goto(origins.a + '/portal/#/playground', { waitUntil: 'networkidle' }); await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption(seed.project.id);
      const combo = page.locator('.model-combo input'); await combo.fill('iam-chat/fixture');
      await page.locator('.model-combo [role="option"]', { hasText: 'iam-chat/fixture' }).first().dispatchEvent('mousedown');
      await page.getByText('Catalog freshness', { exact: true }).waitFor();
      await page.getByRole('checkbox', { name: 'Stream the answer', exact: true }).uncheck();
      await page.locator('.chat-composer textarea[placeholder^="Send a message"]').fill('identity');
      const served = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/user/api/playground/v1/chat/completions');
      await page.getByRole('button', { name: 'Send', exact: true }).click(); assert.equal((await served).status(), 200);
      await page.locator('.chat-turn--assistant').getByText('credential:a-one', { exact: true }).waitFor();
      const outcome = page.locator('.playground-outcome'); await outcome.getByText('Input tokens', { exact: true }).waitFor();
      await outcome.getByText('Output tokens', { exact: true }).waitFor(); await outcome.getByText('Fallback attempts', { exact: true }).waitFor();
      await outcome.getByText(/Fallback and exclusion diagnostics|No fallback was needed/).waitFor();
      assert.ok(!(await outcome.innerText()).includes('fixture-iam-a-one')); row.nativeChatVisible = true; row.traceRendered = true;
    });
    await test('owner-playground-stream-stop-retains-partial-answer-and-cancels-source', async row => {
      const { page: administrator } = await session('admin');
      const setup = await administrator.evaluate(async ownerID => { const headers = { 'Content-Type': 'application/json' }; const provider = await fetch('/admin/api/providers', { method: 'POST', headers, body: JSON.stringify({ id: 'browser-gap-source', registry_id: 'openrouter', base_url: 'http://upstream:18889/browser-gap/v1', api_key: 'fixture-browser-gap-key' }) }); const connected = await fetch('/admin/api/principals/' + ownerID + '/connections', { method: 'POST', headers, body: JSON.stringify({ provider_id: 'browser-gap-source', connection_name: 'browser-gap-owner', credential_kind: 'api_key', secret: 'fixture-browser-gap-key', make_default: true }) }); const refresh = await fetch('/admin/api/providers/browser-gap-source/refresh?principal_id=' + encodeURIComponent(ownerID), { method: 'POST', headers, body: '{}' }); return [provider.status, connected.status, refresh.status]; }, seed.actors.a.id);
      assert.ok(setup[0] === 200 && [200, 201].includes(setup[1]) && setup[2] === 200, JSON.stringify(setup));
      const { page } = await session('a'); await page.goto(origins.a + '/portal/#/playground', { waitUntil: 'networkidle' }); await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption(seed.project.id);
      const owned = await page.evaluate(async projectID => { const response = await fetch('/user/api/models?project_id=' + encodeURIComponent(projectID)); return { status: response.status, rows: (await response.json()).data?.filter(item => item.id.startsWith('browser-gap-source/') || item.id === 'iam-chat/fixture').map(item => ({ id: item.id, owned_by: item.owned_by, capabilities: item.capabilities, supported_surfaces: item.supported_surfaces, native_surfaces: item.native_surfaces, disabled: item.disabled, publication_state: item.publication_state })) ?? [] }; }, seed.project.id);
      assert.ok(owned.rows.some(item => item.id === 'browser-gap-source/stream-hold'), 'owner catalog excluded configured private stream: ' + JSON.stringify(owned));
      const combo = page.locator('.model-combo input'); await combo.fill('browser-gap-source/stream-hold');
      await combo.press('ArrowDown');
      const picker = await page.locator('.model-combo').innerText();
      const pickerState = await combo.evaluate(input => ({ value: input.value, disabled: input.disabled, expanded: input.getAttribute('aria-expanded'), placeholder: input.placeholder }));
      assert.ok(picker.includes('browser-gap-source/stream-hold'), 'scoped model was cataloged but not shown in picker: ' + JSON.stringify(owned) + ' input=' + JSON.stringify(pickerState) + ' picker=' + picker.slice(0, 300));
      await page.locator('.model-combo [role="option"]', { hasText: 'browser-gap-source/stream-hold' }).first().dispatchEvent('mousedown');
      await page.locator('.chat-composer textarea[placeholder^="Send a message"]').fill('begin held stream');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.locator('.chat-turn--assistant').getByText('partial fixture answer', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await page.locator('.chat-turn--assistant').getByText('Stopped', { exact: true }).waitFor();
      await page.locator('.chat-turn--assistant').getByText('partial fixture answer', { exact: true }).waitFor(); row.partialRetained = true;
    });
    await test('owner-playground-post-open-source-cut-retains-client-received-partial-text', async row => {
      const { page } = await session('a'); await page.goto(origins.a + '/portal/#/playground', { waitUntil: 'networkidle' }); await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption(seed.project.id);
      const combo = page.locator('.model-combo input'); await combo.fill('browser-gap-source/stream-post-open-cut'); await combo.press('ArrowDown');
      await page.locator('.model-combo [role="option"]', { hasText: 'browser-gap-source/stream-post-open-cut' }).first().dispatchEvent('mousedown');
      await page.locator('.chat-composer textarea[placeholder^="Send a message"]').fill('post-open cut');
      const client = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/user/api/playground/v1/chat/completions');
      await page.getByRole('button', { name: 'Send', exact: true }).click(); const response = await client;
      await page.locator('.chat-turn--assistant').getByText('partial fixture answer', { exact: true }).waitFor();
      assert.equal(fixtureStreamCut(), 1, 'cut only the one stream whose partial text the browser already rendered');
      const delivered = await response.text(); assert.match(delivered, /partial fixture answer/, 'the client response must contain the actual first delta');
      await page.getByRole('heading', { name: 'Playground request did not complete', exact: true }).waitFor();
      const retained = page.locator('.chat-turn--assistant'); await retained.getByText('partial fixture answer', { exact: true }).waitFor();
      await retained.getByText('Incomplete', { exact: true }).waitFor(); row.clientReceivedPartial = true; row.postOpenFailure = true;
    });
    await test('owner-playground-early-cut-and-source-error-stay-explicit', async row => {
      const { page } = await session('a'); await page.goto(origins.a + '/portal/#/playground', { waitUntil: 'networkidle' }); await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption(seed.project.id);
      const combo = page.locator('.model-combo input');
      await combo.fill('browser-gap-source/stream-cut'); await combo.press('ArrowDown'); await page.locator('.model-combo [role="option"]', { hasText: 'browser-gap-source/stream-cut' }).first().dispatchEvent('mousedown');
      await page.locator('.chat-composer textarea[placeholder^="Send a message"]').fill('partial stream');
      const client = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/user/api/playground/v1/chat/completions');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const response = await client; const delivered = await response.text(); row.earlyCut = { status: response.status(), clientReceivedPartial: delivered.includes('partial fixture answer') };
      assert.equal(row.earlyCut.clientReceivedPartial, true, 'the early cutoff also reached the client with one nonterminal delta');
      await page.getByRole('heading', { name: 'Playground request did not complete', exact: true }).waitFor();
      await page.locator('.chat-turn--assistant').getByText('partial fixture answer', { exact: true }).waitFor();
      await page.locator('.chat-turn--assistant').getByText('Incomplete', { exact: true }).waitFor();
      assert.match(await page.getByRole('main').innerText(), /stream ended before|incomplete|did not complete/i);
      await combo.fill('browser-gap-source/stream-error'); await combo.press('ArrowDown'); await page.locator('.model-combo [role="option"]', { hasText: 'browser-gap-source/stream-error' }).first().dispatchEvent('mousedown');
      await page.locator('.chat-composer textarea[placeholder^="Send a message"]').fill('source error');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByText('Request failed', { exact: true }).waitFor();
      assert.ok(!(await page.locator('.playground-outcome').innerText()).includes('fixture-browser-gap-key')); row.partialFailureVisible = true;
    });
    await test('owner-playground-does-not-expose-admin-only-media-handlers', async row => {
      const { page } = await session('a'); await page.goto(origins.a + '/portal/#/playground', { waitUntil: 'networkidle' });
      await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption(seed.project.id);
      const combo = page.locator('.model-combo input'); await combo.fill('browser-gap-source/fixture-image');
      assert.equal(await page.locator('.model-combo [role="option"]', { hasText: 'browser-gap-source/fixture-image' }).count(), 0);
      await combo.fill('browser-gap-source/fixture-speech');
      assert.equal(await page.locator('.model-combo [role="option"]', { hasText: 'browser-gap-source/fixture-speech' }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Generate image', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Synthesize speech', exact: true }).count(), 0); row.adminOnlyMediaHidden = true;
    });
    await test('owner-key-expiry-editor-uses-browser-timezone-and-server-utc-instant', async row => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Pacific/Auckland', serviceWorkers: 'block' });
      await context.route('**/*', route => new URL(route.request().url()).origin === origins.a ? route.continue() : route.abort('blockedbyclient'));
      try {
        const page = await context.newPage(); await page.goto(origins.a + '/portal/#/keys', { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: 'Create key', exact: true }).click();
        const editor = page.locator('form.key-editor'); await editor.getByRole('combobox', { name: 'Project', exact: true }).selectOption(seed.project.id);
        await editor.getByLabel('Name', { exact: true }).fill('Browser timezone ' + phase);
        const local = await page.evaluate(() => { const date = new Date(Date.now() + 7200000); const pad = value => String(value).padStart(2, '0'); return { value: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`, seconds: Math.floor(date.getTime() / 1000) }; });
        await editor.getByLabel('Expires (optional)', { exact: true }).fill(local.value);
        const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/user/api/keys');
        await editor.getByRole('button', { name: 'Create key', exact: true }).click();
        const response = await responsePromise; assert.equal(response.status(), 200); const created = await response.json(); if (created.token) secrets.add(created.token);
        assert.ok(Math.abs(created.key.expires_at - local.seconds) < 60, 'the stored UTC instant must represent the browser-local expiry');
        await page.getByRole('dialog', { name: 'API key', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
        row.timezone = 'Pacific/Auckland'; row.utcInstant = true;
      } finally { await context.close(); }
    });
    await test('owner-key-stale-editor-cannot-reactivate-a-concurrently-revoked-key', async row => {
      const { page } = await session('a');
      const created = await page.evaluate(async id => { const response = await fetch('/user/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: id, name: 'Browser stale edit' }) }); if (!response.ok) throw new Error('disposable stale key issue: ' + response.status); return response.json(); }, seed.project.id);
      if (created.token) secrets.add(created.token);
      await page.goto(origins.a + '/portal/#/keys', { waitUntil: 'networkidle' });
      await page.getByRole('searchbox', { name: 'Search keys', exact: true }).fill('Browser stale edit');
      await page.getByRole('button', { name: 'Edit Browser stale edit', exact: true }).click();
      const editor = page.locator('form.key-editor'); await editor.waitFor(); await editor.locator('[name="daily_requests"]').fill('9');
      const revoked = await page.evaluate(async id => (await fetch('/user/api/keys/' + id, { method: 'DELETE' })).status, created.key.id); assert.equal(revoked, 200);
      const updated = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/user/api/keys/' + created.key.id + '/update');
      await editor.getByRole('button', { name: 'Save key', exact: true }).click(); const response = await updated;
      const identity = await me(page); assert.equal(identity.body.keys.find(item => item.id === created.key.id)?.status, 'revoked'); row.staleWriteStatus = response.status();
    });
    await test('owner-and-administrator-wcag-automated-audit', async row => {
      for (const name of ['a', 'admin', 'empty']) {
        const { page } = await session(name);
        if (!page.url().startsWith(origins[name] + '/')) await page.goto(origins[name] + (name === 'admin' ? '/console/' : name === 'empty' ? '/portal/#/playground' : '/portal/'), { waitUntil: 'networkidle' });
        await page.addScriptTag({ url: origins[name] + '/__qualification__/axe.min.js' });
        for (const theme of ['light', 'dark']) {
          if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: /^Use (light|dark) theme$/ }).click();
          await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme);
          const audit = await page.evaluate(async () => {
            const results = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
            return { version: window.axe.version, violations: results.violations.map(item => ({ id: item.id, impact: item.impact, help: item.help, nodes: item.nodes.map(node => ({ target: node.target, failureSummary: node.failureSummary })) })), passes: results.passes.length };
          });
          result.audits.push({ actor: name, theme, ...audit }); assert.equal(audit.version, '4.11.0');
        }
      }
      assert.deepEqual(result.audits.flatMap(audit => audit.violations), [], 'published WCAG checks must have no violations'); row.auditedPages = result.audits.length;
    });
    assert.deepEqual(result.pageErrors, []); assert.deepEqual(result.blockedOrigins, []);
  } catch (error) { result.error = redact(error.message); }
  finally {
    for (const [name, { page, context }] of Object.entries(sessions)) {
      if (result.error || result.cases.some(row => !row.pass)) {
        try { writeFileSync(join(artifacts, `owner-browser-${phase}-${name}-failure.txt`), redact(await page.locator('body').innerText()), { mode: 0o600 }); await page.screenshot({ path: join(artifacts, `owner-browser-${phase}-${name}-failure.png`), fullPage: true, mask: [page.locator('input,textarea,code,pre.key-secret-value'), ...[...secrets].map(secret => page.getByText(secret, { exact: false }))] }); } catch { /* retain the original result */ }
      }
      await context.close();
    }
    if (browser) await browser.close(); result.pass = !result.error && result.cases.length === 25 && result.cases.every(row => row.pass); save();
  }
  return result;
}
