import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintInputs, goBuildVariant, isolatedTestEnvironment, runProcess, selectedTestResult } from './test-local.mjs';

test('a printed PASS cannot hide a failing process', async () => {
  const result = await runProcess(process.execPath, ['-e', 'console.log("PASS");process.exitCode=7']);
  assert.equal(result.code, 7);
  assert.match(result.output, /PASS/);
  assert.equal(result.timedOut, false);
});

test('a printed PASS cannot hide a hung process', async () => {
  const result = await runProcess(process.execPath, ['-e', 'console.log("PASS");setInterval(()=>{},1000)'], { timeout: 500 });
  assert.equal(result.code, 124);
  assert.equal(result.timedOut, true);
});

test('an inherited pipe does not keep a completed command open', async () => {
  const started = performance.now();
  const result = await runProcess(process.execPath, ['-e', 'require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},1500)"],{stdio:["ignore",1,2]}).unref();console.log("finished")']);
  assert.equal(result.code, 0);
  assert.match(result.output, /finished/);
  assert.ok(performance.now() - started < 1200);
});

test('source, embedded assets and execution bindings invalidate a cached build', async t => {
  const dir = await mkdtemp(join(process.env.LLMGW_TEST_TMP || tmpdir(), 'llmgw-inputs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'main.go'), 'package main\n');
  await writeFile(join(dir, 'asset.json'), '{}');
  const listing = `${dir}||main.go||||asset.json`;
  const initial = await fingerprintInputs(listing, 'toolchain-a');
  await writeFile(join(dir, 'main.go'), 'package main\n// changed\n');
  const source = await fingerprintInputs(listing, 'toolchain-a');
  assert.notEqual(source, initial);
  await writeFile(join(dir, 'asset.json'), '{"changed":true}');
  const embedded = await fingerprintInputs(listing, 'toolchain-a');
  assert.notEqual(embedded, source);
  assert.notEqual(await fingerprintInputs(listing, 'toolchain-b'), embedded);
  assert.equal(await fingerprintInputs(listing, 'toolchain-a'), embedded);
  const variant = JSON.stringify(goBuildVariant({ GOVERSION: 'go1.27.2', GOARCH: 'amd64', GOAMD64: 'v1', CGO_CFLAGS: '-O2' }));
  const microarchitecture = JSON.stringify(goBuildVariant({ GOVERSION: 'go1.27.2', GOARCH: 'amd64', GOAMD64: 'v3', CGO_CFLAGS: '-O2' }));
  const compilerFlags = JSON.stringify(goBuildVariant({ GOVERSION: 'go1.27.2', GOARCH: 'amd64', GOAMD64: 'v1', CGO_CFLAGS: '-O0' }));
  assert.notEqual(await fingerprintInputs(listing, variant), await fingerprintInputs(listing, microarchitecture));
  assert.notEqual(await fingerprintInputs(listing, variant), await fingerprintInputs(listing, compilerFlags));
});

test('Windows config/cache paths are isolated while Go caches remain reusable', () => {
  const original = { APPDATA: 'sentinel-private-roaming', LOCALAPPDATA: 'sentinel-private-local', LLMGW_LIVE_GCP_KEY: 'sentinel-key-reference' };
  const caches = { GOPATH: 'shared-modules', GOMODCACHE: 'shared-module-cache', GOCACHE: 'shared-build-cache' };
  const env = isolatedTestEnvironment(original, caches, 'sandbox', 'state');
  assert.equal(env.APPDATA, join('sandbox', 'AppData/Roaming'));
  assert.equal(env.LOCALAPPDATA, join('sandbox', 'AppData/Local'));
  assert.equal(env.GOCACHE, caches.GOCACHE);
  assert.equal(env.GOMODCACHE, caches.GOMODCACHE);
  assert.equal(env.LLMGW_LIVE_GCP_KEY, undefined);
  assert.equal(original.APPDATA, 'sentinel-private-roaming');
});

test('filtered Go profiles reject empty selections without running a broad suite', () => {
  const empty = { code: 0, timedOut: false, output: 'ok fixture/package 0.003s [no tests to run]\n' };
  assert.equal(selectedTestResult(empty, true).code, 1);
  assert.equal(selectedTestResult(empty, false).code, 0);
  assert.equal(selectedTestResult({ code: 0, output: '=== RUN   TestFixture\n--- PASS: TestFixture\n' }, true).tests, 1);
  assert.equal(selectedTestResult({ code: 7, output: '=== RUN   TestFixture\nFAIL\n' }, true).code, 7);
});
