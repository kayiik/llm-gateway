import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPlaywright } from '../browser-runtime.mjs';
import { mediaWAV } from '../integration/media-fixture.mjs';

export async function runInstalledBrowser({ origin, adminKey, artifacts, phase }) {
  const seed = JSON.parse(readFileSync(join(artifacts, 'state-seed-private.json'), 'utf8'));
  const secrets = [adminKey, 'fixture-bedrock-bearer', ...Object.values(seed.keys).map(item => item.token)];
  const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[temporary-key]'), String(value));
  const result = {
    phase, boundary: 'Real isolated browser; installed administrator console and synthetic preserved state',
    cases: [], pageErrors: [], serverFailures: [], blockedOrigins: [], liveProviderCalls: 0,
  };
  let browser, context, page;
  const browserCase = async (name, run) => {
    try { await run(); result.cases.push({ name, pass: true }); }
    catch (error) { result.cases.push({ name, pass: false, error: redact(error.message), location: page?.url()?.split('#')[1] ?? '', visibleForms: page && !page.isClosed() ? await page.locator('main form').count().catch(() => 0) : 0 }); }
  };
  try {
    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({ headless: true, channel: process.env.LLMGW_BROWSER_CHANNEL || 'chrome' });
    result.browser = { version: browser.version(), channel: process.env.LLMGW_BROWSER_CHANNEL || 'chrome' };
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    context.setDefaultTimeout(12000);
    await context.route('**/*', route => {
      const requested = new URL(route.request().url());
      if (requested.origin === origin) return route.continue();
      if (!result.blockedOrigins.includes(requested.origin)) result.blockedOrigins.push(requested.origin);
      return route.abort('blockedbyclient');
    });
    context.on('page', page => {
      page.on('pageerror', error => result.pageErrors.push(redact(error.message)));
      page.on('response', response => {
        if (response.status() >= 500) result.serverFailures.push({ path: new URL(response.url()).pathname, status: response.status() });
      });
    });
    page = await context.newPage();
    const main = page.getByRole('main');
    const navigation = page.getByRole('navigation', { name: 'Console navigation' });
    const navigate = async (name, title = name) => {
      await navigation.getByRole('button', { name: new RegExp('^' + name) }).click();
      await main.getByRole('heading', { name: title, exact: true }).waitFor();
    };
    const preservedRoute = async () => {
      await main.getByRole('link', { name: / route details$/ }).first().waitFor();
      const search = main.getByRole('searchbox', { name: 'Search routes', exact: true });
      if (await search.count()) await search.fill('preserved-route');
      await main.getByText('preserved-route', { exact: true }).first().waitFor();
    };
    await browserCase('installed-admin-sign-in-and-storage', async () => {
      await page.goto(origin + '/console/', { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: 'Administrator sign-in required' }).waitFor();
      await page.getByLabel('Gateway administrator key').fill('synthetic-invalid-administrator-key');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByText('Invalid administrator key. Check the value and try again.', { exact: true }).waitFor();
      await page.getByLabel('Gateway administrator key').fill(adminKey);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await navigation.waitFor();
      await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(key => ({
        session: sessionStorage.getItem('llmgw.console.static-admin-key') === key,
        local: localStorage.getItem('llmgw.console.static-admin-key'),
      }), adminKey), { session: true, local: null });
    });
    await browserCase('installed-admin-overview-uses-observed-counts-and-trusted-sso-state', async () => {
      await main.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
      const observed = await page.evaluate(async () => {
        const key = sessionStorage.getItem('llmgw.console.static-admin-key');
        const response = await fetch('/admin/api/state', { headers: { Authorization: 'Bearer ' + key } });
        const state = await response.json();
        return { status: response.status, providers: state.providers?.length ?? 0, routes: Object.keys(state.endpoints ?? {}).length, sso: state.sso?.enabled, catalogReady: state.providers?.some(item => Number(item.models) > 0) };
      });
      assert.equal(observed.status, 200);
      assert.equal(await main.getByRole('button', { name: 'Open Configured providers', exact: true }).locator('strong').innerText(), String(observed.providers));
      assert.equal(await main.getByRole('button', { name: 'Open Fallback routes', exact: true }).locator('strong').innerText(), String(observed.routes));
      assert.equal(observed.sso, true); await main.getByText('SSO enabled', { exact: true }).waitFor();
      await main.getByRole('heading', { name: observed.catalogReady ? 'Run a gateway request' : 'Review provider readiness', exact: true }).waitFor();
    });
    await browserCase('installed-admin-session-isolation', async () => {
      const other = await context.newPage();
      try {
        await other.goto(origin + '/console/', { waitUntil: 'networkidle' });
        await other.getByRole('heading', { name: 'Administrator sign-in required' }).waitFor();
        assert.equal(await other.evaluate(() => sessionStorage.getItem('llmgw.console.static-admin-key')), null);
        assert.equal((await other.request.get(origin + '/admin/api/state')).status(), 401);
      } finally { await other.close(); }
      await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
    });
    await browserCase('installed-admin-preserved-catalog', async () => {
      await navigate('Providers');
      await main.getByPlaceholder('Search name, API or instance ID').fill('Groq');
      await main.locator('[data-provider-trigger="groq"]').click();
      await main.getByRole('button', { name: 'Open Groq details', exact: true }).click();
      await main.getByText('preserved-provider', { exact: true }).first().waitFor();
      await navigate('Routes');
      await preservedRoute();
      await navigate('Access');
      await main.getByRole('searchbox', { name: 'Search principals', exact: true }).fill('Preserved human');
      await main.getByRole('table', { name: 'Principals', exact: true }).getByText('Preserved human', { exact: true }).waitFor();
      const projects = main.locator('section').filter({ has: page.getByRole('table', { name: 'Projects', exact: true }) });
      const size = projects.getByRole('combobox', { name: 'Rows per page', exact: true });
      if (await size.count()) await size.selectOption('100');
      await projects.getByText('Preserved project', { exact: true }).waitFor();
      await page.screenshot({ path: join(artifacts, `browser-${phase}-desktop.png`), fullPage: true });
    });
    await browserCase('installed-provider-selected-owner-model-handoff-to-playground', async () => {
      const refreshed = await page.evaluate(async id => { const key = sessionStorage.getItem('llmgw.console.static-admin-key'); return (await fetch('/admin/api/providers/preserved-provider/refresh?principal_id=' + encodeURIComponent(id), { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: '{}' })).status; }, seed.human.id);
      assert.equal(refreshed, 200);
      await navigate('Providers');
      await main.getByPlaceholder('Search name, API or instance ID').fill('Groq');
      const trigger = main.locator('[data-provider-trigger="groq"]');
      if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
      await main.getByRole('button', { name: 'Open Groq details', exact: true }).click();
      await main.getByRole('heading', { name: 'Models from this provider', exact: true }).waitFor();
      await main.getByRole('combobox', { name: 'Catalog owner', exact: true }).selectOption(seed.human.id);
      const models = main.getByRole('heading', { name: 'Models from this provider', exact: true }).locator('xpath=ancestor::section[1]');
      const selected = models.getByRole('row').filter({ hasText: 'preserved-provider/fixture' }); await selected.waitFor();
      await selected.getByRole('button', { name: 'Try in Playground', exact: true }).click();
      await main.getByRole('heading', { name: 'Playground', exact: true }).waitFor();
      await main.locator('.playground-settings__toggle').getByText('preserved-provider/fixture', { exact: true }).waitFor();
      await main.locator('.playground-settings__toggle').click();
      assert.equal(await main.getByRole('combobox', { name: 'Human owner', exact: true }).inputValue(), seed.human.id);
      await navigate('Access');
    });
    await browserCase('installed-project-detail-saves-budget-and-allowlist-without-mutating-seeded-project', async () => {
      const name = 'Browser policy ' + phase, slug = 'browser-policy-' + phase;
      await navigate('Access');
      await main.getByRole('button', { name: 'New project', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'New project', exact: true }); await dialog.waitFor();
      await dialog.getByLabel('Slug', { exact: true }).fill(slug); await dialog.getByLabel('Name (optional)', { exact: true }).fill(name);
      await dialog.getByRole('button', { name: 'Create project', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      await main.getByRole('button', { name: 'Open ' + name, exact: true }).click();
      await main.getByRole('heading', { name, exact: true }).waitFor();
      const form = main.locator('form.policy-editor'); await form.getByLabel('Daily requests').fill('3');
      await form.getByLabel('Allowed providers (comma-separated, empty = all)', { exact: true }).fill('iam-chat');
      await form.getByLabel('Allowed models (comma-separated, empty = all)', { exact: true }).fill('iam-chat/fixture');
      const saveResponse = page.waitForResponse(response => response.request().method() === 'POST' && /\/admin\/api\/projects\/[^/]+\/policy$/.test(new URL(response.url()).pathname));
      await form.getByRole('button', { name: 'Save project policy', exact: true }).click(); assert.equal((await saveResponse).status(), 200);
      await main.getByRole('status').getByText('Project policy saved. Empty fields mean no limit.', { exact: true }).waitFor();
      await page.reload({ waitUntil: 'networkidle' }); await main.getByRole('heading', { name, exact: true }).waitFor();
      assert.equal(await form.getByLabel('Daily requests').inputValue(), '3');
      assert.equal(await form.getByLabel('Allowed providers (comma-separated, empty = all)', { exact: true }).inputValue(), 'iam-chat');
      await main.getByRole('heading', { name: 'The last 30 days', exact: true }).waitFor();
      await main.getByRole('heading', { name: 'No keys in this project', exact: true }).waitFor();
      await page.goto(origin + '/console/#/access/unknown-disposable-project', { waitUntil: 'networkidle' });
      await main.getByRole('heading', { name: 'Unknown project', exact: true }).waitFor();
      await main.getByRole('button', { name: 'Access', exact: true }).click(); await main.getByRole('heading', { name: 'Access', exact: true }).waitFor();
    });
    await browserCase('installed-bedrock-editor-changes-region-and-endpoint-without-reposting-credential', async () => {
      const created = await page.evaluate(async () => {
        const key = sessionStorage.getItem('llmgw.console.static-admin-key');
        const response = await fetch('/admin/api/providers', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'ui-bedrock', registry_id: 'bedrock', region: 'us-east-1', base_url: 'http://upstream:18889/bedrock/v1', api_key: 'fixture-bedrock-bearer' }) });
        return { status: response.status, text: await response.text() };
      });
      assert.equal(created.status, 200, created.text);
      await page.reload({ waitUntil: 'networkidle' });
      await page.goto(origin + '/console/#/providers/bedrock', { waitUntil: 'networkidle' });
      await main.getByRole('heading', { name: 'Amazon Bedrock', exact: true }).first().waitFor();
      await main.getByRole('button', { name: 'Edit configuration', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Edit Amazon Bedrock', exact: true }); await dialog.waitFor();
      assert.equal(await dialog.getByLabel('API key (leave blank to keep the current credential)').inputValue(), '');
      await dialog.getByLabel('Region', { exact: true }).fill('us-west-2');
      await dialog.locator('details > summary').getByText('Advanced endpoint', { exact: true }).click();
      await dialog.getByLabel('Base URL', { exact: true }).fill('http://upstream:18889/bedrock-alt/v1');
      const saveResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/admin/api/providers');
      await dialog.getByRole('button', { name: 'Save configuration', exact: true }).click();
      const saved = await saveResponse; assert.equal(saved.status(), 200, await saved.text());
      await dialog.waitFor({ state: 'hidden' });
      const stored = await page.evaluate(async () => {
        const key = sessionStorage.getItem('llmgw.console.static-admin-key');
        const response = await fetch('/admin/api/state', { headers: { Authorization: 'Bearer ' + key } });
        return (await response.json()).providers.find(item => item.id === 'ui-bedrock');
      });
      assert.equal(stored.region, 'us-west-2'); assert.equal(stored.base_url, 'http://upstream:18889/bedrock-alt/v1'); assert.equal(stored.api_key_set, true);
      // Editing an endpoint invalidates its old model evidence. Re-discover the
      // new base before invoking a model whose native wire the catalog declares.
      const refreshed = await page.evaluate(async () => {
        const key = sessionStorage.getItem('llmgw.console.static-admin-key');
        const response = await fetch('/admin/api/providers/ui-bedrock/refresh', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: '{}' });
        return response.status;
      });
      assert.equal(refreshed, 200);
      const served = await page.evaluate(async () => {
        const key = sessionStorage.getItem('llmgw.console.static-admin-key');
        const response = await fetch('/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'ui-bedrock/fixture-bedrock', input: 'test saved endpoint and credential' }) });
        return { status: response.status, body: await response.json() };
      });
      assert.equal(served.status, 200, JSON.stringify(served.body)); assert.equal(served.body.output[0].content[0].text, 'bearer-compatible-fixture');
    });
    await browserCase('installed-route-editor-preserves-grant-warning-reference-and-rename-semantics', async () => {
      const refreshed = await page.evaluate(async id => {
        const key = sessionStorage.getItem('llmgw.console.static-admin-key');
        const response = await fetch('/admin/api/providers/preserved-provider/refresh?principal_id=' + encodeURIComponent(id), { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: '{}' });
        return response.status;
      }, seed.human.id);
      assert.equal(refreshed, 200, 'the original owner catalog must be reobserved before route editing');
      await navigate('Routes');
      await page.getByRole('combobox', { name: 'Catalog owner', exact: true }).selectOption(seed.human.id);
      const child = 'browser-child-' + phase, renamed = 'browser-renamed-' + phase, parent = 'browser-parent-' + phase;
      const create = async (name, member) => {
        await main.getByRole('button', { name: 'Create route', exact: true }).click();
        const editor = main.locator('form.route-editor'); await editor.getByLabel('Route name', { exact: true }).fill(name);
        await editor.getByRole('combobox', { name: 'Member 1', exact: true }).selectOption(member);
        await editor.getByRole('checkbox', { name: 'Chat Completions', exact: true }).check();
        const written = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/admin/api/endpoints');
        await editor.getByRole('button', { name: 'Save ordered route', exact: true }).click();
        const saved = await written; assert.equal(saved.status(), 200, await saved.text());
        await main.getByRole('link', { name: 'Open ' + name + ' route details', exact: true }).waitFor();
      };
      await create(child, 'model::preserved-provider::fixture');
      const grant = await page.evaluate(async (input) => {
        const key = sessionStorage.getItem('llmgw.console.static-admin-key');
        const response = await fetch('/admin/api/keys', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
        const value = await response.json(); return { status: response.status, id: value.key?.id };
      }, { project_id: seed.project.id, principal_id: seed.human.id, name: 'Browser route grant', allowed_routes: [child], routes_only: true, allowed_providers: ['preserved-provider'] });
      assert.equal(grant.status, 200); assert.ok(grant.id);
      await main.getByRole('button', { name: 'Edit ' + child, exact: true }).click();
      const editor = main.locator('form.route-editor'); await editor.getByLabel('Route name', { exact: true }).fill(renamed);
      await editor.getByText(`Saving renames ${child} to ${renamed}: the new route is created, then ${child} is deleted.`, { exact: true }).waitFor();
      const dialogSeen = page.waitForEvent('dialog', { timeout: 12000 });
      const saveRename = editor.getByRole('button', { name: 'Save ordered route', exact: true }).click();
      const confirmation = await dialogSeen; const warning = confirmation.message(); await confirmation.accept(); await saveRename;
      assert.match(warning, /Browser route grant/); assert.match(warning, /Grants are not moved/);
      await main.getByRole('link', { name: 'Open ' + renamed + ' route details', exact: true }).waitFor();
      assert.equal(await main.getByRole('link', { name: 'Open ' + child + ' route details', exact: true }).count(), 0);
      await create(parent, 'route::' + renamed);
      page.once('dialog', dialog => { void dialog.accept(); });
      const blocked = page.waitForResponse(response => response.request().method() === 'DELETE' && new URL(response.url()).pathname.endsWith('/endpoints/' + renamed));
      await main.getByRole('button', { name: 'Delete ' + renamed, exact: true }).click(); assert.equal((await blocked).status(), 409);
      await main.getByRole('link', { name: 'Open ' + renamed + ' route details', exact: true }).waitFor();
      const state = await page.evaluate(async id => {
        const key = sessionStorage.getItem('llmgw.console.static-admin-key');
        const response = await fetch('/admin/api/keys?project_id=' + encodeURIComponent(id) + '&limit=100', { headers: { Authorization: 'Bearer ' + key } });
        return (await response.json()).keys.map(item => ({ id: item.id, allowed: item.allowed_routes ?? [] }));
      }, seed.project.id);
      assert.deepEqual(state.find(item => item.id === grant.id)?.allowed, [child], 'route rename cannot silently migrate grants');
    });
    await browserCase('installed-route-editor-saves-ordered-members-and-explicit-adaptation', async () => {
      await page.goto(origin + '/console/#/routes', { waitUntil: 'networkidle' });
      await main.getByRole('heading', { name: 'Routes', exact: true }).waitFor();
      await page.getByRole('combobox', { name: 'Catalog owner', exact: true }).selectOption(seed.human.id);
      await main.getByRole('button', { name: 'Create route', exact: true }).first().click();
      const editor = main.locator('form.route-editor'), name = 'browser-ordered-' + phase;
      await editor.getByLabel('Route name', { exact: true }).fill(name);
      await editor.getByRole('combobox', { name: 'Member 1', exact: true }).selectOption('model::preserved-provider::fixture');
      await editor.getByRole('button', { name: 'Add member', exact: true }).click();
      await editor.getByRole('combobox', { name: 'Member 2', exact: true }).selectOption('route::browser-renamed-' + phase);
      await editor.locator('.route-editor__member').nth(1).getByRole('button', { name: 'Move member up', exact: true }).click();
      assert.equal(await editor.getByRole('combobox', { name: 'Member 1', exact: true }).inputValue(), 'route::browser-renamed-' + phase);
      await editor.getByRole('checkbox', { name: 'Chat Completions', exact: true }).check();
      await editor.getByRole('checkbox', { name: 'Allow compatible mappings', exact: true }).check();
      const saved = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/admin/api/endpoints');
      await editor.getByRole('button', { name: 'Save ordered route', exact: true }).click(); assert.equal((await saved).status(), 200);
      const state = await page.evaluate(async () => { const key = sessionStorage.getItem('llmgw.console.static-admin-key'); return (await (await fetch('/admin/api/state', { headers: { Authorization: 'Bearer ' + key } })).json()).endpoints; });
      assert.deepEqual(state[name].failover.map(item => item.route ?? item.provider + '/' + item.model), ['browser-renamed-' + phase, 'preserved-provider/fixture']);
      assert.equal(state[name].allow_adaptation, true); assert.deepEqual(state[name].ingress, ['/v1/chat/completions']);
    });
    await browserCase('installed-route-rename-reports-partial-delete-with-both-routes-preserved', async () => {
      await page.goto(origin + '/console/#/routes', { waitUntil: 'networkidle' });
      const oldName = 'browser-renamed-' + phase, newName = 'browser-partial-' + phase;
      await main.getByRole('button', { name: 'Edit ' + oldName, exact: true }).click();
      const editor = main.locator('form.route-editor'); await editor.getByLabel('Route name', { exact: true }).fill(newName);
      page.once('dialog', dialog => { void dialog.accept(); });
      const deleted = page.waitForResponse(response => response.request().method() === 'DELETE' && new URL(response.url()).pathname.endsWith('/endpoints/' + oldName));
      await editor.getByRole('button', { name: 'Save ordered route', exact: true }).click(); assert.equal((await deleted).status(), 409);
      await main.getByRole('status').getByText(new RegExp(`${newName} was created, but ${oldName} could not be deleted`)).waitFor();
      const state = await page.evaluate(async () => { const key = sessionStorage.getItem('llmgw.console.static-admin-key'); return (await (await fetch('/admin/api/state', { headers: { Authorization: 'Bearer ' + key } })).json()).endpoints; });
      assert.ok(state[oldName] && state[newName], 'a partial rename must retain both callable route records for explicit repair');
    });
    await browserCase('installed-project-policy-rejects-invalid-numeric-draft-and-membership-authoring-is-scoped', async () => {
      const project = await page.evaluate(async slug => { const key = sessionStorage.getItem('llmgw.console.static-admin-key'); const state = await (await fetch('/admin/api/state', { headers: { Authorization: 'Bearer ' + key } })).json(); return state.projects.find(item => item.slug === slug); }, 'browser-policy-' + phase);
      assert.ok(project?.id); await page.goto(origin + '/console/#/access/' + project.id, { waitUntil: 'networkidle' });
      await main.getByRole('heading', { name: 'Browser policy ' + phase, exact: true }).waitFor();
      const policyStatus = await page.evaluate(async id => { const key = sessionStorage.getItem('llmgw.console.static-admin-key'); return (await fetch('/admin/api/projects/' + id + '/policy', { headers: { Authorization: 'Bearer ' + key } })).status; }, project.id);
      assert.equal(policyStatus, 200, 'the project policy form must have a readable installed source');
      let writes = 0; const onRequest = request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/admin/api/projects/' + project.id + '/policy') writes++; };
      page.on('request', onRequest);
      try {
        const form = main.locator('form.policy-editor'); await form.getByLabel('Daily requests').fill('-2');
        await form.getByRole('button', { name: 'Save project policy', exact: true }).click();
        await form.getByRole('alert').getByText('Daily requests must be a nonnegative whole number.', { exact: true }).waitFor(); assert.equal(writes, 0);
        await form.getByLabel('Daily requests').fill('3');
      } finally { page.off('request', onRequest); }
      await main.getByRole('button', { name: 'Add member', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Add member', exact: true }); await dialog.waitFor();
      await dialog.getByRole('button', { name: 'Save membership', exact: true }).click(); await dialog.getByRole('alert').getByText('Select a principal.', { exact: true }).waitFor();
      const searchPrincipals = dialog.getByRole('searchbox', { name: 'Search principals', exact: true });
      if (await searchPrincipals.count()) await searchPrincipals.fill('Preserved human');
      await dialog.getByRole('combobox', { name: 'Principal', exact: true }).selectOption(seed.human.id, { timeout: 30000 });
      await dialog.getByRole('combobox', { name: 'Role', exact: true }).selectOption('member');
      await dialog.getByRole('button', { name: 'Save membership', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      await main.getByRole('table', { name: 'Members of Browser policy ' + phase, exact: true }).getByText('Preserved human', { exact: true }).waitFor();
      const membership = await page.evaluate(async id => { const key = sessionStorage.getItem('llmgw.console.static-admin-key'); return (await (await fetch('/admin/api/state', { headers: { Authorization: 'Bearer ' + key } })).json()).memberships.filter(item => item.project_id === id); }, project.id);
      assert.deepEqual(membership.map(item => [item.principal_id, item.role]), [[seed.human.id, 'member']]);
      await main.getByRole('button', { name: 'Manage keys', exact: true }).click();
      await main.getByRole('heading', { name: 'API keys', exact: true }).waitFor();
      for (const [kind, ownerID] of [['human', seed.human.id], ['service', '']]) {
        await main.getByRole('button', { name: 'Create key', exact: true }).first().click();
        const keyEditor = main.locator('form.key-editor'); await keyEditor.getByRole('combobox', { name: 'Project', exact: true }).selectOption(project.id);
        await keyEditor.getByRole('combobox', { name: 'Acts as', exact: true }).selectOption(ownerID);
        await keyEditor.getByLabel('Name', { exact: true }).fill('Browser policy ' + kind + ' ' + phase);
        const issued = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/admin/api/keys');
        await keyEditor.getByRole('button', { name: 'Create key', exact: true }).click();
        const response = await issued; assert.equal(response.status(), 200); const created = await response.json();
        if (created.token) secrets.push(created.token);
        assert.equal(created.key.project_id, project.id);
        if (kind === 'human') assert.equal(created.key.principal_id, seed.human.id);
        else assert.notEqual(created.key.principal_id, seed.human.id);
        await page.getByRole('dialog', { name: 'API key', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
        await keyEditor.waitFor({ state: 'hidden' });
        const name = 'Browser policy ' + kind + ' ' + phase;
        const keyRow = main.getByRole('table', { name: 'API keys' }).getByRole('row').filter({ hasText: name });
        await keyRow.getByText(kind === 'human' ? 'Human' : 'Service', { exact: true }).waitFor();
        const inspected = page.waitForResponse(reply => reply.request().method() === 'GET' && new URL(reply.url()).pathname.endsWith('/keys/' + created.key.id + '/access'));
        await keyRow.getByRole('button', { name: 'Inspect access for ' + name }).click();
        const access = await inspected; assert.equal(access.status(), 200);
        const snapshot = await access.json();
        assert.equal(snapshot.status, 'active'); assert.equal(snapshot.principal_kind, kind);
        assert.ok(!JSON.stringify(snapshot).includes(created.token), 'the access snapshot must never reveal the key');
        const inspector = main.getByRole('region', { name: 'Effective access for ' + name });
        await inspector.getByRole('heading', { name: 'Current access · ' + name }).waitFor();
        await inspector.getByText('No provider request is sent.', { exact: false }).waitFor();
        await inspector.getByRole('button', { name: 'Close access inspector' }).click();
      }
    });
    await browserCase('installed-alert-editor-validates-and-persists-disabled-rule-without-delivery', async () => {
      await page.goto(origin + '/console/#/alerts', { waitUntil: 'networkidle' });
      await main.getByRole('heading', { name: 'Alerts', exact: true }).waitFor();
      await main.getByRole('button', { name: 'New rule', exact: true }).click();
      const editor = main.locator('form.alert-editor'); await editor.locator('select').first().selectOption('key_expiry');
      const alertProjectID = await page.evaluate(async slug => { const key = sessionStorage.getItem('llmgw.console.static-admin-key'); const state = await (await fetch('/admin/api/state', { headers: { Authorization: 'Bearer ' + key } })).json(); return state.projects.find(item => item.slug === slug)?.id; }, 'browser-policy-' + phase);
      assert.ok(alertProjectID); await editor.getByRole('combobox', { name: 'Project scope', exact: true }).selectOption(alertProjectID);
      await editor.getByLabel('Warning days').fill('-1');
      let writes = 0; const onRequest = request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/admin/api/alerts') writes++; };
      page.on('request', onRequest);
      try {
        await editor.getByRole('button', { name: 'Create rule', exact: true }).click();
        await main.getByText('Expiry warning days must be a positive whole number.', { exact: true }).waitFor(); assert.equal(writes, 0);
        await editor.getByLabel('Warning days').fill('2');
        const saved = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/admin/api/alerts');
        await editor.getByRole('button', { name: 'Create rule', exact: true }).click(); assert.ok([200, 201].includes((await saved).status()));
      } finally { page.off('request', onRequest); }
      await main.getByRole('status').getByText('Alert rule created.', { exact: true }).waitFor();
      const disable = main.getByRole('button', { name: 'Disable Key expiry alert', exact: true }).first();
      await disable.click(); await main.getByRole('status').getByText('Alert rule disabled.', { exact: true }).waitFor();
      const rules = await page.evaluate(async () => { const key = sessionStorage.getItem('llmgw.console.static-admin-key'); return (await (await fetch('/admin/api/alerts', { headers: { Authorization: 'Bearer ' + key } })).json()).rules; });
      assert.ok(rules.some(rule => rule.kind === 'key_expiry' && rule.project_id === alertProjectID && rule.enabled === false), 'browser rule must be disabled before shared-suite alert evaluation');
      assert.ok(!(await main.innerText()).includes('fixture-audio-native-key'));
    });
    await browserCase('installed-alert-delivery-filters-distinguish-pending-delivered-and-exhausted', async () => {
      await page.goto(origin + '/console/#/alerts', { waitUntil: 'networkidle' });
      await main.getByRole('heading', { name: 'Deliveries', exact: true }).waitFor();
      const form = main.locator('form.activity-filter');
      const status = form.getByRole('combobox', { name: 'Status', exact: true });
      for (const choice of ['delivered', 'exhausted']) {
        await status.selectOption(choice);
        const searched = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/admin/api/deliveries' && new URL(response.url()).searchParams.get('status') === choice);
        await form.getByRole('button', { name: 'Search', exact: true }).click(); assert.equal((await searched).status(), 200);
        if (phase === 'restart') {
          const listing = main.getByRole('heading', { name: 'Deliveries', exact: true }).locator('xpath=ancestor::section[1]');
          const first = listing.locator('table tbody tr').first(); await first.waitFor();
          assert.match(await listing.locator('table').innerText(), /Attempts/i);
          const detail = await first.innerText();
          if (choice === 'delivered') assert.match(detail, /Delivered[\s\S]*1 of 10/);
          if (choice === 'exhausted') { assert.match(detail, /Exhausted[\s\S]*10 of 10/); assert.ok(!detail.includes('fixture-alert-secret'), 'delivered error copy must never echo a source credential'); }
        } else await main.getByRole('heading', { name: 'No deliveries', exact: true }).waitFor();
      }
      if (phase === 'restart') {
        const queued = await page.evaluate(async slug => {
          const key = sessionStorage.getItem('llmgw.console.static-admin-key'), headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
          const project = (await (await fetch('/admin/api/state', { headers })).json()).projects.find(item => item.slug === slug);
          if (!project) throw new Error('disposable outbox project absent');
          const rule = await fetch('/admin/api/alerts', { method: 'POST', headers, body: JSON.stringify({ kind: 'key_expiry', project_id: project.id, threshold: 1 }) });
          if (!rule.ok) throw new Error('disposable outbox rule: ' + rule.status);
          const ruleID = (await rule.json()).id;
          for (let index = 0; index < 55; index++) {
            const created = await fetch('/admin/api/keys', { method: 'POST', headers, body: JSON.stringify({ project_id: project.id, name: 'Browser outbox page ' + index, expires_at: Math.floor(Date.now() / 1000) + 3600 }) });
            if (!created.ok) throw new Error('disposable outbox key ' + index + ': ' + created.status);
            await created.text();
          }
          const evaluated = await fetch('/admin/api/alerts/evaluate', { method: 'POST', headers, body: '{}' });
          if (!evaluated.ok) throw new Error('disposable outbox evaluation: ' + evaluated.status);
          const enqueued = (await evaluated.json()).enqueued;
          const disabled = await fetch('/admin/api/alerts/status', { method: 'POST', headers, body: JSON.stringify({ id: ruleID, enabled: false }) });
          if (!disabled.ok) throw new Error('disposable outbox rule disable: ' + disabled.status);
          return enqueued;
        }, 'browser-policy-' + phase);
        assert.equal(queued, 55, 'the stopped-only disposable rule must enqueue exactly its own expiring keys');
        await status.selectOption('pending');
        const searched = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/admin/api/deliveries' && new URL(response.url()).searchParams.get('status') === 'pending');
        await form.getByRole('button', { name: 'Search', exact: true }).click(); assert.equal((await searched).status(), 200);
        const older = main.getByRole('button', { name: 'Load older deliveries', exact: true }); await older.click();
        const listing = main.getByRole('heading', { name: 'Deliveries', exact: true }).locator('xpath=ancestor::section[1]');
        await listing.locator('table tbody tr').nth(54).waitFor({ timeout: 12000 });
        assert.ok(await listing.locator('table tbody tr').count() >= 55, 'cursor paging must retain at least the 55 newly enqueued disposable deliveries');
      }
    });
    await browserCase('installed-key-table-pages-and-bulk-deletes-only-disposable-revoked-keys', async () => {
      const project = await page.evaluate(async slug => { const key = sessionStorage.getItem('llmgw.console.static-admin-key'); const state = await (await fetch('/admin/api/state', { headers: { Authorization: 'Bearer ' + key } })).json(); return state.projects.find(item => item.slug === slug); }, 'browser-policy-' + phase);
      assert.ok(project?.id);
      const made = await page.evaluate(async ({ projectID, principalID, marker }) => {
        const auth = sessionStorage.getItem('llmgw.console.static-admin-key'), headers = { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' };
        const ids = [];
        for (let index = 0; index < 52; index++) {
          const issued = await fetch('/admin/api/keys', { method: 'POST', headers, body: JSON.stringify({ project_id: projectID, principal_id: principalID, name: marker + index }) });
          if (!issued.ok) throw new Error('disposable bulk key issue failed: ' + issued.status);
          const value = await issued.json(); ids.push(value.key.id);
          const revoked = await fetch('/admin/api/keys?id=' + encodeURIComponent(value.key.id), { method: 'DELETE', headers }); if (!revoked.ok) throw new Error('disposable bulk key revoke failed: ' + revoked.status);
        }
        return ids;
      }, { projectID: project.id, principalID: seed.human.id, marker: 'Browser bulk ' + phase + ' ' });
      assert.equal(made.length, 52);
      await page.goto(origin + '/console/#/keys/' + encodeURIComponent('project=' + project.id), { waitUntil: 'networkidle' });
      await main.getByRole('heading', { name: 'API keys', exact: true }).waitFor();
      await main.getByRole('combobox', { name: 'Status', exact: true }).selectOption('all');
      await main.getByRole('checkbox', { name: 'Select every revoked or expired key shown', exact: true }).check();
      const selected = main.getByRole('button', { name: /Delete \d+ selected/ }); await selected.waitFor();
      const firstPageCount = Number((await selected.innerText()).match(/\d+/)?.[0]); assert.ok(firstPageCount > 0 && firstPageCount < made.length);
      const deleted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/admin/api/keys/delete');
      page.once('dialog', dialog => { void dialog.accept(); }); await selected.click(); assert.equal((await deleted).status(), 200);
      await main.getByRole('status').getByText(/keys? deleted\./).waitFor();
      await main.getByRole('searchbox', { name: 'Search keys', exact: true }).fill('Browser bulk ' + phase);
      const remaining = await page.evaluate(async ({ projectID, ids }) => { const key = sessionStorage.getItem('llmgw.console.static-admin-key'); const response = await fetch('/admin/api/keys?project_id=' + encodeURIComponent(projectID) + '&status=all&limit=100', { headers: { Authorization: 'Bearer ' + key } }); return (await response.json()).keys.filter(item => ids.includes(item.id)).length; }, { projectID: project.id, ids: made });
      assert.equal(remaining, made.length - firstPageCount, 'a visible-page bulk operation must leave other pages untouched');
    });
    await browserCase('installed-requests-audit-cursors-and-utc-usage-keep-selected-key-scope', async () => {
      const created = await page.evaluate(async () => {
        const auth = sessionStorage.getItem('llmgw.console.static-admin-key'), headers = { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' };
        const provider = await fetch('/admin/api/providers', { method: 'POST', headers, body: JSON.stringify({ id: 'browser-activity', registry_id: 'openrouter', base_url: 'http://upstream:18889/iam/chat/v1', api_key: 'fixture-iam-system' }) });
        if (!provider.ok) throw new Error('activity provider: ' + provider.status);
        const refreshed = await fetch('/admin/api/providers/browser-activity/refresh', { method: 'POST', headers, body: '{}' }); if (!refreshed.ok) throw new Error('activity refresh: ' + refreshed.status);
        const state = await (await fetch('/admin/api/state', { headers })).json();
        let project = state.projects.find(item => item.slug === 'browser-activity');
        if (!project) { const response = await fetch('/admin/api/projects', { method: 'POST', headers, body: JSON.stringify({ slug: 'browser-activity', name: 'Browser activity' }) }); if (!response.ok) throw new Error('activity project: ' + response.status); project = await response.json(); }
        const id = project.id;
        const issued = await fetch('/admin/api/keys', { method: 'POST', headers, body: JSON.stringify({ project_id: id, name: 'Browser activity caller', allowed_providers: ['browser-activity'] }) });
        if (!issued.ok) throw new Error('activity key: ' + issued.status);
        const credential = await issued.json(), ids = [];
        for (let index = 0; index < 55; index++) {
          const response = await fetch('/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + credential.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'browser-activity/fixture', messages: [{ role: 'user', content: 'activity ' + index }] }) });
          if (!response.ok) throw new Error('disposable activity request ' + index + ': ' + response.status);
          ids.push(response.headers.get('x-request-id')); await response.text();
        }
        const limited = await fetch('/admin/api/keys', { method: 'POST', headers, body: JSON.stringify({ project_id: id, name: 'Browser activity limited', allowed_providers: ['browser-activity'], daily_requests: 1 }) });
        if (!limited.ok) throw new Error('limited activity key: ' + limited.status);
        const constrained = await limited.json(); let deniedID = '';
        for (let index = 0; index < 2; index++) {
          const response = await fetch('/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + constrained.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'browser-activity/fixture', messages: [{ role: 'user', content: 'limited activity' }] }) });
          if (index === 0 && response.status !== 200 || index === 1 && response.status !== 429) throw new Error('unexpected constrained request status: ' + response.status);
          if (index === 1) deniedID = response.headers.get('x-request-id'); await response.text();
        }
        return { projectID: id, keyID: credential.key.id, ids, deniedID };
      });
      assert.equal(created.ids.length, 55); assert.ok(created.ids.every(Boolean));
      await page.goto(origin + '/console/#/requests', { waitUntil: 'networkidle' });
      await main.getByRole('heading', { name: 'Requests', exact: true }).waitFor();
      await main.getByRole('button', { name: 'Load older requests', exact: true }).click();
      await main.getByText(created.ids[0], { exact: true }).waitFor();
      await main.getByRole('textbox', { name: 'Request ID', exact: true }).fill(created.ids[0]); await main.getByRole('button', { name: 'Search', exact: true }).click();
      const row = main.locator('table tbody tr').filter({ hasText: created.ids[0] }); await row.waitFor();
      assert.match(await row.innerText(), /browser-activity\/fixture/); assert.match(await row.innerText(), /Browser activity caller/);
      await main.getByRole('textbox', { name: 'Request ID', exact: true }).fill(created.deniedID); await main.getByRole('button', { name: 'Search', exact: true }).click();
      const limited = main.locator('table tbody tr').filter({ hasText: created.deniedID }); await limited.waitFor();
      assert.match(await limited.innerText(), /429/); assert.match(await limited.innerText(), /Browser activity limited/);
      assert.ok(await limited.locator('td').nth(6).locator('span').getAttribute('title'), 'a refusing limit must retain its error-code attribution');
      assert.equal((await limited.locator('td').last().innerText()).trim(), '—', 'a pre-dispatch refusal must not invent source tokens');
      await page.goto(origin + '/console/#/audit', { waitUntil: 'networkidle' }); await main.getByRole('heading', { name: 'Audit log', exact: true }).waitFor();
      await main.getByRole('button', { name: 'Load older events', exact: true }).click();
      assert.ok(!(await main.innerText()).includes('fixture-iam-system'), 'audit pages must not expose provider credentials');
      await page.goto(origin + '/console/#/usage', { waitUntil: 'networkidle' });
      await main.getByRole('combobox', { name: 'Bucket', exact: true }).selectOption('day');
      const searchKey = main.getByRole('searchbox', { name: 'Search keys', exact: true });
      if (await searchKey.count()) await searchKey.fill('Browser activity caller');
      await main.getByRole('combobox', { name: 'Key', exact: true }).selectOption(created.keyID);
      const filteredUsage = page.waitForResponse(response => new URL(response.url()).pathname === '/admin/api/usage' && new URL(response.url()).searchParams.get('key_id') === created.keyID);
      await main.getByRole('button', { name: 'Apply filters', exact: true }).click(); assert.equal((await filteredUsage).status(), 200);
      await main.getByText(/UTC/).first().waitFor();
      await main.getByRole('heading', { name: /by day/i }).waitFor();
      const buckets = await main.locator('.usage-bars .usage-bar strong').allInnerTexts();
      assert.equal(buckets.reduce((sum, value) => sum + Number(value.replaceAll(',', '')), 0), 55, 'the selected key UTC chart must total the 55 actual source requests');
    });
    await browserCase('installed-admin-playground-renders-image-audio-video-and-transcription-on-supported-operations', async () => {
      const configured = await page.evaluate(async phase => {
        const key = sessionStorage.getItem('llmgw.console.static-admin-key'), headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
        const person = await fetch('/admin/api/principals', { method: 'POST', headers, body: JSON.stringify({ kind: 'human', external_subject: 'browser-media-owner-' + phase, display_name: 'Browser media owner ' + phase }) });
        if (!person.ok) throw new Error('disposable media owner: ' + person.status);
        const principalID = (await person.json()).id;
        const created = await fetch('/admin/api/providers', { method: 'POST', headers, body: JSON.stringify({ id: 'browser-admin-media', registry_id: 'openrouter', base_url: 'http://upstream:18889/browser-gap/v1', api_key: 'fixture-browser-gap-key' }) });
        const refreshed = await fetch('/admin/api/providers/browser-admin-media/refresh', { method: 'POST', headers, body: '{}' });
        const imageProvider = await fetch('/admin/api/providers', { method: 'POST', headers, body: JSON.stringify({ id: 'browser-admin-image', registry_id: 'ai_studio', base_url: 'http://upstream:18889/media/studio/v1', api_key: 'fixture-media-key' }) });
        const imageCatalog = await fetch('/admin/api/providers/browser-admin-image/refresh', { method: 'POST', headers, body: '{}' });
        const transcriptProvider = await fetch('/admin/api/providers', { method: 'POST', headers, body: JSON.stringify({ id: 'browser-admin-transcript', registry_id: 'elevenlabs', base_url: 'http://upstream:18889/audio-native/eleven/v1', api_key: 'fixture-audio-native-key' }) });
        const transcriptCatalog = await fetch('/admin/api/providers/browser-admin-transcript/refresh', { method: 'POST', headers, body: '{}' });
        const state = await (await fetch('/admin/api/state', { headers })).json();
        let project = state.projects.find(item => item.slug === 'browser-admin-media-project');
        if (!project) { const response = await fetch('/admin/api/projects', { method: 'POST', headers, body: JSON.stringify({ slug: 'browser-admin-media-project', name: 'Browser admin media' }) }); if (!response.ok) throw new Error('media project: ' + response.status); project = await response.json(); }
        const member = await fetch('/admin/api/memberships', { method: 'POST', headers, body: JSON.stringify({ project_id: project.id, principal_id: principalID, role: 'owner' }) });
        const connection = await fetch('/admin/api/principals/' + principalID + '/connections', { method: 'POST', headers, body: JSON.stringify({ provider_id: 'browser-admin-media', connection_name: 'browser-admin-media-connection', credential_kind: 'api_key', secret: 'fixture-browser-gap-key', make_default: true }) });
        const scoped = await fetch('/admin/api/providers/browser-admin-media/refresh?principal_id=' + encodeURIComponent(principalID), { method: 'POST', headers, body: '{}' });
        const imageConnection = await fetch('/admin/api/principals/' + principalID + '/connections', { method: 'POST', headers, body: JSON.stringify({ provider_id: 'browser-admin-image', connection_name: 'browser-admin-image-connection', credential_kind: 'api_key', secret: 'fixture-media-key', make_default: true }) });
        const imageScoped = await fetch('/admin/api/providers/browser-admin-image/refresh?principal_id=' + encodeURIComponent(principalID), { method: 'POST', headers, body: '{}' });
        const transcriptConnection = await fetch('/admin/api/principals/' + principalID + '/connections', { method: 'POST', headers, body: JSON.stringify({ provider_id: 'browser-admin-transcript', connection_name: 'browser-admin-transcript-connection', credential_kind: 'api_key', secret: 'fixture-audio-native-key', make_default: true }) });
        const transcriptScoped = await fetch('/admin/api/providers/browser-admin-transcript/refresh?principal_id=' + encodeURIComponent(principalID), { method: 'POST', headers, body: '{}' });
        const issued = await fetch('/admin/api/keys', { method: 'POST', headers, body: JSON.stringify({ project_id: project.id, principal_id: principalID, name: 'Browser admin media key', allowed_providers: ['browser-admin-media'] }) });
        return { statuses: [created.status, refreshed.status, imageProvider.status, imageCatalog.status, transcriptProvider.status, transcriptCatalog.status, member.status, connection.status, scoped.status, imageConnection.status, imageScoped.status, transcriptConnection.status, transcriptScoped.status, issued.status], projectID: project.id, principalID };
      }, phase); assert.ok(configured.statuses.every(status => [200, 201].includes(status)), JSON.stringify(configured));
      await page.goto(origin + '/console/#/playground', { waitUntil: 'networkidle' }); await page.reload({ waitUntil: 'networkidle' });
      await main.getByRole('heading', { name: 'Playground', exact: true }).waitFor();
      await main.getByRole('combobox', { name: 'Human owner', exact: true }).selectOption(configured.principalID);
      await main.getByRole('combobox', { name: 'Project', exact: true }).selectOption(configured.projectID);
      const combo = main.locator('.model-combo input'); await combo.fill('browser-admin-image/gemini-3.1-flash-image'); await combo.press('ArrowDown');
      const sourceModels = await page.evaluate(async ({ ownerID, projectID }) => { const key = sessionStorage.getItem('llmgw.console.static-admin-key'); const response = await fetch('/admin/api/models?principal_id=' + encodeURIComponent(ownerID) + '&project_id=' + encodeURIComponent(projectID) + '&diagnostics=1', { headers: { Authorization: 'Bearer ' + key } }); return { status: response.status, rows: (await response.json()).data?.filter(item => item.id.startsWith('browser-admin-image/')).map(item => ({ id: item.id, owned_by: item.owned_by, capabilities: item.capabilities, supported_surfaces: item.supported_surfaces, disabled: item.disabled })) ?? [] }; }, { ownerID: configured.principalID, projectID: configured.projectID });
      const picker = await main.locator('.model-combo').innerText();
      assert.ok(picker.includes('browser-admin-image/gemini-3.1-flash-image'), 'admin scoped picker did not expose the declared image: ' + JSON.stringify(sourceModels) + ' picker=' + picker.slice(0, 300));
      await main.locator('.model-combo [role="option"]', { hasText: 'browser-admin-image/gemini-3.1-flash-image' }).first().dispatchEvent('mousedown');
      await main.getByLabel('Describe the image', { exact: true }).fill('an origami crane');
      const made = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/admin/api/playground/image');
      await main.getByRole('button', { name: 'Generate image', exact: true }).click(); const imageReply = await made; assert.equal(imageReply.status(), 200, await imageReply.text());
      const image = main.getByRole('img', { name: 'Generated result', exact: true }); await image.waitFor(); assert.match(await image.getAttribute('src'), /^data:image\/png;base64,/);
      await combo.fill('browser-admin-media/fixture-speech'); await combo.press('ArrowDown'); await main.locator('.model-combo [role="option"]', { hasText: 'browser-admin-media/fixture-speech' }).first().dispatchEvent('mousedown');
      await main.getByLabel('Text to speak', { exact: true }).fill('Controlled browser audio');
      const spoken = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/admin/api/playground/speech');
      await main.getByRole('button', { name: 'Synthesize speech', exact: true }).click(); const speechReply = await spoken; assert.equal(speechReply.status(), 200, await speechReply.text());
      const audio = main.locator('.playground-audio audio'); await audio.waitFor(); assert.match(await audio.getAttribute('src'), /^data:audio\/wav;base64,/);
      await combo.fill('browser-admin-image/veo-3.0-generate-001'); await combo.press('ArrowDown');
      await main.locator('.model-combo [role="option"]', { hasText: 'browser-admin-image/veo-3.0-generate-001' }).first().dispatchEvent('mousedown');
      await main.getByLabel('Describe the video', { exact: true }).fill('inline');
      const started = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/admin/api/playground/video');
      await main.getByRole('button', { name: 'Generate video', exact: true }).click(); const videoReply = await started; assert.equal(videoReply.status(), 202, await videoReply.text());
      const video = main.locator('.playground-media video'); await video.waitFor({ timeout: 20000 }); assert.match(await video.getAttribute('src'), /^data:video\/mp4;base64,/);
      await combo.fill('browser-admin-transcript/scribe_v2'); await combo.press('ArrowDown');
      await main.locator('.model-combo [role="option"]', { hasText: 'browser-admin-transcript/scribe_v2' }).first().dispatchEvent('mousedown');
      await main.getByLabel('Audio file', { exact: true }).setInputFiles({ name: 'sample.wav', mimeType: 'audio/wav', buffer: mediaWAV });
      const transcript = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/admin/api/playground/transcription');
      await main.getByRole('button', { name: 'Transcribe audio', exact: true }).click(); const transcriptReply = await transcript; assert.equal(transcriptReply.status(), 200, await transcriptReply.text());
      await main.getByText('native-audio-transcript', { exact: true }).waitFor();
    });
    await browserCase('installed-admin-playground-keeps-native-responses-and-messages-modes-distinct', async () => {
      const setup = await page.evaluate(async phase => {
        const key = sessionStorage.getItem('llmgw.console.static-admin-key'), headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
        const post = async (path, body) => { const response = await fetch('/admin/api/' + path, { method: 'POST', headers, body: JSON.stringify(body) }); if (!response.ok) throw new Error(path + ': ' + response.status); return response.json(); };
        const owner = await post('principals', { kind: 'human', external_subject: 'browser-modes-' + phase, display_name: 'Browser modes ' + phase });
        let project = (await (await fetch('/admin/api/state', { headers })).json()).projects.find(item => item.slug === 'browser-modes-project');
        if (!project) project = await post('projects', { slug: 'browser-modes-project', name: 'Browser modes project' });
        await post('memberships', { project_id: project.id, principal_id: owner.id, role: 'owner' });
        for (const [id, registry, family] of [['browser-modes-responses', 'openai', 'openai'], ['browser-modes-messages', 'anthropic', 'anthropic']]) {
          await post('providers', { id, registry_id: registry, base_url: 'http://upstream:18889/clients/' + family + (family === 'openai' ? '/v1' : ''), api_key: 'fixture-client-upstream-key' });
          await post('principals/' + owner.id + '/connections', { provider_id: id, connection_name: id, credential_kind: 'api_key', secret: 'fixture-client-upstream-key', make_default: true });
          await post('providers/' + id + '/refresh?principal_id=' + encodeURIComponent(owner.id), {});
        }
        await post('keys', { project_id: project.id, principal_id: owner.id, name: 'Browser mode owner ' + phase });
        return { ownerID: owner.id, projectID: project.id };
      }, phase);
      await page.goto(origin + '/console/#/playground', { waitUntil: 'networkidle' }); await page.reload({ waitUntil: 'networkidle' });
      await main.getByRole('combobox', { name: 'Human owner', exact: true }).selectOption(setup.ownerID);
      await main.getByRole('combobox', { name: 'Project', exact: true }).selectOption(setup.projectID);
      const combo = main.locator('.model-combo input');
      for (const [model, surface, path] of [
        ['browser-modes-responses/fixture-client-responses', '/v1/responses', '/admin/api/playground/v1/responses'],
        ['browser-modes-messages/fixture-client-messages', '/v1/messages', '/admin/api/playground/v1/messages'],
      ]) {
        await page.reload({ waitUntil: 'networkidle' });
        await main.getByRole('combobox', { name: 'Human owner', exact: true }).selectOption(setup.ownerID);
        await main.getByRole('combobox', { name: 'Project', exact: true }).selectOption(setup.projectID);
        await combo.fill(model); await combo.press('ArrowDown');
        await main.locator('.model-combo [role="option"]', { hasText: model }).first().dispatchEvent('mousedown');
        const surfaceControl = main.getByRole('combobox', { name: 'Text surface', exact: true });
        if (await surfaceControl.count()) await surfaceControl.selectOption(surface);
        await main.getByRole('checkbox', { name: 'Stream the answer', exact: true }).uncheck();
        await main.locator('.chat-composer textarea[placeholder^="Send a message"]').fill('Native mode ' + surface);
        const served = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === path);
        await main.getByRole('button', { name: 'Send', exact: true }).click(); assert.equal((await served).status(), 200);
        await main.locator('.chat-turn--assistant').getByText('fixture-client-ok', { exact: true }).waitFor();
        await main.getByRole('checkbox', { name: 'Stream the answer', exact: true }).check();
        await main.locator('.chat-composer textarea[placeholder^="Send a message"]').fill('Stream native mode ' + surface);
        const streaming = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === path);
        await main.getByRole('button', { name: 'Send', exact: true }).click(); const live = await streaming;
        assert.equal(live.status(), 200); assert.match(live.headers()['content-type'], /text\/event-stream/);
        await main.locator('.chat-turn--assistant').last().getByText('fixture-client-ok', { exact: true }).waitFor();
      }
    });
    await browserCase('installed-admin-preserved-key-metadata', async () => {
      await page.goto(origin + '/console/#/keys/' + encodeURIComponent('project=' + seed.project.id), { waitUntil: 'networkidle' });
      await main.getByRole('heading', { name: 'API keys', exact: true }).waitFor();
      for (const kind of ['human', 'service', 'disabled']) {
        await main.getByRole('cell', { name: 'Preserved ' + kind, exact: true }).and(main.locator('[data-label="Name"]')).waitFor();
      }
      const visible = await main.innerText();
      for (const secret of Object.values(seed.keys).map(item => item.token)) assert.ok(!visible.includes(secret), 'stored key values must not be rendered without an explicit reveal');
    });
    await browserCase('installed-admin-mobile-navigation', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await navigate('Routes');
      await preservedRoute();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'the mobile page must not overflow horizontally');
      await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Open navigation', exact: true }).waitFor({ state: 'visible' });
      await page.screenshot({ path: join(artifacts, `browser-${phase}-mobile.png`), fullPage: true });
      await page.setViewportSize({ width: 1280, height: 900 });
    });
    await browserCase('installed-admin-theme-and-reload', async () => {
      const before = await page.locator('html').getAttribute('data-theme');
      await page.getByRole('button', { name: /^Use (light|dark) theme$/ }).click();
      await page.waitForFunction(previous => document.documentElement.dataset.theme !== previous, before);
      const changed = await page.locator('html').getAttribute('data-theme');
      assert.ok(['light', 'dark'].includes(changed));
      await page.reload({ waitUntil: 'networkidle' });
      assert.equal(await page.locator('html').getAttribute('data-theme'), changed);
      await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
    });
    await browserCase('installed-admin-loaded-state-401-requires-reauthentication-without-persistent-key', async () => {
      const second = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
      try {
        const session = await second.newPage(); await session.goto(origin + '/console/', { waitUntil: 'networkidle' });
        await session.getByLabel('Gateway administrator key').fill(adminKey);
        await session.getByRole('button', { name: 'Sign in', exact: true }).click();
        await session.getByRole('navigation', { name: 'Console navigation' }).waitFor();
        await session.route('**/admin/api/state', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":{"message":"Controlled session expired."}}' }), { times: 1 });
        await session.reload({ waitUntil: 'networkidle' });
        await session.getByRole('heading', { name: 'Administrator sign-in required', exact: true }).waitFor();
        assert.equal(await session.evaluate(() => localStorage.getItem('llmgw.console.static-admin-key')), null);
      } finally { await second.close(); }
    });
    await browserCase('installed-admin-loaded-state-503-keeps-last-good-detail-and-recovers-on-retry', async () => {
      const second = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
      try {
        const session = await second.newPage(); await session.goto(origin + '/console/', { waitUntil: 'networkidle' });
        await session.getByLabel('Gateway administrator key').fill(adminKey);
        const loaded = session.waitForResponse(response => new URL(response.url()).pathname === '/admin/api/state' && response.status() === 200);
        await session.getByRole('button', { name: 'Sign in', exact: true }).click(); await loaded;
        await session.goto(origin + '/console/#/providers/groq', { waitUntil: 'networkidle' });
        await session.getByRole('heading', { name: 'Checks and lifecycle', exact: true }).waitFor();
        const preserved = session.locator('table tbody tr').filter({ hasText: 'preserved-provider' }); await preserved.first().waitFor();
        await session.route('**/admin/api/state', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"message":"Controlled state refresh unavailable."}}' }), { times: 1 });
        const refused = session.waitForResponse(response => new URL(response.url()).pathname === '/admin/api/state' && response.status() === 503);
        await preserved.first().getByRole('button', { name: 'Check reachability', exact: true }).click(); await refused;
        const warning = session.getByRole('alert').filter({ hasText: 'Refresh failed' }); await warning.waitFor();
        await warning.getByText('Showing the last loaded gateway state.', { exact: false }).waitFor();
        await session.getByRole('heading', { name: 'Checks and lifecycle', exact: true }).waitFor();
        const recovered = session.waitForResponse(response => new URL(response.url()).pathname === '/admin/api/state' && response.status() === 200);
        await warning.getByRole('button', { name: 'Retry', exact: true }).click(); await recovered;
        await warning.waitFor({ state: 'hidden' });
      } finally { await second.close(); }
    });
    await browserCase('installed-admin-same-context-401-reauthentication-and-signout', async () => {
      let stage = 'first 401';
      try {
      await page.route('**/admin/api/state', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":{"message":"Controlled session expired."}}' }), { times: 1 });
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: 'Administrator sign-in required', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => sessionStorage.getItem('llmgw.console.static-admin-key')), null);
      stage = 'first reauthentication';
      await page.getByLabel('Gateway administrator key').fill(adminKey);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await navigation.waitFor(); stage = 'post-reauthentication sign-out'; await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.getByRole('heading', { name: 'Administrator sign-in required', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => sessionStorage.getItem('llmgw.console.static-admin-key')), null);
      stage = 'second reauthentication';
      await page.getByLabel('Gateway administrator key').fill(adminKey);
      const reloaded = page.waitForResponse(response => new URL(response.url()).pathname === '/admin/api/state' && response.status() === 200);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await reloaded; await navigation.waitFor();
      } catch (error) {
        const state = await page.evaluate(() => ({ headings: [...document.querySelectorAll('main h1,main h2')].map(item => item.textContent).slice(0, 5), staticKeyPresent: Boolean(sessionStorage.getItem('llmgw.console.static-admin-key')) })).catch(() => ({}));
        throw new Error(stage + ': ' + error.message + ' page=' + JSON.stringify(state));
      }
    });
    await browserCase('installed-admin-sign-out', async () => {
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.getByRole('heading', { name: 'Administrator sign-in required' }).waitFor();
      assert.equal(await page.evaluate(() => sessionStorage.getItem('llmgw.console.static-admin-key')), null);
      assert.equal((await page.request.get(origin + '/admin/api/state')).status(), 401);
    });
    assert.deepEqual(result.pageErrors, [], 'the installed console must not throw browser errors');
    assert.deepEqual(result.serverFailures, [], 'the browser journey must not hide a server failure');
    assert.deepEqual(result.blockedOrigins, [], 'the installed journey must use only its isolated Gateway origin');
  } catch (error) {
    result.error = redact(error.message);
    if (page && !page.isClosed()) {
      try {
        writeFileSync(join(artifacts, `browser-${phase}-failure.txt`), redact(await page.locator('body').innerText()), { mode: 0o600 });
        await page.screenshot({ path: join(artifacts, `browser-${phase}-failure.png`), fullPage: true, mask: [page.locator('input')] });
      } catch { /* retain the original assertion failure */ }
    }
  }
  finally {
    if (context) await context.close();
    if (browser) await browser.close();
    result.pass = !result.error && result.cases.length === 24 && result.cases.every(item => item.pass);
    writeFileSync(join(artifacts, `browser-${phase}-results.json`), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  }
  return result;
}
