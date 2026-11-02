import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

export async function runRealWireMatrix({ admin, request, publicCall, metrics, save, registerSecret }) {
  const evidence = { boundary: 'Unified real-wire superserver replaying captured upstream exchanges through the running Gateway', pass: false, cases: [] };
  const test = async (name, run) => {
    const row = { name, pass: false };
    evidence.cases.push(row);
    try {
      await run(row);
      row.pass = true;
    } catch (error) {
      row.error = error.message;
    } finally {
      save('real-wire-matrix.json', evidence);
    }
  };

  for (const secret of [
    'fixture-real-openrouter-key',
    'fixture-real-groq-key',
    'fixture-real-anthropic-key',
    'fixture-real-studio-key',
    'fixture-real-vertex-key',
    'fixture-valid-bedrock-key',
    'fixture-expired-bedrock-key',
    'fixture-real-wire-extension-secret',
  ]) {
    registerSecret(secret);
  }

  await admin('providers', { id: 'rw-openrouter', registry_id: 'openrouter', base_url: 'http://upstream:18889/real-wire/openrouter/v1', api_key: 'fixture-real-openrouter-key' });
  await admin('providers/rw-openrouter/refresh', {});

  await admin('providers', { id: 'rw-groq', registry_id: 'groq', base_url: 'http://upstream:18889/real-wire/groq/v1', api_key: 'fixture-real-groq-key' });
  await admin('providers/rw-groq/refresh', {});

  await admin('providers', { id: 'rw-anthropic', type: 'anthropic', base_url: 'http://upstream:18889/real-wire/anthropic', api_key: 'fixture-real-anthropic-key' });
  await admin('providers/rw-anthropic/refresh', {});

  await admin('providers', { id: 'rw-studio', type: 'ai_studio', base_url: 'http://upstream:18889/real-wire/ai-studio/v1beta', api_key: 'fixture-real-studio-key' });
  await admin('providers/rw-studio/refresh', {});

  await admin('providers', { id: 'rw-vertex', type: 'vertex_ai', base_url: 'http://upstream:18889/real-wire/vertex/v1', api_key: 'fixture-real-vertex-key', project: 'fixture-gcp-project', location: 'global' });

  await admin('providers', { id: 'rw-ollama', registry_id: 'ollama', base_url: 'http://upstream:18889' });
  await admin('providers/rw-ollama/refresh', {});

  await admin('providers', { id: 'rw-bedrock', type: 'bedrock', base_url: 'http://upstream:18889/real-wire/bedrock/v1', region: 'us-east-1', api_key: 'fixture-valid-bedrock-key' });
  await admin('providers/rw-bedrock/refresh', {});

  await admin('providers', { id: 'rw-bedrock-expired', type: 'bedrock', base_url: 'http://upstream:18889/real-wire/bedrock/v1', region: 'us-east-1', api_key: 'fixture-expired-bedrock-key' });

  await admin('extensions', { id: 'rw-ext', name: 'Real Wire Extension', url: 'http://upstream:18889/real-wire/extension', secret: 'fixture-real-wire-extension-secret' });
  await admin('providers', { id: 'rw-codex', type: 'codex_real_wire', extension: 'rw-ext' });
  await admin('providers/rw-codex/refresh', {});
  await admin('providers', { id: 'rw-copilot', type: 'copilot_real_wire', extension: 'rw-ext' });
  await admin('providers/rw-copilot/refresh', {});
  await admin('providers', { id: 'rw-zen', type: 'zen_real_wire', extension: 'rw-ext' });
  await admin('providers/rw-zen/refresh', {});
  await admin('providers', { id: 'rw-edgetts', type: 'edge_tts', extension: 'rw-ext' });
  await admin('providers/rw-edgetts/refresh', {});

  await test('real-openrouter-chat-json-and-sse', async row => {
    const jsonRes = await publicCall('rw-openrouter-json', '/v1/chat/completions', {
      model: 'rw-openrouter/openrouter/free',
      messages: [{ role: 'user', content: 'Return exactly CAPTURE_OK.' }],
      max_tokens: 256,
    });
    assert.equal(jsonRes.status, 200, jsonRes.text);
    const parsed = JSON.parse(jsonRes.text);
    assert.match(parsed.choices?.[0]?.message?.content ?? '', /CAPTURE_OK/);

    const sseRes = await publicCall('rw-openrouter-sse', '/v1/chat/completions', {
      model: 'rw-openrouter/openrouter/free',
      stream: true,
      messages: [{ role: 'user', content: 'Return exactly CAPTURE_OK.' }],
      max_tokens: 256,
    });
    assert.equal(sseRes.status, 200, sseRes.text);
    assert.match(sseRes.text, /CAPTURE_OK/);
    assert.match(sseRes.text, /data: \[DONE\]/);
    row.verified = true;
  });

  await test('real-openrouter-two-turn-tool-call-json', async row => {
    const tools = [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    }];
    const turn1 = await publicCall('rw-openrouter-tool-1', '/v1/chat/completions', {
      model: 'rw-openrouter/openrouter/free',
      messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
      tools,
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      max_tokens: 256,
    });
    assert.equal(turn1.status, 200, turn1.text);
    const body1 = JSON.parse(turn1.text);
    const call = body1.choices?.[0]?.message?.tool_calls?.[0];
    assert.ok(call?.id, 'expected recorded tool_call id');

    const turn2 = await publicCall('rw-openrouter-tool-2', '/v1/chat/completions', {
      model: 'rw-openrouter/openrouter/free',
      messages: [
        { role: 'user', content: 'What is the weather in Paris?' },
        body1.choices[0].message,
        { role: 'tool', tool_call_id: call.id, content: '{"temp_c":18}' },
      ],
      tools,
      max_tokens: 128,
    });
    assert.equal(turn2.status, 200, turn2.text);
    const body2 = JSON.parse(turn2.text);
    assert.equal(body2.choices?.[0]?.finish_reason, 'stop');
    assert.ok((body2.choices?.[0]?.message?.content ?? '').length > 0);
    row.toolCallId = call.id;
  });

  await test('real-groq-two-turn-streaming-tool-call-sse', async row => {
    const tools = [{
      type: 'function',
      function: {
        name: 'get_status',
        description: 'Get system status for a component',
        parameters: { type: 'object', properties: { component: { type: 'string' } }, required: ['component'] },
      },
    }];
    const turn1 = await publicCall('rw-groq-tool-sse-1', '/v1/chat/completions', {
      model: 'rw-groq/openai/gpt-oss-20b',
      stream: true,
      stream_options: { include_usage: true },
      tools,
      tool_choice: { type: 'function', function: { name: 'get_status' } },
      messages: [{ role: 'user', content: 'Call get_status for component gateway.' }],
    });
    assert.equal(turn1.status, 200, turn1.text);
    assert.match(turn1.text, /fc_79405792-6bb9-48a7-8bf6-c1d3df920f5b/);
    assert.match(turn1.text, /"finish_reason":"tool_calls"/);

    const turn2 = await publicCall('rw-groq-tool-sse-2', '/v1/chat/completions', {
      model: 'rw-groq/openai/gpt-oss-20b',
      stream: true,
      stream_options: { include_usage: true },
      tools,
      messages: [
        { role: 'user', content: 'Call get_status for component gateway.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'fc_79405792-6bb9-48a7-8bf6-c1d3df920f5b', type: 'function', function: { name: 'get_status', arguments: '{"component":"gateway"}' } }],
        },
        { role: 'tool', tool_call_id: 'fc_79405792-6bb9-48a7-8bf6-c1d3df920f5b', content: '{"status":"CAPTURE_OK"}' },
      ],
    });
    assert.equal(turn2.status, 200, turn2.text);
    const turn2Content = turn2.text.split(/\r?\n/).filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content ?? '').join('');
    assert.match(turn2Content, /CAPTURE_OK/);
    assert.match(turn2.text, /data: \[DONE\]/);
    row.verified = true;
  });

  await test('real-anthropic-native-messages-json-sse-and-cross-translation', async row => {
    const mJson = await publicCall('rw-anthropic-json', '/v1/messages', {
      model: 'rw-anthropic/qwen2.5:0.5b',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Return exactly CAPTURE_OK.' }],
    });
    assert.equal(mJson.status, 200, mJson.text);
    assert.match(JSON.parse(mJson.text).content?.[0]?.text ?? '', /CAPTURE_OK/);

    const mSse = await publicCall('rw-anthropic-sse', '/v1/messages', {
      model: 'rw-anthropic/qwen2.5:0.5b',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'Return exactly CAPTURE_OK.' }],
    });
    assert.equal(mSse.status, 200, mSse.text);
    assert.match(mSse.text, /event: message_stop/);

    const chatToMessages = await publicCall('rw-chat-to-anthropic', '/v1/chat/completions', {
      model: 'rw-anthropic/qwen2.5:0.5b',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Return exactly CAPTURE_OK.' }],
    }, undefined, 'allow');
    assert.equal(chatToMessages.status, 200, chatToMessages.text);
    assert.match(JSON.parse(chatToMessages.text).choices?.[0]?.message?.content ?? '', /CAPTURE_OK/);
    row.verified = true;
  });

  await test('real-ai-studio-and-vertex-gemini-chat-embeddings-and-image', async row => {
    const studioChat = await publicCall('rw-studio-chat', '/v1/chat/completions', {
      model: 'rw-studio/gemini-2.5-flash-lite',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Return exactly CAPTURE_OK.' }],
    }, undefined, 'allow');
    assert.equal(studioChat.status, 200, studioChat.text);
    assert.match(JSON.parse(studioChat.text).choices?.[0]?.message?.content ?? '', /CAPTURE_OK/);

    const studioEmbed = await publicCall('rw-studio-embed', '/v1/embeddings', {
      model: 'rw-studio/gemini-embedding-001',
      input: 'synthetic capture text',
    });
    assert.equal(studioEmbed.status, 200, studioEmbed.text);
    assert.equal(JSON.parse(studioEmbed.text).data?.[0]?.embedding?.length, 3072);

    const studioImage = await publicCall('rw-studio-image', '/v1/images/generations', {
      model: 'rw-studio/gemini-2.5-flash-image',
      prompt: 'A small blue square on white background.',
      n: 1,
    });
    assert.equal(studioImage.status, 200, studioImage.text);
    assert.ok(Buffer.from(JSON.parse(studioImage.text).data?.[0]?.b64_json ?? '', 'base64').length > 32);

    const vertexChat = await publicCall('rw-vertex-chat', '/v1/chat/completions', {
      model: 'rw-vertex/gemini-2.5-flash-lite',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Return exactly CAPTURE_OK.' }],
    }, undefined, 'allow');
    assert.equal(vertexChat.status, 200, vertexChat.text);
    assert.match(JSON.parse(vertexChat.text).choices?.[0]?.message?.content ?? '', /CAPTURE[D]?_OK/);

    const vertexEmbed = await publicCall('rw-vertex-embed', '/v1/embeddings', {
      model: 'rw-vertex/gemini-embedding-2',
      input: 'synthetic capture text',
    });
    assert.equal(vertexEmbed.status, 200, vertexEmbed.text);
    assert.equal(JSON.parse(vertexEmbed.text).data?.[0]?.embedding?.length, 3072);
    row.verified = true;
  });

  await test('real-ollama-native-chat-and-bedrock-200-and-401', async row => {
    const ollamaChat = await publicCall('rw-ollama-chat', '/v1/chat/completions', {
      model: 'rw-ollama/qwen2.5:0.5b',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Return exactly CAPTURE_OK.' }],
    }, undefined, 'allow');
    assert.equal(ollamaChat.status, 200, ollamaChat.text);
    assert.match(JSON.parse(ollamaChat.text).choices?.[0]?.message?.content ?? '', /CAPTURE_OK/);

    const bedrockOk = await publicCall('rw-bedrock-200', '/v1/chat/completions', {
      model: 'rw-bedrock/openai.gpt-oss-20b',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Return exactly CAPTURE_OK.' }],
    });
    assert.equal(bedrockOk.status, 200, bedrockOk.text);
    assert.equal(JSON.parse(bedrockOk.text).choices?.[0]?.message?.content, 'OK');

    const bedrock401 = await publicCall('rw-bedrock-401', '/v1/chat/completions', {
      model: 'rw-bedrock-expired/openai.gpt-oss-20b',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Return exactly CAPTURE_OK.' }],
    });
    assert.equal(bedrock401.status, 401, bedrock401.text);
    row.verified = true;
  });

  await test('real-extension-codex-copilot-edgetts-speech-and-zen-429', async row => {
    const codexJson = await publicCall('rw-codex-responses-json', '/v1/responses', {
      model: 'rw-codex/gpt-5.6-luna',
      input: 'Return exactly CAPTURE_OK.',
      max_output_tokens: 64,
    });
    assert.equal(codexJson.status, 200, codexJson.text);
    assert.match(codexJson.text, /CAPTURE_OK/);

    const codexSse = await publicCall('rw-codex-responses-sse', '/v1/responses', {
      model: 'rw-codex/gpt-5.6-luna',
      input: 'Return exactly CAPTURE_OK.',
      max_output_tokens: 64,
      stream: true,
    });
    assert.equal(codexSse.status, 200, codexSse.text);
    assert.match(codexSse.text, /event: response\.completed/);

    const copilotChat = await publicCall('rw-copilot-chat', '/v1/chat/completions', {
      model: 'rw-copilot/gemini-3.8-flash',
      messages: [{ role: 'user', content: 'Return exactly CAPTURE_OK.' }],
      max_tokens: 1024,
    });
    assert.equal(copilotChat.status, 200, copilotChat.text);
    assert.match(JSON.parse(copilotChat.text).choices?.[0]?.message?.content ?? '', /CAPTURE_OK/);

    const copilotResponses = await publicCall('rw-copilot-responses', '/v1/responses', {
      model: 'rw-copilot/gpt-5.6-luna',
      input: 'Return exactly CAPTURE_OK.',
      max_output_tokens: 64,
    });
    assert.equal(copilotResponses.status, 200, copilotResponses.text);
    assert.match(copilotResponses.text, /CAPTURE_OK/);

    const speech = await publicCall('rw-edgetts-speech', '/v1/audio/speech', {
      model: 'rw-edgetts/en-US-ChristopherNeural',
      input: 'Capture OK.',
      voice: 'en-US-ChristopherNeural',
    });
    assert.equal(speech.status, 200, speech.text);
    assert.match(speech.contentType ?? '', /audio\/mpeg/);
    assert.ok(Buffer.from(speech.bodyBase64 ?? '', 'base64').length >= 512);

    const zen429 = await publicCall('rw-zen-429', '/v1/chat/completions', {
      model: 'rw-zen/nemotron-3.5-lightning-free',
      messages: [{ role: 'user', content: 'Return exactly CAPTURE_OK.' }],
      max_tokens: 64,
    });
    assert.equal(zen429.status, 429, zen429.text);
    row.verified = true;
  });

  const rwMetrics = (await metrics()).realWire;
  assert.ok(rwMetrics.served.length >= 19, `expected at least 19 real-wire exchanges served, got ${rwMetrics.served.length}`);
  assert.equal(rwMetrics.rejected, 0, `unexpected real-wire rejections: ${rwMetrics.rejected}`);
  evidence.servedCount = rwMetrics.served.length;
  evidence.pass = evidence.cases.every(c => c.pass);
  save('real-wire-matrix.json', evidence);
  assert.ok(evidence.pass, 'real-wire matrix had failing cases: ' + JSON.stringify(evidence.cases.filter(c => !c.pass)));
}
