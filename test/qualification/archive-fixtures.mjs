import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Keep the real CLI's manifest and file checksums valid: a corrupt archive
// refusal cannot establish that the installed binary enforces schema bounds.
export function futureSchemaArchive(archive) {
  const tar = gunzipSync(archive, { maxOutputLength: 32 * 1024 * 1024 });
  const entries = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = Buffer.from(tar.subarray(offset, offset + 512));
    if (header.every(byte => byte === 0)) break;
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const size = Number.parseInt(header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim(), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length, 'invalid fixture archive entry');
    assert.ok(header[156] === 0 || header[156] === 48, 'only regular CLI backup files are supported');
    assert.equal(header.toString('utf8', 345, 500).replace(/\0.*$/, ''), '', 'fixture entries must use simple names');
    assert.ok(!entries.some(entry => entry.name === name), 'duplicate fixture archive entry');
    entries.push({ header, name, bytes: Buffer.from(tar.subarray(offset + 512, offset + 512 + size)) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const manifestEntry = entries.find(entry => entry.name === 'manifest.json');
  const databaseEntry = entries.find(entry => entry.name === 'gateway.db');
  assert.ok(manifestEntry && databaseEntry, 'a real gateway backup is required');
  const manifest = JSON.parse(manifestEntry.bytes);
  const database = manifest.files.find(entry => entry.name === databaseEntry.name);
  assert.ok(database, 'gateway database must be in the manifest');
  for (const file of manifest.files) {
    const entry = entries.find(item => item.name === file.name);
    assert.ok(entry && entry.bytes.length === file.size && sha256(entry.bytes) === file.sha256, 'source archive checksum mismatch');
  }
  assert.ok(existsSync(tmpdir()), 'fixture temporary directory parent must exist');
  const directory = mkdtempSync(join(tmpdir(), 'llmgw-future-schema-'));
  let schemaVersion;
  try {
    const path = join(directory, 'gateway.db');
    writeFileSync(path, databaseEntry.bytes, { mode: 0o600, flag: 'wx' });
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA journal_mode=DELETE');
      const previous = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version;
      assert.ok(Number.isSafeInteger(previous) && previous > 0, 'the source must contain a migrated database');
      schemaVersion = previous + 1000;
      assert.equal(db.prepare('UPDATE schema_migrations SET version = ? WHERE version = ?').run(schemaVersion, previous).changes, 1);
    } finally { db.close(); }
    databaseEntry.bytes = readFileSync(path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  database.size = databaseEntry.bytes.length;
  database.sha256 = sha256(databaseEntry.bytes);
  manifestEntry.bytes = Buffer.from(JSON.stringify(manifest));
  const parts = [];
  for (const entry of entries) {
    entry.header.fill(0, 124, 136);
    entry.header.write(entry.bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    entry.header.fill(32, 148, 156);
    const checksum = entry.header.reduce((sum, byte) => sum + byte, 0);
    entry.header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    parts.push(entry.header, entry.bytes, Buffer.alloc((512 - entry.bytes.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return { bytes: gzipSync(Buffer.concat(parts)), schemaVersion };
}
