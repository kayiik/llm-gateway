import assert from 'node:assert/strict';

// Catalogs belong to the actual credential caller, not the administrator that
// configured the provider. A scoped alias count discovers without inference.
export async function primeCallerCatalog({ admin, request, metrics, caller, provider, alias }) {
  const before = (await metrics()).inference;
  await admin('keys/update', { id: caller.key.id, allowed_providers: [provider] });
  try {
    const response = await request('/v1/messages/count_tokens', { model: alias, messages: [{ role: 'user', content: 'prime catalog' }] }, caller.token);
    assert.equal(response.status, 200, response.text);
    assert.ok(Number.isInteger(JSON.parse(response.text).input_tokens));
  } finally {
    await admin('keys/update', { id: caller.key.id, allowed_providers: caller.key.allowed_providers ?? [] });
  }
  assert.equal((await metrics()).inference, before, 'catalog priming must not make an inference');
}
