import assert from 'node:assert/strict';
import { ensureOwnerFixture } from '../qualification/owner-fixture.mjs';

export async function runMultimodalMatrix({ admin, publicCall, metrics, save, registerSecret }) {
  const evidence = { boundary: 'Installed explicitly permitted image/file/PDF carrier conversion with ordered source parts and pre-I/O refusal for unrepresentable files', pass: false, cases: [] };
  const test = async (name, run) => { const row = { name, pass: false }; evidence.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = error.message; } finally { save('multimodal-matrix.json', evidence); } };
  for (const wire of ['chat', 'responses']) {
    await admin('providers', { id: 'multimodal-' + wire, registry_id: wire === 'chat' ? 'custom_openai' : 'openai', base_url: `http://upstream:18889/multimodal/${wire}/v1`, api_key: 'fixture-multimodal-key', ...(wire === 'responses' ? { force_api_support: true } : {}) });
    await admin('providers/multimodal-' + wire + '/refresh', {});
  }
  const owners = await ensureOwnerFixture({ origin: process.env.REPLAY_ORIGIN, adminKey: process.env.REPLAY_ADMIN_KEY, ssoSecret: process.env.REPLAY_SSO_SECRET });
  registerSecret(owners.keys.a.token); registerSecret('fixture-multimodal-key');
  await admin(`principals/${owners.actors.a.id}/connections`, { provider_id: 'multimodal-chat', connection_name: 'media-caller', credential_kind: 'api_key', secret: 'fixture-multimodal-key', make_default: true });
  await admin('providers/multimodal-chat/refresh?principal_id=' + owners.actors.a.id, {});
  const calls = async () => (await metrics()).multimodal?.calls ?? [];
  const bytes = Buffer.from('fixture-media-bytes').toString('base64');
  const pdf = Buffer.from('%PDF-1.4\nfixture').toString('base64');
  await test('messages-user-image-base64-and-url-parts-keep-text-and-image-order-in-chat', async row => {
    const source = [{ type: 'text', text: 'first' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes } }, { type: 'text', text: 'middle' }, { type: 'image', source: { type: 'url', url: 'https://media.example.test/fixture.png' } }, { type: 'text', text: 'last' }];
    const before = (await calls()).length;
    const response = await publicCall('multimodal-message-images', '/v1/messages', { model: 'multimodal-chat/fixture-multimodal', max_tokens: 32, messages: [{ role: 'user', content: source }] }, undefined, 'allow');
    assert.equal(response.status, 200, response.text); assert.match(response.text, /multimodal-fixture-ok/);
    const actual = (await calls()).slice(before); assert.equal(actual.length, 1); assert.equal(actual[0].wire, 'chat');
    assert.deepEqual(actual[0].content.map(part => part.type), ['text', 'image_url', 'text', 'image_url', 'text']);
    assert.equal(actual[0].content[1].image_url.url, `data:image/png;base64,${bytes}`);
    assert.equal(actual[0].content[3].image_url.url, 'https://media.example.test/fixture.png'); row.orderedParts = 5;
  });
  await test('messages-plain-base64-pdf-becomes-a-chat-file-without-fetch', async row => {
    const before = (await calls()).length;
    const response = await publicCall('multimodal-message-pdf', '/v1/messages', { model: 'multimodal-chat/fixture-multimodal', max_tokens: 32, messages: [{ role: 'user', content: [{ type: 'text', text: 'read' }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } }] }] }, undefined, 'allow');
    assert.equal(response.status, 200, response.text); const actual = (await calls()).slice(before); assert.equal(actual.length, 1);
    assert.deepEqual(actual[0].content.map(part => part.type), ['text', 'file']);
    assert.ok(actual[0].content[1].file.file_data.includes(pdf)); row.pdfBase64 = true;
  });
  await test('pdf-title-context-citation-and-cache-controls-never-disappear-in-chat-conversion', async row => {
    const before = (await metrics()).inference;
    for (const [index, extra] of [{ title: 'fixture title' }, { context: 'fixture context' }, { citations: { enabled: true } }, { cache_control: { type: 'ephemeral' } }].entries()) {
      const response = await publicCall('multimodal-pdf-control-' + index, '/v1/messages', { model: 'multimodal-chat/fixture-multimodal', max_tokens: 32, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf }, ...extra }] }] }, undefined, 'allow');
      assert.ok(response.status >= 400, response.text); assert.equal((await metrics()).inference, before, 'material document controls must refuse before provider I/O');
    }
    row.refusedMaterialControls = 4;
  });
  await test('chat-file-data-and-filename-become-a-responses-input-file', async row => {
    const before = (await calls()).length;
    const response = await publicCall('multimodal-chat-to-responses-file', '/v1/chat/completions', { model: 'multimodal-responses/fixture-multimodal', messages: [{ role: 'user', content: [{ type: 'text', text: 'read' }, { type: 'file', file: { filename: 'fixture.txt', file_data: `data:text/plain;base64,${bytes}` } }] }] }, undefined, 'allow');
    assert.equal(response.status, 200, response.text); const actual = (await calls()).slice(before); assert.equal(actual.length, 1); assert.equal(actual[0].wire, 'responses');
    const file = actual[0].content.find(part => part.type === 'input_file'); assert.ok(file); assert.equal(file.filename, 'fixture.txt'); assert.equal(file.file_data, `data:text/plain;base64,${bytes}`); row.filenameRetained = true;
  });
  await test('responses-input-file-id-and-filename-become-one-chat-file', async row => {
    const before = (await calls()).length;
    const response = await publicCall('multimodal-responses-to-chat-file', '/v1/responses', { model: 'multimodal-chat/fixture-multimodal', input: [{ role: 'user', content: [{ type: 'input_text', text: 'read' }, { type: 'input_file', filename: 'fixture.txt', file_id: 'file_fixture' }] }] }, owners.keys.a.token, 'allow');
    assert.equal(response.status, 200, response.text); const actual = (await calls()).slice(before); assert.equal(actual.length, 1); assert.equal(actual[0].wire, 'chat');
    const file = actual[0].content.find(part => part.type === 'file'); assert.ok(file); assert.equal(file.file.filename, 'fixture.txt'); assert.equal(file.file.file_id, 'file_fixture'); row.fileIDRetained = true;
  });
  await test('conflicting-empty-and-remote-file-carriers-refuse-before-upstream', async row => {
    const invalid = [
      { model: 'multimodal-chat/fixture-multimodal', input: [{ role: 'user', content: [{ type: 'input_file', filename: 'fixture.txt', file_data: `data:text/plain;base64,${bytes}`, file_id: 'file_fixture' }] }] },
      { model: 'multimodal-chat/fixture-multimodal', input: [{ role: 'user', content: [{ type: 'input_file', filename: 'fixture.txt' }] }] },
      { model: 'multimodal-chat/fixture-multimodal', input: [{ role: 'user', content: [{ type: 'input_file', filename: 'fixture.txt', file_url: 'https://media.example.test/fixture.txt' }] }] },
    ];
    const before = (await metrics()).inference;
    for (const [index, body] of invalid.entries()) { const response = await publicCall('multimodal-refused-file-' + index, '/v1/responses', body, undefined, 'allow'); assert.ok(response.status >= 400, response.text); assert.equal((await metrics()).inference, before); }
    row.refusedBeforeProvider = invalid.length;
  });
  evidence.pass = evidence.cases.length === 6 && evidence.cases.every(row => row.pass); save('multimodal-matrix.json', evidence);
  assert.equal(evidence.pass, true, evidence.cases.filter(row => !row.pass).map(row => row.name + ': ' + row.error).join('\n'));
}
