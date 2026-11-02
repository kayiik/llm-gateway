import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const input = { model: 'shutdown-provider/fixture', messages: [{ role: 'user', content: 'hold until released' }], stream: true };

export async function runShutdownClient(mode) {
  const origin = process.env.REPLAY_ORIGIN, key = process.env.REPLAY_ADMIN_KEY;
  const artifacts = process.env.REPLAY_ARTIFACTS ?? '/artifacts';
  if (mode === 'prepare') {
    for (const [path, body] of [['providers', { id: 'shutdown-provider', registry_id: 'openai', base_url: 'http://upstream:18889/shutdown/v1', api_key: 'fixture-shutdown-token' }], ['providers/shutdown-provider/refresh', {}]]) {
      const response = await fetch(origin + '/admin/api/' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200, path + ': could not configure the isolated shutdown fixture'); await response.text();
    }
    console.log(JSON.stringify({ prepared: true })); return;
  }
  if (mode === 'release') {
    const response = await fetch('http://127.0.0.1:18889/shutdown/control/release', { method: 'POST', signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); console.log(await response.text()); return;
  }
  if (mode === 'stats') {
    const response = await fetch('http://127.0.0.1:18889/metrics', { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); console.log(JSON.stringify((await response.json()).shutdown)); return;
  }
  if (mode === 'probe' || mode === 'reject') {
    let status;
    try {
      const response = await fetch(origin + (mode === 'probe' ? '/health' : '/v1/chat/completions'), {
        ...(mode === 'reject' ? { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}),
        signal: AbortSignal.timeout(1000),
      });
      status = response.status; await response.body?.cancel();
    } catch { status = 0; }
    console.log(JSON.stringify({ accepted: status > 0 && status < 400, status })); return;
  }
  assert.ok(mode === 'hold' || mode === 'hold-forced');
  const prefix = mode === 'hold-forced' ? 'shutdown-forced-stream' : 'shutdown-stream';
  const result = { pass: false, opened: false, completed: false };
  try {
    const response = await fetch(origin + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(25000) });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    const first = await reader.read(); assert.equal(first.done, false);
    const text = decoder.decode(first.value); assert.match(text, /chat\.completion\.chunk/);
    result.opened = true; writeFileSync(join(artifacts, prefix + '-open.json'), JSON.stringify({ opened: true }) + '\n', { mode: 0o600 });
    let rest = text;
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; rest += decoder.decode(chunk.value); }
    assert.match(rest, /drained-fixture/); assert.match(rest, /data: \[DONE\]/);
    result.completed = true; result.pass = true;
  } catch (error) { result.error = error.message; }
  writeFileSync(join(artifacts, prefix + '-result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result)); if (!result.pass) process.exitCode = 1;
}

export async function runInstalledShutdown({ docker, gateway, upstream, adminKey, artifacts }) {
  const result = { boundary: 'Installed SIGTERM drains an opened stream, refuses new Gateway admissions and does not replay the source', pass: false, cases: [] };
  const call = mode => JSON.parse(docker(['exec', '-e', 'REPLAY_ORIGIN=http://gateway:8787', '-e', 'REPLAY_ADMIN_KEY=' + adminKey, upstream, 'node', '/tests/integration/run-recorded-http.mjs', '--shutdown-client=' + mode], 12000));
  const wait = process => new Promise(resolve => process.on('close', code => resolve(code)));
  const test = async (name, run) => { const row = { name, pass: false }; result.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = error.message; } };
  await test('sigterm-drains-opened-stream-and-refuses-new-admissions-before-release', async row => {
    assert.equal(call('prepare').prepared, true);
    const stream = spawn('docker', ['exec', '-e', 'REPLAY_ORIGIN=http://gateway:8787', '-e', 'REPLAY_ADMIN_KEY=' + adminKey, upstream, 'node', '/tests/integration/run-recorded-http.mjs', '--shutdown-client=hold'], { stdio: 'ignore' });
    const streamDone = wait(stream); let stopping, stopDone;
    try {
      const opened = join(artifacts, 'shutdown-stream-open.json');
      for (let attempt = 0; attempt < 120 && !existsSync(opened); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(existsSync(opened), 'the actual public stream must open before SIGTERM');
      stopping = spawn('docker', ['stop', '--time', '20', gateway], { stdio: 'ignore' }); stopDone = wait(stopping);
      let refused = false;
      for (let attempt = 0; attempt < 35 && !refused; attempt++) {
        refused = !call('probe').accepted;
        if (!refused) await new Promise(resolve => setTimeout(resolve, 75));
      }
      assert.equal(refused, true, 'new connections were still accepted during the active drain');
      assert.equal(call('reject').accepted, false, 'an in-flight stream cannot keep accepting new work');
      assert.ok(!existsSync(join(artifacts, 'shutdown-stream-result.json')), 'the original stream was still active during refusal');
      assert.equal(call('release').released, 1);
      assert.equal(await streamDone, 0, 'SIGTERM cut off the opened stream');
      assert.equal(await stopDone, 0, 'the Gateway did not complete its graceful stop');
      const drained = JSON.parse(readFileSync(join(artifacts, 'shutdown-stream-result.json'), 'utf8'));
      assert.equal(drained.pass, true);
      const metrics = call('stats'); assert.equal(metrics.starts, 1); assert.equal(metrics.completed, 1); assert.equal(metrics.cancelled, 0);
      row.drained = true; row.newAdmissionsRefusedBeforeRelease = true; row.upstreamCalls = metrics.starts;
    } finally {
      try { call('release'); } catch { /* teardown still removes the isolated network */ }
      if (stopDone) await Promise.race([stopDone, new Promise(resolve => setTimeout(resolve, 21000))]);
      await Promise.race([streamDone, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
  });
  await test('second-signal-forces-a-held-stream-to-close-before-its-provider-releases', async row => {
    docker(['start', gateway], 12000);
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt++) { ready = call('probe').accepted; if (!ready) await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.equal(ready, true, 'the same disposable Gateway must be running again for the second-signal test');
    const stream = spawn('docker', ['exec', '-e', 'REPLAY_ORIGIN=http://gateway:8787', '-e', 'REPLAY_ADMIN_KEY=' + adminKey, upstream, 'node', '/tests/integration/run-recorded-http.mjs', '--shutdown-client=hold-forced'], { stdio: 'ignore' });
    const streamDone = wait(stream);
    try {
      const opened = join(artifacts, 'shutdown-forced-stream-open.json');
      for (let attempt = 0; attempt < 120 && !existsSync(opened); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(existsSync(opened));
      docker(['kill', '--signal=TERM', gateway], 12000);
      let refused = false;
      for (let attempt = 0; attempt < 35 && !refused; attempt++) { refused = !call('probe').accepted; if (!refused) await new Promise(resolve => setTimeout(resolve, 75)); }
      assert.equal(refused, true, 'the first signal must end new admissions while the stream remains open');
      assert.ok(!existsSync(join(artifacts, 'shutdown-forced-stream-result.json')));
      docker(['kill', '--signal=TERM', gateway], 12000);
      const exited = Number(docker(['wait', gateway], 12000).trim()); assert.equal(exited, 1, 'the second signal must force an exit');
      assert.notEqual(await streamDone, 0, 'forced shutdown cannot deliver a successful terminal');
      const forced = JSON.parse(readFileSync(join(artifacts, 'shutdown-forced-stream-result.json'), 'utf8'));
      assert.equal(forced.opened, true); assert.equal(forced.completed, false);
      const metrics = call('stats'); assert.equal(metrics.starts, 2); assert.equal(metrics.completed, 1); assert.equal(metrics.cancelled, 1);
      row.forcedExit = exited; row.sourceCancelled = true; row.successfulTerminals = 1;
    } finally { try { call('release'); } catch { /* teardown remains bounded */ } await Promise.race([streamDone, new Promise(resolve => setTimeout(resolve, 3000))]); }
  });
  result.pass = result.cases.length === 2 && result.cases.every(row => row.pass);
  writeFileSync(join(artifacts, 'installed-shutdown-results.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  return result;
}
