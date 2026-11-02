import assert from 'node:assert/strict';

export async function runAzureMatrix({ admin, request, publicCall, metrics, save, registerSecret }) {
  registerSecret('fixture-azure-key');
  const result = { boundary: 'Installed Azure resource-specific deployment catalog and native Chat against a synthetic same-network Azure-shaped peer; no live Azure entitlement', pass: false, cases: [] };
  const test = async (name, run) => { const row = { name, pass: false }; result.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = error.message; } finally { save('azure-matrix.json', result); } };
  const id = 'azure-resource', model = id + '/fixture-deployment';
  await test('azure-resource-deployments-auth-version-pagination-and-model-filter', async row => {
    await admin('providers', { id, registry_id: 'azure_openai', base_url: 'http://azure-resource:18889/openai/v1', api_key: 'fixture-azure-key' });
    const before = (await metrics()).azure;
    await admin(`providers/${id}/refresh`, {});
    const listing = await request('/v1/models'); assert.equal(listing.status, 200, listing.text);
    const rows = JSON.parse(listing.text).data;
    assert.ok(rows.some(item => item.id === model), 'resource deployment name must be publicly discoverable');
    assert.ok(rows.some(item => item.id === id + '/fixture-backup'), 'second deployment page must not be dropped');
    assert.ok(!rows.some(item => item.id === id + '/fixture-embedding'), 'an embedding deployment must not be advertised as Chat');
    const after = (await metrics()).azure;
    assert.deepEqual(after.catalogs.slice(before?.catalogs?.length ?? 0).map(item => [item.target, item.after]), [['resource', null], ['resource', 'page-1']]);
    assert.equal(after.wrongCatalog, 0, 'generic /models must never be mistaken for deployments');
    assert.equal(after.rejected, 0, 'catalog must use api-key and not bearer');
    row.deployments = 2;
  });
  await test('azure-native-chat-json-keeps-deployment-name-and-versioned-answer', async row => {
    const before = (await metrics()).azure?.calls?.length ?? 0;
    const answer = await publicCall('azure-chat-json', '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'Azure fixture request' }], max_tokens: 16 });
    assert.equal(answer.status, 200, answer.text);
    const body = JSON.parse(answer.text); assert.equal(body.model, 'fixture-deployment-version'); assert.equal(body.choices[0].message.content, 'azure-fixture-ok');
    const after = (await metrics()).azure; assert.deepEqual(after.calls.slice(before), [{ target: 'resource', model: 'fixture-deployment', stream: false }]);
    assert.equal(after.rejected, 0, 'inference must use api-key and not bearer'); row.upstreamCalls = 1;
  });
  await test('azure-native-chat-sse-keeps-deployment-name-and-terminal', async row => {
    const before = (await metrics()).azure?.calls?.length ?? 0;
    const answer = await publicCall('azure-chat-sse', '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'Azure fixture streaming request' }], stream: true });
    assert.equal(answer.status, 200, answer.text); assert.match(answer.contentType, /text\/event-stream/);
    assert.match(answer.text, /azure-fixture-ok/); assert.match(answer.text, /data: \[DONE\]/);
    const after = (await metrics()).azure; assert.deepEqual(after.calls.slice(before), [{ target: 'resource', model: 'fixture-deployment', stream: true }]);
    assert.equal(after.rejected, 0); row.upstreamCalls = 1;
  });
  await test('azure-deployment-discovery-does-not-follow-cross-resource-redirect-with-api-key', async row => {
    await admin('providers', { id: 'azure-redirect', registry_id: 'azure_openai', base_url: 'http://azure-redirect:18889/openai/v1', api_key: 'fixture-azure-key' });
    const before = (await metrics()).azure;
    const refresh = await request('/admin/api/providers/azure-redirect/refresh', {});
    assert.ok(refresh.status < 600, refresh.text);
    const listing = await request('/v1/models'); assert.equal(listing.status, 200, listing.text);
    assert.ok(!JSON.parse(listing.text).data.some(item => item.id.startsWith('azure-redirect/')), 'redirected discovery must not publish a resource catalog');
    const after = (await metrics()).azure;
    assert.ok(after.catalogs.slice(before?.catalogs?.length ?? 0).some(item => item.target === 'redirect'));
    assert.equal(after.foreignRequests, 0, 'api-key must not be sent to an alternate resource');
    assert.equal(after.wrongCatalog, 0); row.refreshStatus = refresh.status;
  });
  result.pass = result.cases.length === 4 && result.cases.every(row => row.pass); save('azure-matrix.json', result);
  assert.equal(result.pass, true, result.cases.filter(row => !row.pass).map(row => row.name + ': ' + row.error).join('\n'));
}
