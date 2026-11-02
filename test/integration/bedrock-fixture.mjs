import assert from 'node:assert/strict';

// This is the configured OpenAI-compatible bearer endpoint, not Bedrock IAM.
export function createBedrockFixture(metrics) {
  return async (req, res, path) => {
    const prefix = path.startsWith('/bedrock-alt/') ? '/bedrock-alt' : '/bedrock';
    if (!path.startsWith(prefix + '/')) return false;
    const state = metrics.bedrock ??= { catalogs: 0, invocations: 0, unauthorized: 0, invalidPaths: 0, requests: [] };
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'Bearer fixture-bedrock-bearer') {
      state.unauthorized++; res.writeHead(401); res.end('{"error":{"message":"Controlled bearer credential required."}}'); return true;
    }
    if (path === prefix + '/v1/models' && req.method === 'GET') {
      state.catalogs++; res.end(JSON.stringify({ data: [{ id: 'fixture-bedrock', supported_endpoints: ['/responses'] }] })); return true;
    }
    if (path !== prefix + '/v1/responses' || req.method !== 'POST') {
      state.invalidPaths++; res.writeHead(404); res.end('{"error":{"message":"No such compatible operation."}}'); return true;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    metrics.inference++;
    try {
      const input = JSON.parse(raw); assert.equal(input.model, 'fixture-bedrock'); assert.ok(input.input);
      assert.equal(req.headers['x-amz-date'], undefined); assert.equal(req.headers['x-amz-content-sha256'], undefined);
      state.invocations++; state.requests.push({ path, method: req.method, authScheme: 'Bearer', awsSigned: false, model: input.model });
      res.end(JSON.stringify({ id: 'resp_bedrock_fixture', object: 'response', created_at: 1, model: input.model, status: 'completed', output: [{ type: 'message', id: 'msg_bedrock_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'bearer-compatible-fixture', annotations: [] }] }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } }));
    } catch { res.writeHead(422); res.end('{"error":{"message":"Compatible request mismatch."}}'); }
    return true;
  };
}
