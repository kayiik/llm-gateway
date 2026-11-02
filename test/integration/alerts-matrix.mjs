import assert from 'node:assert/strict';

export async function runAlertsMatrix({ admin, request, metrics, save, registerSecret }) {
  const evidence = { boundary: 'Installed alert-rule validation, scheduled key-expiry outbox, worker leasing/settlement and bounded failures; no delivery transport', pass: false, cases: [] };
  const test = async (name, run) => { const row = { name, pass: false }; evidence.cases.push(row); try { await run(row); row.pass = true; } catch (error) { row.error = error.message; } finally { save('alerts-matrix.json', evidence); } };
  const project = await admin('projects', { slug: 'alerts-installed-matrix', name: 'Installed alert test project' });
  let expiryRule, event;
  await test('alert-rule-metric-period-threshold-and-owner-scope-validate-before-save', async row => {
    const invalid = [
      { kind: 'quota_usage', metric: 'input_tokens', period: 'month', threshold: 80 },
      { kind: 'quota_usage', metric: 'requests', period: 'hour', threshold: 80 },
      { kind: 'quota_usage', metric: 'requests', period: 'day', threshold: 0 },
      { kind: 'quota_usage', metric: 'requests', period: 'day', threshold: 101 },
      { kind: 'unsupported', metric: 'requests', period: 'day', threshold: 80 },
    ];
    for (const body of invalid) { const response = await request('/admin/api/alerts', { project_id: project.id, ...body }); assert.equal(response.status, 400, response.text); }
    const quota = await admin('alerts', { project_id: project.id, kind: 'quota_usage', metric: 'requests', period: 'day', threshold: 80 }); assert.ok(quota.id);
    expiryRule = await admin('alerts', { project_id: project.id, kind: 'key_expiry', threshold: 1 }); assert.ok(expiryRule.id);
    const listed = await admin('alerts'); assert.ok(listed.rules.some(item => item.id === quota.id)); assert.ok(listed.rules.some(item => item.id === expiryRule.id)); row.invalidRefusals = invalid.length;
  });
  await test('scheduled-key-expiry-evaluation-enqueues-exactly-once', async row => {
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const key = await admin('keys', { project_id: project.id, name: 'Installed expiry first', expires_at: expiry }); assert.ok(key.key.id);
    const first = await admin('alerts/evaluate', {}); assert.equal(first.enqueued, 1, JSON.stringify(first));
    const again = await admin('alerts/evaluate', {}); assert.equal(again.enqueued, 0, 'one expiry must not enqueue duplicate events');
    const listed = await admin('outbox?limit=10'); event = listed.events.find(item => item.project_id === project.id && item.kind === 'key_expiring'); assert.ok(event);
    assert.equal(event.status, 'pending'); row.enqueued = 1;
  });
  await test('worker-lease-is-exclusive-and-wrong-worker-cannot-settle', async row => {
    const first = await admin('outbox/claim', { worker_id: 'qualification-delivery-one', limit: 1, lease_seconds: 60 });
    assert.deepEqual(first.events.map(item => item.id), [event.id]);
    const other = await admin('outbox/claim', { worker_id: 'qualification-delivery-two', limit: 1, lease_seconds: 60 }); assert.deepEqual(other.events, []);
    const foreign = await request(`/admin/api/outbox/${event.id}/delivered`, { worker_id: 'qualification-delivery-two' }); assert.equal(foreign.status, 404);
    await admin(`outbox/${event.id}/delivered`, { worker_id: 'qualification-delivery-one' });
    const listing = await admin(`deliveries?status=delivered&project_id=${project.id}&limit=5`);
    assert.ok(listing.deliveries.some(item => item.id === event.id && item.status === 'delivered' && item.attempts === 1)); row.delivered = 1;
  });
  await test('failed-worker-retries-stop-at-ten-and-persist-safe-delivery-detail', async row => {
    const key = await admin('keys', { project_id: project.id, name: 'Installed expiry retry', expires_at: Math.floor(Date.now() / 1000) + 3600 }); assert.ok(key.key.id);
    const enqueued = await admin('alerts/evaluate', {}); assert.equal(enqueued.enqueued, 1);
    const pending = await admin('outbox?limit=10'); const failed = pending.events.find(item => item.project_id === project.id && item.id !== event.id); assert.ok(failed);
    const secret = 'fixture-alert-secret'; registerSecret(secret);
    for (let attempt = 0; attempt < 10; attempt++) {
      const leased = await admin('outbox/claim', { worker_id: 'qualification-delivery-failing', limit: 1, lease_seconds: 60 });
      assert.deepEqual(leased.events.map(item => item.id), [failed.id]);
      await admin(`outbox/${failed.id}/failed`, { worker_id: 'qualification-delivery-failing', error: `Bearer ${secret}: controlled delivery failure`, retry_at: Math.floor(Date.now() / 1000) - 1 });
    }
    const exhausted = await admin('outbox/claim', { worker_id: 'qualification-delivery-failing', limit: 1, lease_seconds: 60 }); assert.deepEqual(exhausted.events, []);
    const listing = await admin(`deliveries?status=exhausted&project_id=${project.id}&limit=5`);
    const retained = listing.deliveries.find(item => item.id === failed.id); assert.ok(retained); assert.equal(retained.attempts, 10); assert.equal(retained.exhausted, true);
    assert.ok(!JSON.stringify(retained).includes(secret)); assert.ok(retained.last_error, 'a safe failure explanation must remain inspectable'); row.attempts = 10;
  });
  await test('disabled-rule-stops-new-evaluation-and-delivery-filters-are-scoped', async row => {
    await admin('alerts/status', { id: expiryRule.id, enabled: false });
    await admin('keys', { project_id: project.id, name: 'Installed expiry disabled', expires_at: Math.floor(Date.now() / 1000) + 3600 });
    assert.equal((await admin('alerts/evaluate', {})).enqueued, 0);
    const delivered = await admin(`deliveries?status=delivered&project_id=${project.id}&limit=1`);
    assert.deepEqual(delivered.deliveries.map(item => item.id), [event.id]);
    const before = (await metrics()).inference;
    assert.equal((await request('/admin/api/outbox/claim', { worker_id: '' })).status, 400);
    assert.equal((await metrics()).inference, before); row.disabledRuleEnqueues = 0;
  });
  evidence.pass = evidence.cases.length === 5 && evidence.cases.every(row => row.pass);
  save('alerts-matrix.json', evidence);
  assert.equal(evidence.pass, true, evidence.cases.filter(row => !row.pass).map(row => row.name + ': ' + row.error).join('\n'));
}
