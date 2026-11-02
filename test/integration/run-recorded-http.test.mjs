import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./run-recorded-http.mjs', import.meta.url));
const image = process.env.LLMGW_TEST_GATEWAY_IMAGE;
const baselineImage = process.env.LLMGW_TEST_BASELINE_IMAGE;
const browserArguments = process.env.LLMGW_TEST_BROWSER === '1' ? ['--browser'] : [];

function assertBrowser(receipt) {
  if (!browserArguments.length) return;
  for (const phase of ['firstStart', 'restart']) {
    assert.equal(receipt.browser[phase].pass, true);
    assert.equal(receipt.browser[phase].cases.length, 11);
    assert.deepEqual(receipt.browser[phase].pageErrors, []);
    assert.deepEqual(receipt.browser[phase].serverFailures, []);
    assert.deepEqual(receipt.browser[phase].blockedOrigins, []);
  }
}

test('an identical-image upgrade is refused before any test state is created', { skip: !image && 'set LLMGW_TEST_GATEWAY_IMAGE to an already-built local image', timeout: 240000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'llmgw-upgrade-refusal-'));
  const artifacts = join(directory, 'artifacts');
  try {
    const result = spawnSync(process.execPath, [runner, `--image=${image}`, `--baseline-image=${image}`, '--profile=upgrade', '--cases=public-catalog', `--artifacts=${artifacts}`], { encoding: 'utf8', timeout: 220000 });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, 'restarting one image must not count as an upgrade');
    assert.match(result.stdout + result.stderr, /distinct image identities/i);
    assert.equal(existsSync(artifacts), false, 'invalid qualification must not create state or evidence');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a fresh installed Gateway retains its seeded state and credentials across a restart', { skip: !image && 'set LLMGW_TEST_GATEWAY_IMAGE to an already-built local image', timeout: 240000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'llmgw-fresh-install-'));
  const artifacts = join(directory, 'artifacts');
  try {
    const result = spawnSync(process.execPath, [runner, `--image=${image}`, '--profile=fresh', '--cases=public-catalog', ...browserArguments, `--artifacts=${artifacts}`], { encoding: 'utf8', timeout: 220000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const receipt = JSON.parse(readFileSync(join(artifacts, 'docker-receipt.json'), 'utf8'));
    assert.equal(receipt.profile, 'fresh');
    assertBrowser(receipt);
    assert.equal(receipt.installed.firstStart.pass, true);
    assert.equal(receipt.installed.restart.pass, true);
    assert.equal(receipt.results.pass, true);
    assert.equal(receipt.cleaned, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a seeded installed Gateway upgrades on a copy while its original snapshot stays intact', { skip: !(image && baselineImage) && 'set distinct LLMGW_TEST_GATEWAY_IMAGE and LLMGW_TEST_BASELINE_IMAGE', timeout: 240000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'llmgw-copy-upgrade-'));
  const artifacts = join(directory, 'artifacts');
  try {
    const result = spawnSync(process.execPath, [runner, `--image=${image}`, `--baseline-image=${baselineImage}`, '--profile=upgrade', '--cases=public-catalog', ...browserArguments, `--artifacts=${artifacts}`], { encoding: 'utf8', timeout: 220000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const receipt = JSON.parse(readFileSync(join(artifacts, 'docker-receipt.json'), 'utf8'));
    assert.equal(receipt.profile, 'upgrade');
    assertBrowser(receipt);
    assert.notEqual(receipt.upgrade.baselineImageId, receipt.imageId);
    assert.equal(receipt.upgrade.snapshot.intact, true);
    assert.equal(receipt.upgrade.restored.verified, true);
    assert.equal(receipt.installed.firstStart.pass, true);
    assert.equal(receipt.installed.restart.pass, true);
    assert.equal(receipt.archive.pass, true);
    assert.deepEqual(receipt.archive.cases, [
      'builtin-backup-create-inspect',
      'builtin-backup-excludes-request-logs',
      'builtin-restore-requires-force',
      'builtin-corrupt-backup-refused',
      'builtin-future-schema-refused',
      'builtin-backup-restored-state',
    ].map(name => ({ name, pass: true })));
    assert.equal(receipt.archive.firstStart.pass, true);
    assert.equal(receipt.archive.logExcluded, true);
    assert.equal(receipt.archive.restart.pass, true);
    assert.equal(receipt.archive.futureSchema.exitCode, 1);
    assert.match(receipt.archive.futureSchema.output, /backup schema is newer than this binary supports/);
    assert.equal(createHash('sha256').update(readFileSync(join(artifacts, 'gateway-backup.tar.gz'))).digest('hex'), receipt.archive.file.sha256);
    assert.equal(receipt.upgrade.rollback.imageId, receipt.upgrade.baselineImageId);
    assert.equal(receipt.upgrade.rollback.restored.verified, true);
    assert.notEqual(receipt.upgrade.rollback.volume, receipt.upgrade.originalVolume);
    assert.notEqual(receipt.upgrade.rollback.volume, receipt.upgrade.candidateVolume);
    assert.equal(receipt.upgrade.rollback.firstStart.pass, true);
    assert.equal(receipt.upgrade.rollback.restart.pass, true);
    assert.deepEqual(receipt.upgrade.rollback.firstStart.build, receipt.installed.seed.build);
    assert.deepEqual(receipt.upgrade.rollback.restart.build, receipt.installed.seed.build);
    assert.equal(receipt.upgrade.rollback.cli.version, receipt.installed.seedCli.version);
    assert.equal(receipt.results.pass, true);
    assert.equal(receipt.cleaned, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the public HTTP runner exercises bare model aliases and the legacy-completions boundary', { skip: !image && 'set LLMGW_TEST_GATEWAY_IMAGE to an already-built local image', timeout: 240000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'llmgw-alias-boundary-'));
  const artifacts = join(directory, 'artifacts');
  try {
    const result = spawnSync(process.execPath, [runner, `--image=${image}`, '--cases=bare-alias-two-turn-recording,legacy-completions-boundary-http', `--artifacts=${artifacts}`], { encoding: 'utf8', timeout: 220000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const receipt = JSON.parse(readFileSync(join(artifacts, 'docker-receipt.json'), 'utf8'));
    assert.equal(receipt.results.cases.length, 2);
    assert.equal(receipt.results.pass, true);
    assert.equal(receipt.results.upstreamMetrics.recorded.accepted['chat/bare-alias'], 2);
    assert.equal(receipt.results.upstreamMetrics.recorded.accepted['chat/legacy-boundary'], 1);
    assert.equal(receipt.cleaned, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a changed baseline snapshot is rejected before it can be restored', { skip: !image && 'set LLMGW_TEST_GATEWAY_IMAGE to enable Docker checks', timeout: 60000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'llmgw-snapshot-refusal-'));
  const container = 'llmgw-snapshot-refusal-' + randomBytes(6).toString('hex');
  try {
    const snapshot = join(directory, 'pre-upgrade-state');
    mkdirSync(join(snapshot, 'files'), { recursive: true });
    const original = 'original synthetic state';
    const digest = value => createHash('sha256').update(value).digest('hex');
    const manifest = JSON.stringify({ schemaVersion: 1, directory: { mode: 0o700, uid: 65532, gid: 65532 }, entries: [{ path: 'state.json', kind: 'file', mode: 0o600, uid: 65532, gid: 65532, size: Buffer.byteLength(original), sha256: digest(original) }] });
    writeFileSync(join(snapshot, 'manifest.json'), manifest);
    writeFileSync(join(snapshot, 'files/state.json'), 'changed synthetic state');
    const testRoot = fileURLToPath(new URL('../', import.meta.url));
    const result = spawnSync('docker', ['run', '--rm', '--pull=never', '--name', container, '--network', 'none', '--mount', `type=bind,source=${testRoot},target=/tests,readonly`, '--mount', `type=bind,source=${directory},target=/artifacts,readonly`, '--tmpfs', '/state:rw,noexec,nosuid,size=1m', '-e', 'SNAPSHOT_SHA256=' + digest(manifest), process.env.LLMGW_TEST_NODE_IMAGE ?? 'node:22-alpine', 'node', '/tests/qualification/state-volume.mjs', 'restore'], { encoding: 'utf8', timeout:45000 });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /snapshot bytes or state metadata differ from the sealed baseline/);
    assert.equal(readFileSync(join(snapshot, 'files/state.json'), 'utf8'), 'changed synthetic state');
  } finally {
    spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8', timeout: 10000 });
    rmSync(directory, { recursive: true, force: true });
  }
});
