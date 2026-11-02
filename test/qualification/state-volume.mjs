import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, chownSync, constants, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { futureSchemaArchive } from './archive-fixtures.mjs';

const operation = process.argv[2];
assert.ok(['initialize', 'snapshot', 'restore', 'verify', 'verify-baseline', 'retain-archive', 'corrupt-archive', 'future-schema-archive', 'verify-empty', 'age-discovery-catalog', 'trust-transparent-catalog', 'inspect-request-log', 'write-external-keys-file'].includes(operation), 'unsupported state-volume operation');
const snapshot = '/artifacts/pre-upgrade-state';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const metadata = value => ({ mode: value.mode & 0o777, uid: value.uid, gid: value.gid });

function inventory(root, prefix = '') {
  const entries = [];
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const relative = prefix ? prefix + '/' + name : name;
    const value = lstatSync(join(root, relative));
    assert.ok(value.isFile() || value.isDirectory(), 'state snapshots only support regular files and directories');
    entries.push({ path: relative, kind: value.isDirectory() ? 'directory' : 'file', ...metadata(value), ...(value.isFile() ? { size: value.size, sha256: sha256(readFileSync(join(root, relative))) } : {}) });
    if (value.isDirectory()) entries.push(...inventory(root, relative));
  }
  return entries;
}

function verifyFiles(root, manifest, checkMetadata) {
  const proof = entries => entries.map(entry => ({ path: entry.path, kind: entry.kind, ...(entry.kind === 'file' ? { size: entry.size, sha256: entry.sha256 } : {}), ...(checkMetadata ? { mode: entry.mode, uid: entry.uid, gid: entry.gid } : {}) }));
  assert.deepEqual(proof(inventory(root)), proof(manifest.entries), 'snapshot bytes or state metadata differ from the sealed baseline');
}

function readSnapshot() {
  const bytes = readFileSync(join(snapshot, 'manifest.json'));
  assert.ok(process.env.SNAPSHOT_SHA256, 'the original snapshot digest is required');
  assert.equal(sha256(bytes), process.env.SNAPSHOT_SHA256, 'the original snapshot manifest changed');
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.schemaVersion, 1);
  for (const entry of manifest.entries) {
    assert.ok(entry.path && !posix.isAbsolute(entry.path) && !entry.path.split('/').some(part => !part || part === '.' || part === '..'), 'unsafe state snapshot path');
  }
  verifyFiles(join(snapshot, 'files'), manifest, false);
  return manifest;
}

let result;
if (operation === 'initialize') {
  assert.equal(readdirSync('/state').length, 0, 'only initialize a new, empty qualification volume');
  chownSync('/state', 65532, 65532);
  chmodSync('/state', 0o700);
  result = { initialized: true };
} else if (operation === 'verify-empty') {
  assert.equal(readdirSync('/state').length, 0, 'a refused restore must leave the destination empty');
  result = { empty: true };
} else if (operation === 'age-discovery-catalog') {
  // Only a stopped disposable candidate volume is mounted here. The sealed
  // earlier-image baseline and its archived copy are never modified.
  const file = '/state/catalog.json', catalog = JSON.parse(readFileSync(file, 'utf8'));
  const scoped = Object.entries(catalog).filter(([key, value]) => key.startsWith('discovery-pending@') && value?.refreshed_at);
  assert.equal(scoped.length, 1, 'age only the actual service-project caller catalog, never another principal or the gateway-wide entry');
  const [, stored] = scoped[0];
  stored.refreshed_at = new Date(Date.now() - 48 * 3600000).toISOString();
  writeFileSync(file, JSON.stringify(catalog) + '\n');
  result = { aged: true, provider: 'discovery-pending' };
} else if (operation === 'trust-transparent-catalog') {
  // The controlled provider's upstream fixture explicitly declared Responses.
  // This stopped-copy injection models catalog-confirmed wire evidence, which
  // generic OpenAI /models normalization otherwise cannot attest by itself.
  const file = '/state/catalog.json', catalog = JSON.parse(readFileSync(file, 'utf8'));
  const rows = catalog['transport-confirmed']?.models ?? [];
  const row = rows.find(item => item.id === 'fixture-client-responses');
  assert.ok(row?.typed_capabilities, 'the cached native model must have typed evidence before the fixture can qualify it');
  assert.ok(row.supported_surfaces?.includes('/responses') || row.supported_surfaces?.includes('/v1/responses'));
  row.typed_capabilities.provenance = { source: 'upstream_reported', confidence: 'high' };
  row.wire_preservation = { responses: 'supported' };
  writeFileSync(file, JSON.stringify(catalog) + '\n');
  result = { trustedCatalogInjected: true, provider: 'transport-confirmed', model: row.id };
} else if (operation === 'inspect-request-log') {
  const file = '/state/requests.jsonl', stat = statSync(file), raw = readFileSync(file, 'utf8');
  const entries = raw.trim().split('\n').map(line => JSON.parse(line));
  const marker = entries.find(entry => entry.request_id === 'fixture-http-request-log-boundary');
  assert.ok(marker, 'the controlled installed request must have an actual log entry');
  assert.equal(stat.mode & 0o777, 0o600, 'only the state owner may read this file');
  assert.ok(marker.request_bytes > 0 && marker.response_bytes > 0);
  for (const name of ['model', 'request', 'response']) assert.equal(marker[name], undefined);
  assert.ok(!raw.includes('synthetic-private-body-marker') && !raw.includes('credential:system'), 'metadata-only log cannot persist request or response bodies');
  result = { inspected: true, entries: entries.length, privateMode: true, bodyAbsent: true };
} else if (operation === 'write-external-keys-file') {
  assert.ok(readdirSync('/state').includes('gateway.db'), 'external keys belong only on the stopped disposable copy');
  const file = '/state/external-keys.json';
  writeFileSync(file, JSON.stringify({ version: 1, keys: [{ name: 'controlled-file', project: 'preserved-project', key: 'fixture-external-file-key',
    allowed_routes: ['preserved-route'], allowed_models: ['preserved-route'], allowed_providers: ['preserved-provider'] }] }) + '\n', { flag: 'wx', mode: 0o600 });
  chownSync(file, 65532, 65532); result = { written: true, ownerOnly: true };
} else if (operation === 'retain-archive') {
  const bytes = readFileSync('/state/backups/qualification.tar.gz');
  writeFileSync('/artifacts/gateway-backup.tar.gz', bytes, { mode: 0o600, flag: 'wx' });
  result = { sha256: sha256(bytes), size: bytes.length, retained: true };
} else if (operation === 'future-schema-archive') {
  const source = readFileSync('/state/backups/qualification.tar.gz');
  const future = futureSchemaArchive(source);
  const target = '/state/backups/future-schema.tar.gz';
  writeFileSync(target, future.bytes, { mode: 0o600, flag: 'wx' });
  chownSync(target, 65532, 65532);
  result = { sourceSha256: sha256(source), sha256: sha256(future.bytes), size: future.bytes.length, schemaVersion: future.schemaVersion };
} else if (operation === 'corrupt-archive') {
  const bytes = readFileSync('/state/backups/qualification.tar.gz');
  assert.ok(bytes.length > 20, 'create the corrupt fixture from a real nonempty archive');
  const truncated = bytes.subarray(0, Math.floor(bytes.length / 2));
  const target = '/state/backups/corrupt.tar.gz';
  writeFileSync(target, truncated, { mode: 0o600, flag: 'wx' });
  chownSync(target, 65532, 65532);
  result = { sourceSha256: sha256(bytes), sha256: sha256(truncated), size: truncated.length };
} else if (operation === 'snapshot') {
  const manifest = { schemaVersion: 1, directory: metadata(statSync('/state')), entries: inventory('/state') };
  assert.ok(manifest.entries.some(entry => entry.kind === 'file'), 'do not qualify an empty baseline');
  mkdirSync(snapshot, { mode: 0o700 });
  mkdirSync(join(snapshot, 'files'), { mode: 0o700 });
  for (const entry of manifest.entries) {
    const target = join(snapshot, 'files', entry.path);
    if (entry.kind === 'directory') mkdirSync(target, { mode: 0o700 });
    else { copyFileSync(join('/state', entry.path), target, constants.COPYFILE_EXCL); chmodSync(target, 0o600); }
  }
  verifyFiles(join(snapshot, 'files'), manifest, false);
  const bytes = JSON.stringify(manifest, null, 2) + '\n';
  writeFileSync(join(snapshot, 'manifest.json'), bytes, { mode: 0o600, flag: 'wx' });
  result = { manifestSha256: sha256(bytes), fileCount: manifest.entries.filter(entry => entry.kind === 'file').length, retained: true };
} else {
  const manifest = readSnapshot();
  if (operation === 'restore') {
    assert.equal(readdirSync('/state').length, 0, 'restore only into a new, empty qualification volume');
    for (const entry of manifest.entries) {
      const target = join('/state', entry.path);
      if (entry.kind === 'directory') mkdirSync(target, { mode: 0o700 });
      else { mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(snapshot, 'files', entry.path), target, constants.COPYFILE_EXCL); }
      chownSync(target, entry.uid, entry.gid);
      chmodSync(target, entry.mode);
    }
    chownSync('/state', manifest.directory.uid, manifest.directory.gid);
    chmodSync('/state', manifest.directory.mode);
    assert.deepEqual(metadata(statSync('/state')), manifest.directory);
    verifyFiles('/state', manifest, true);
  }
  if (operation === 'verify-baseline') {
    assert.deepEqual(metadata(statSync('/state')), manifest.directory);
    verifyFiles('/state', manifest, true);
  }
  result = { verified: true, manifestSha256: process.env.SNAPSHOT_SHA256 };
}
console.log(JSON.stringify({ operation, ...result }));
