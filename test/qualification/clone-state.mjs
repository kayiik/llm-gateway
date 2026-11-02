import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, chownSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const source = '/source', destination = '/state';
assert.equal(readdirSync(destination).length, 0, 'copy only into a new disposable volume');
const paths = [];
function copy(prefix = '') {
  for (const name of readdirSync(join(source, prefix)).sort()) {
    const relative = prefix ? prefix + '/' + name : name, from = join(source, relative), to = join(destination, relative);
    const stat = lstatSync(from); assert.ok(stat.isFile() || stat.isDirectory(), 'only regular state files are allowed');
    if (stat.isDirectory()) { mkdirSync(to); copy(relative); } else copyFileSync(from, to);
    chownSync(to, stat.uid, stat.gid); chmodSync(to, stat.mode & 0o777);
    if (stat.isFile()) { const bytes = readFileSync(from); assert.ok(bytes.equals(readFileSync(to))); paths.push([relative, createHash('sha256').update(bytes).digest('hex')]); }
  }
}
copy(); const owner = statSync(source); chownSync(destination, owner.uid, owner.gid); chmodSync(destination, owner.mode & 0o777);
assert.ok(paths.some(([name]) => name === 'gateway.db'), 'the sealed copy must include the actual IAM state database');
console.log(JSON.stringify({ copied: true, fileCount: paths.length, sha256: createHash('sha256').update(JSON.stringify(paths)).digest('hex') }));
