import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';

const bundle = JSON.parse(readFileSync(new URL('./fixtures/recorded-upstream-bundle.json', import.meta.url), 'utf8'));

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function sse(res, rawSse) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.end(rawSse);
}

export function createRealWireSuperserver(metrics) {
  metrics.realWire = { served: [], rejected: 0 };
  metrics.realWireOllamaReply = bundle.ollama.chat.response;
  const recordServed = (family, operation, status) => {
    metrics.inference++;
    metrics.realWire.served.push({ family, operation, status });
  };
  const reject = (res, message) => {
    metrics.realWire.rejected++;
    json(res, 422, { error: { message } });
    return true;
  };

  return async function handleRealWire(req, res, path) {
    if (!path.startsWith('/real-wire/')) return false;

    // 1. OpenRouter (Chat JSON, Chat SSE, 2-turn Tool Call JSON)
    if (path.startsWith('/real-wire/openrouter/v1/')) {
      if (!req.headers.authorization?.startsWith('Bearer ')) return reject(res, 'missing bearer auth');
      if (req.method === 'GET' && path === '/real-wire/openrouter/v1/models') {
        json(res, 200, { data: [{ id: 'openrouter/free', supported_endpoints: ['/chat/completions'] }] });
        return true;
      }
      if (req.method === 'POST' && path === '/real-wire/openrouter/v1/chat/completions') {
        const body = await readJsonBody(req);
        if (body.model !== 'openrouter/free' || !Array.isArray(body.messages) || !body.messages.length) {
          return reject(res, 'invalid openrouter request shape');
        }
        if (Array.isArray(body.tools) && body.tools.length > 0) {
          const hasToolResult = body.messages.some(m => m.role === 'tool');
          const turn = hasToolResult ? bundle.openrouter.tool_turn_2 : bundle.openrouter.tool_turn_1;
          recordServed('openrouter', hasToolResult ? 'tool-turn-2' : 'tool-turn-1', turn.status);
          json(res, turn.status, turn.response);
          return true;
        }
        if (body.stream === true) {
          recordServed('openrouter', 'chat-sse', 200);
          sse(res, bundle.openrouter.chat_sse.response_sse);
          return true;
        }
        recordServed('openrouter', 'chat-json', 200);
        json(res, 200, bundle.openrouter.chat_json.response);
        return true;
      }
      return reject(res, 'unsupported openrouter path');
    }

    // 2. Groq (2-turn Streaming Tool Call SSE)
    if (path.startsWith('/real-wire/groq/v1/')) {
      if (!req.headers.authorization?.startsWith('Bearer ')) return reject(res, 'missing groq bearer auth');
      if (req.method === 'GET' && path === '/real-wire/groq/v1/models') {
        json(res, 200, { data: [{ id: 'openai/gpt-oss-20b', supported_endpoints: ['/chat/completions'] }] });
        return true;
      }
      if (req.method === 'POST' && path === '/real-wire/groq/v1/chat/completions') {
        const body = await readJsonBody(req);
        if (body.model !== 'openai/gpt-oss-20b' || body.stream !== true || !Array.isArray(body.tools) || !body.tools.length) {
          return reject(res, 'invalid groq streaming tool request');
        }
        const hasToolResult = Array.isArray(body.messages) && body.messages.some(m => m.role === 'tool');
        if (hasToolResult) {
          const toolMsg = body.messages.find(m => m.role === 'tool');
          if (!toolMsg?.tool_call_id) return reject(res, 'missing tool_call_id on continuation');
          recordServed('groq', 'tool-sse-turn-2', 200);
          sse(res, bundle.groq.tool_sse_turn_2.response_sse);
          return true;
        }
        recordServed('groq', 'tool-sse-turn-1', 200);
        sse(res, bundle.groq.tool_sse_turn_1.response_sse);
        return true;
      }
      return reject(res, 'unsupported groq path');
    }

    // 3. Native Anthropic (/v1/messages JSON & SSE)
    if (path.startsWith('/real-wire/anthropic/')) {
      if (!req.headers['x-api-key'] || !req.headers['anthropic-version']) {
        return reject(res, 'missing anthropic auth or version header');
      }
      if (req.method === 'GET' && path === '/real-wire/anthropic/v1/models') {
        json(res, 200, { data: [{ id: 'qwen2.5:0.5b', type: 'model', display_name: 'Qwen 2.5 0.5B' }] });
        return true;
      }
      if (req.method === 'POST' && path === '/real-wire/anthropic/v1/messages') {
        const body = await readJsonBody(req);
        if (body.model !== 'qwen2.5:0.5b' || !Array.isArray(body.messages) || !body.messages.length || !body.max_tokens) {
          return reject(res, 'invalid anthropic messages request');
        }
        if (body.stream === true) {
          recordServed('anthropic', 'messages-sse', 200);
          sse(res, bundle.anthropic.messages_sse.response_sse);
          return true;
        }
        recordServed('anthropic', 'messages-json', 200);
        json(res, 200, bundle.anthropic.messages_json.response);
        return true;
      }
      return reject(res, 'unsupported anthropic path');
    }

    // 4. AI Studio Native Gemini (Chat, Embeddings, Image)
    if (path.startsWith('/real-wire/ai-studio/v1beta/')) {
      if (!req.headers['x-goog-api-key']) return reject(res, 'missing x-goog-api-key header');
      if (req.method === 'GET' && path === '/real-wire/ai-studio/v1beta/models') {
        json(res, 200, {
          models: [
            { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
            { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
          ],
        });
        return true;
      }
      if (req.method === 'POST' && path === '/real-wire/ai-studio/v1beta/models/gemini-2.5-flash-lite:generateContent') {
        const body = await readJsonBody(req);
        if (!Array.isArray(body.contents) || !body.contents.length) return reject(res, 'invalid gemini chat contents');
        recordServed('ai_studio', 'chat', 200);
        json(res, 200, bundle.ai_studio.chat.response);
        return true;
      }
      if (req.method === 'POST' && path === '/real-wire/ai-studio/v1beta/models/gemini-embedding-001:embedContent') {
        const body = await readJsonBody(req);
        if (!body.content?.parts?.length) return reject(res, 'invalid gemini embedContent request');
        recordServed('ai_studio', 'embedding', 200);
        json(res, 200, bundle.ai_studio.embedding.response);
        return true;
      }
      if (req.method === 'POST' && path === '/real-wire/ai-studio/v1beta/models/gemini-2.5-flash-image:generateContent') {
        const body = await readJsonBody(req);
        if (!Array.isArray(body.contents) || !body.contents.length) return reject(res, 'invalid gemini image request');
        recordServed('ai_studio', 'image', 200);
        json(res, 200, bundle.ai_studio.image.response);
        return true;
      }
      return reject(res, 'unsupported ai_studio path');
    }

    // 5. Vertex AI Native Gemini (Chat, Embeddings)
    if (path.startsWith('/real-wire/vertex/v1/projects/fixture-gcp-project/locations/global/publishers/google/models/')) {
      if (!req.headers['x-goog-api-key'] && !req.headers.authorization?.startsWith('Bearer ')) {
        return reject(res, 'missing vertex auth');
      }
      if (req.method === 'POST' && path.endsWith('/gemini-2.5-flash-lite:generateContent')) {
        const body = await readJsonBody(req);
        if (!Array.isArray(body.contents) || !body.contents.length) return reject(res, 'invalid vertex chat request');
        recordServed('vertex_ai', 'chat', 200);
        json(res, 200, bundle.vertex_ai.chat.response);
        return true;
      }
      if (req.method === 'POST' && path.endsWith('/gemini-embedding-2:embedContent')) {
        const body = await readJsonBody(req);
        if (!body.content?.parts?.length) return reject(res, 'invalid vertex embedding request');
        recordServed('vertex_ai', 'embedding', 200);
        json(res, 200, bundle.vertex_ai.embedding.response);
        return true;
      }
      return reject(res, 'unsupported vertex path');
    }

    // 6. Ollama Native (/api/tags & /api/chat)
    if (path.startsWith('/real-wire/ollama/')) {
      if (req.method === 'GET' && path === '/real-wire/ollama/api/tags') {
        json(res, 200, { models: [{ name: 'qwen2.5:0.5b', model: 'qwen2.5:0.5b' }] });
        return true;
      }
      if (req.method === 'POST' && path === '/real-wire/ollama/api/chat') {
        const body = await readJsonBody(req);
        if (body.model !== 'qwen2.5:0.5b' || !Array.isArray(body.messages) || !body.messages.length) {
          return reject(res, 'invalid ollama chat request');
        }
        recordServed('ollama', 'chat', 200);
        json(res, 200, bundle.ollama.chat.response);
        return true;
      }
      return reject(res, 'unsupported ollama path');
    }

    // 7. Bedrock (/v1/models & /v1/chat/completions 200 + 401)
    if (path.startsWith('/real-wire/bedrock/v1/')) {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer ')) return reject(res, 'missing bedrock bearer auth');
      if (req.method === 'GET' && path === '/real-wire/bedrock/v1/models') {
        json(res, 200, { data: [{ id: 'openai.gpt-oss-20b' }] });
        return true;
      }
      if (req.method === 'POST' && path === '/real-wire/bedrock/v1/chat/completions') {
        const body = await readJsonBody(req);
        if (body.model !== 'openai.gpt-oss-20b' || !Array.isArray(body.messages) || !body.messages.length) {
          return reject(res, 'invalid bedrock chat request');
        }
        if (auth === 'Bearer fixture-expired-bedrock-key') {
          recordServed('bedrock', 'chat-401', 401);
          json(res, 401, bundle.bedrock.chat_401.response);
          return true;
        }
        recordServed('bedrock', 'chat-200', 200);
        json(res, 200, bundle.bedrock.chat_200.response);
        return true;
      }
      return reject(res, 'unsupported bedrock path');
    }

    // 8. Extension Daemon (Codex Responses, Copilot Chat & Responses, Zen 429, Edge TTS Speech)
    if (path.startsWith('/real-wire/extension/extension/v1/')) {
      if (req.headers.authorization !== 'Bearer fixture-real-wire-extension-secret') {
        json(res, 401, { error: 'unauthorized' });
        return true;
      }
      if (req.method === 'GET' && path === '/real-wire/extension/extension/v1/info') {
        json(res, 200, {
          version: '0.1.0',
          providers: [
            { id: 'codex_real_wire', name: 'OpenAI Codex Real Wire', surfaces: ['chat_completions', 'responses'], credential: 'none' },
            { id: 'copilot_real_wire', name: 'GitHub Copilot Real Wire', surfaces: ['chat_completions', 'responses'], credential: 'none' },
            { id: 'zen_real_wire', name: 'OpenCode Zen Real Wire', surfaces: ['chat_completions', 'responses'], credential: 'none' },
            { id: 'edge_tts', name: 'Edge TTS', surfaces: ['audio_speech'], credential: 'none' },
          ],
        });
        return true;
      }
      const m = path.match(/^\/real-wire\/extension\/extension\/v1\/([^/]+)\/(models|invoke|stream)$/);
      if (!m) return reject(res, 'unsupported extension path');
      const [, provider, action] = m;
      if (action === 'models' && req.method === 'GET') {
        if (provider === 'codex_real_wire') {
          json(res, 200, { models: [{ id: 'gpt-5.6-luna', supported_apis: ['/responses'] }] });
          return true;
        }
        if (provider === 'copilot_real_wire') {
          json(res, 200, {
            models: [
              { id: 'gemini-3.8-flash', supported_apis: ['/chat/completions'] },
              { id: 'gpt-5.6-luna', supported_apis: ['/responses'] },
            ],
          });
          return true;
        }
        if (provider === 'zen_real_wire') {
          json(res, 200, { models: [{ id: 'nemotron-3.5-lightning-free', free: true, supported_apis: ['/chat/completions'] }] });
          return true;
        }
        if (provider === 'edge_tts') {
          json(res, 200, { models: [{ id: 'en-US-ChristopherNeural', supported_apis: ['/v1/audio/speech'] }] });
          return true;
        }
      }
      const surface = req.headers['x-surface'];
      const model = req.headers['x-model'];
      const body = await readJsonBody(req);
      if (provider === 'codex_real_wire' && surface === 'responses' && model === 'gpt-5.6-luna') {
        if (action === 'stream') {
          recordServed('extension:openai_codex', 'responses-sse', 200);
          sse(res, bundle.extension.openai_codex.responses_sse);
          return true;
        }
        recordServed('extension:openai_codex', 'responses-json', 200);
        const completedLine = bundle.extension.openai_codex.responses_sse.split(/\r?\n/).find(l => l.startsWith('data: {"type":"response.completed"'));
        const completed = JSON.parse(completedLine.slice(6)).response;
        json(res, 200, completed);
        return true;
      }
      if (provider === 'copilot_real_wire' && action === 'invoke') {
        if (surface === 'chat_completions' && model === 'gemini-3.8-flash') {
          recordServed('extension:github_copilot', 'chat-json', 200);
          json(res, 200, bundle.extension.github_copilot.chat_json);
          return true;
        }
        if (surface === 'responses' && model === 'gpt-5.6-luna') {
          recordServed('extension:github_copilot', 'responses-json', 200);
          json(res, 200, bundle.extension.github_copilot.responses_json);
          return true;
        }
      }
      if (provider === 'zen_real_wire' && action === 'invoke' && surface === 'chat_completions') {
        recordServed('extension:opencode_zen_anonymous', 'rate-limit-429', 429);
        json(res, 429, { error: { code: 429, message: bundle.extension.opencode_zen_anonymous.rate_limit_429.error.message } }, {
          'Retry-After': bundle.extension.opencode_zen_anonymous.retry_after,
        });
        return true;
      }
      if (provider === 'edge_tts' && action === 'invoke' && surface === 'audio_speech') {
        if (!body.input) return reject(res, 'missing speech input');
        recordServed('extension:edge_tts', 'speech-mp3', 200);
        const mp3 = Buffer.from(bundle.extension.edge_tts.speech_mp3_base64, 'base64');
        res.writeHead(200, { 'Content-Type': bundle.extension.edge_tts.content_type });
        res.end(mp3);
        return true;
      }
      return reject(res, `unmatched extension call: ${provider}/${action}/${surface}/${model}`);
    }

    return reject(res, 'unknown real-wire route');
  };
}
