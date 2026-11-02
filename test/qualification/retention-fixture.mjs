import assert from 'node:assert/strict';
import { chmodSync, chownSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const operation = process.argv[2], root = '/artifacts', database = '/state/gateway.db';
assert.ok(['seed', 'verify'].includes(operation));
const db = new DatabaseSync(database, { readOnly: operation === 'verify' });
const day = 86400, now = Math.floor(Date.now() / 1000), old = now - 730 * day, recent = now - day;
const one = (query, ...args) => Number(db.prepare(query).get(...args).value);
if (operation === 'seed') {
  const key = db.prepare('SELECT id,project_id FROM api_keys ORDER BY id LIMIT 1').get(); assert.ok(key?.id && key.project_id);
  const baseline = { principals: one('SELECT count(*) AS value FROM principals'), keys: one('SELECT count(*) AS value FROM api_keys'), projects: one('SELECT count(*) AS value FROM projects') };
  db.exec('BEGIN IMMEDIATE');
  try {
    const usage = db.prepare('INSERT INTO usage_events(request_id,ts,endpoint,status_code) VALUES(?,?,?,200)');
    for (let index = 0; index < 537; index++) usage.run('retention-fixture-old-' + index, old, 'qualification.retention');
    usage.run('retention-fixture-recent', recent, 'qualification.retention');
    const audit = db.prepare("INSERT INTO audit_events(ts,action,result,detail_json) VALUES(?,?,'success','{}')");
    audit.run(old, 'qualification.retention.old'); audit.run(recent, 'qualification.retention.recent');
    const outbox = db.prepare('INSERT INTO outbox_events(ts,kind,payload_json,status,available_at,delivered_at) VALUES(?,?,?, ?, ?, ?)');
    for (const [status, timestamp] of [['delivered', old], ['delivered', recent], ['pending', null], ['failed', null]]) outbox.run(old, 'retention_fixture', '{}', status, old, timestamp);
    db.prepare("INSERT OR IGNORE INTO quota_counters(key_id,period,period_start,requests) VALUES(?,'day',?,1)").run(key.id, old);
    db.prepare("INSERT OR IGNORE INTO project_quota_counters(project_id,period,period_start,requests) VALUES(?,'day',?,1)").run(key.project_id, old);
    db.prepare("INSERT OR IGNORE INTO target_quota_counters(provider_id,model,period,period_start,requests) VALUES('retention-fixture','fixture','day',?,1)").run(old);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  db.close();
  for (const name of readdirSync('/state').filter(name => name.startsWith('gateway.db'))) { chownSync('/state/' + name, 65532, 65532); chmodSync('/state/' + name, 0o600); }
  writeFileSync(root + '/retention-seed-private.json', JSON.stringify({ baseline, seededAt: now, old, recent }) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ seeded: true, oldRows: 537, recentRows: 1 }));
} else {
  const { baseline } = JSON.parse(readFileSync(root + '/retention-seed-private.json', 'utf8'));
  const result = { boundary: 'Installed startup retention prunes batches of expired history while preserving current identity, quota periods and retryable events on a stopped-state copy', pass: false, cases: [] };
  const test = (name, run) => { const row = { name, pass: false }; result.cases.push(row); try { run(row); row.pass = true; } catch (error) { row.error = error.message; } };
  test('expired-usage-history-prunes-across-more-than-one-retention-batch', row => {
    assert.equal(one("SELECT count(*) AS value FROM usage_events WHERE request_id LIKE 'retention-fixture-old-%'"), 0);
    assert.equal(one("SELECT count(*) AS value FROM usage_events WHERE request_id='retention-fixture-recent'"), 1); row.oldRowsRemoved = 537;
  });
  test('old-audit-and-delivered-outbox-prune-but-pending-failed-and-recent-survive', row => {
    assert.equal(one("SELECT count(*) AS value FROM audit_events WHERE action='qualification.retention.old'"), 0);
    assert.equal(one("SELECT count(*) AS value FROM audit_events WHERE action='qualification.retention.recent'"), 1);
    assert.equal(one("SELECT count(*) AS value FROM outbox_events WHERE kind='retention_fixture' AND status='delivered'"), 1);
    assert.equal(one("SELECT count(*) AS value FROM outbox_events WHERE kind='retention_fixture' AND status IN ('pending','failed')"), 2);
    row.retryableEventsPreserved = 2;
  });
  test('old-quota-periods-prune-without-touching-active-identities-or-current-counters', row => {
    for (const table of ['quota_counters', 'project_quota_counters', 'target_quota_counters']) assert.equal(one(`SELECT count(*) AS value FROM ${table} WHERE period='day' AND period_start<?`, now - day), 0, table);
    for (const [table, count] of [['principals', baseline.principals], ['api_keys', baseline.keys], ['projects', baseline.projects]]) assert.equal(one(`SELECT count(*) AS value FROM ${table}`), count);
    assert.ok(one("SELECT count(*) AS value FROM project_quota_counters WHERE period='day' AND period_start>=?", now - day) > 0);
    row.activeIdentityUnchanged = true;
  });
  db.close(); result.pass = result.cases.length === 3 && result.cases.every(row => row.pass);
  writeFileSync(root + '/retention-results.json', JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(result)); if (!result.pass) process.exitCode = 1;
}
