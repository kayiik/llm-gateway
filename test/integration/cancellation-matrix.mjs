import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { primeCallerCatalog } from './catalog-prime.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/conversation.json', import.meta.url), 'utf8'));
const paths = { chat: '/v1/chat/completions', messages: '/v1/messages', responses: '/v1/responses' };

export async function runCancellationMatrix({ admin, request, metrics, save }) {
  const evidence = { boundary: 'Actual HTTP cancellation after the first SSE event on every text ingress/upstream direct/route pair', pass: false, cases: [] };
  const project = await admin('projects', { slug: 'cancel-matrix', name: 'Cancellation matrix' });
  const caller = await admin('keys', { project_id: project.id, name: 'Cancellation matrix caller', daily_requests: 100 });
  const before = (await metrics()).inference;
  for (const upstream of Object.keys(paths)) for (const ingress of Object.keys(paths)) for (const routed of [false, true]) {
    const name = `cancel-${ingress}-to-${upstream}-${routed ? 'route' : 'direct'}`;
    const row = { name, upstream, ingress, routed, pass: false }; evidence.cases.push(row);
    let reader, controller;
    try {
      const providers = [name, name + '-fallback'];
      for (const provider of providers) {
        await admin('providers', { id: provider, registry_id: { chat: 'openrouter', messages: 'anthropic', responses: 'openai' }[upstream], base_url: `http://upstream:18889/cancellation/${upstream}/${provider}`, api_key: 'fixture-cancel-token', force_api_support: upstream === 'responses' });
        await admin(`providers/${provider}/refresh`, {});
        await primeCallerCatalog({ admin, request, metrics, caller, provider, alias: 'fixture' });
      }
      const model = routed ? name + '-route' : name + '/fixture';
      if (routed) await admin('endpoints', { name: model, ingress: Object.values(paths), allow_adaptation: true, failover: providers.map(provider => ({ provider, model: 'fixture' })) });
      const body = ingress === 'responses'
        ? { model, input: fixture.tool.result, stream: true, max_output_tokens: 32 }
        : { model, messages: [{ role: 'user', content: fixture.tool.result }], stream: true, max_tokens: 32 };
      controller = new AbortController();
      const response = await fetch(process.env.REPLAY_ORIGIN + paths[ingress], {
        method: 'POST', headers: { Authorization: 'Bearer ' + caller.token, 'Content-Type': 'application/json', 'X-Request-ID': name, ...(routed ? {} : { 'X-LLMGW-Compatibility': 'allow' }) },
        body: JSON.stringify(body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      });
      assert.equal(response.status, 200, await (response.status === 200 ? Promise.resolve('') : response.text()));
      assert.match(response.headers.get('content-type'), /text\/event-stream/);
      reader = response.body.getReader();
      let first = '';
      while (!first.includes('\n\n')) { const part = await reader.read(); assert.equal(part.done, false, 'the source must open a real SSE event'); first += new TextDecoder().decode(part.value); }
      const events = first.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(value => value && value !== '[DONE]').flatMap(value => { try { return [JSON.parse(value)]; } catch { return []; } });
      row.initialError = events.find(event => event.type === 'error' || event.error != null);
      assert.ok(events.length); assert.ok(events.every(event => event.type !== 'error' && event.error == null), 'an initial error is not cancellation evidence');
      if (ingress === 'chat') assert.ok(Array.isArray(events[0].choices), 'Chat clients must receive actual Chat chunks');
      if (ingress === 'messages') assert.equal(events[0].type, 'message_start', 'Messages clients must receive their native event shape');
      if (ingress === 'responses') assert.ok(events[0].type?.startsWith('response.'), 'Responses clients must receive Responses events');
      controller.abort(); await assert.rejects(reader.read());
      for (let attempt = 0; attempt < 40 && !((await metrics()).cancellation?.[name]?.cancelled); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
      const state = (await metrics()).cancellation;
      assert.equal(state[name].attempts, 1); assert.equal(state[name].cancelled, 1);
      assert.equal(state[name].terminalEmitted, false, 'a cancelled source must not fabricate a successful terminal');
      assert.equal(state[name + '-fallback']?.attempts ?? 0, 0, 'an opened/cancelled stream must never retry or fail over');
      row.upstreamCalls = 1; row.cancelled = true; row.pass = true;
    } catch (error) { row.error = error.message; }
    finally { controller?.abort(); if (reader) await reader.cancel().catch(() => {}); save('cancellation-matrix.json', evidence); }
  }
  const limits = (await admin(`keys/${caller.key.id}/limits`)).limits;
  const requestLimit = limits.find(item => item.scope === 'key' && item.field === 'daily_requests');
  evidence.chargedRequests = requestLimit?.used;
  evidence.upstreamCalls = (await metrics()).inference - before;
  let rows = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    const value = await admin('requests?project_id=' + project.id + '&limit=200'); rows = value.requests ?? value.rows ?? value;
    if (rows.length >= evidence.cases.length) break; await new Promise(resolve => setTimeout(resolve, 25));
  }
  evidence.ledgerRows = rows.length;
  for (const row of evidence.cases) {
    const entries = rows.filter(item => item.request_id === row.name);
    if (entries.length !== 1 || entries[0].status_code < 400) { row.pass = false; row.error = 'cancelled inference must have one correlated unsuccessful completion row'; }
  }
  evidence.pass = evidence.cases.length === 18 && evidence.upstreamCalls === 18 && evidence.chargedRequests === 18 && evidence.cases.every(row => row.pass);
  save('cancellation-matrix.json', evidence);
  assert.equal(evidence.pass, true, evidence.cases.filter(row => !row.pass).map(row => row.name + ': ' + row.error).join('\n'));
}
