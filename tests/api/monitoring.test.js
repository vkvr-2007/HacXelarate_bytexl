// Phase 3: worker liveness, scheduler cadence and alert delivery records.
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BRAND, fakeMl, setup, signIn } from './helpers.js';

let ctx;
beforeEach(async () => { if (ctx) await ctx.pool.end(); ctx = undefined; });
afterAll(() => ctx?.pool.end());
const as = (role) => signIn(request.agent(ctx.app), role);

describe('system status', () => {
  it('says no worker is active until one checks in, and what kind it is', async () => {
    ctx = await setup();
    const agent = await as('viewer');
    expect((await agent.get('/api/system')).body.worker).toEqual({ active: false, kind: null, lastSeenAt: null });
    await ctx.pool.query("INSERT INTO workers (name, kind, last_seen_at) VALUES ('worker:a', 'worker', now() - interval '20 seconds')");
    expect((await agent.get('/api/system')).body.worker).toMatchObject({ active: true, kind: 'worker' });
    await ctx.pool.query("UPDATE workers SET last_seen_at = now() - interval '10 minutes'");
    expect((await agent.get('/api/system')).body.worker.active).toBe(false); // a polling worker that stopped is not "active"
  });

  it('treats a daily cron as alive for a day, not a minute', async () => {
    ctx = await setup({ config: { schedulerCadenceMinutes: 1440 } });
    await ctx.pool.query("INSERT INTO workers (name, kind, last_seen_at) VALUES ('cron:x', 'cron', now() - interval '20 hours')");
    const body = (await (await as('viewer')).get('/api/system')).body;
    expect(body.worker).toMatchObject({ active: true, kind: 'cron' });
    expect(body.scheduler).toEqual({ cadenceMinutes: 1440, kind: 'cron', canRunOnDemand: false });
  });

  it('reports whether alerts can be sent, and needs a session', async () => {
    ctx = await setup({ ml: fakeMl({ health: () => Promise.resolve({ model: 'm', metrics: {}, sources: [], alerts: { configured: false } }) }) });
    expect((await (await as('viewer')).get('/api/system')).body.alerts).toEqual({ configured: false });
    expect((await request(ctx.app).get('/api/system')).status).toBe(401);
  });

  it('degrades to "unknown" when the detection service is down', async () => {
    ctx = await setup({ ml: fakeMl({ health: () => Promise.reject(new Error('down')) }) });
    expect((await (await as('viewer')).get('/api/system')).body.alerts).toEqual({ configured: null });
  });
});

describe('alert deliveries', () => {
  let brand;
  beforeEach(async () => {
    ctx = await setup();
    brand = (await (await as('analyst')).post('/api/brands').send(BRAND)).body;
  });

  it('lists recent deliveries with their failure reason', async () => {
    await ctx.pool.query(`INSERT INTO alert_deliveries (brand_id, kind, ok, error, finding_ids) VALUES ($1, 'findings', false, 'Webhook answered HTTP 500', '[1,2]'), (NULL, 'test', true, NULL, '[]')`, [brand.id]);
    const list = (await (await as('viewer')).get('/api/alerts').query({ brandId: brand.id })).body;
    expect(list.map((a) => [a.kind, a.ok, a.error, a.findings])).toEqual(expect.arrayContaining([['findings', false, 'Webhook answered HTTP 500', 2], ['test', true, null, 0]]));
  });

  it('only analysts retry and only admins send a test; both are audited', async () => {
    expect((await (await as('viewer')).post('/api/alerts/1/retry')).status).toBe(403);
    expect((await (await as('analyst')).post('/api/alerts/test')).status).toBe(403);
    expect((await (await as('analyst')).post('/api/alerts/abc/retry')).status).toBe(400);
    expect((await (await as('analyst')).post('/api/alerts/7/retry')).status).toBe(200);
    expect(ctx.ml.calls.filter((c) => c[0] === 'retryAlert')).toEqual([['retryAlert', '7']]);
    expect((await (await as('admin')).post('/api/alerts/test')).body).toEqual({ ok: true, error: null });
    const kinds = (await ctx.pool.query('SELECT kind FROM audit_log')).rows.map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['alert_retry', 'alert_test']));
  });

  it('reports a failed test alert as a 502 with the reason', async () => {
    await ctx.pool.end();
    ctx = await setup({ ml: fakeMl({ testAlert: () => Promise.resolve({ ok: false, error: 'Webhook not reachable (ConnectError)' }) }) });
    const response = await (await as('admin')).post('/api/alerts/test');
    expect(response.status).toBe(502);
    expect(response.body.error).toBe('Webhook not reachable (ConnectError)');
  });
});

describe('what a scan found', () => {
  it('lists the findings a scan observed and which of them it detected first', async () => {
    ctx = await setup();
    const agent = await as('analyst');
    const brand = (await agent.post('/api/brands').send(BRAND)).body;
    const scans = [];
    for (let i = 0; i < 2; i += 1) scans.push((await ctx.pool.query("INSERT INTO scans (brand_id, mode, status) VALUES ($1, 'live', 'succeeded') RETURNING id", [brand.id])).rows[0].id);
    const add = async (name, score) => (await ctx.pool.query(`INSERT INTO findings (brand_id, mode, type, platform, external_id, name, source_key, score, severity)
      VALUES ($1, 'live', 'social', 'X', $2, $2, 'x', $3, 'High') RETURNING id`, [brand.id, name, score])).rows[0].id;
    const a = await add('first', 80);
    const b = await add('second', 90);
    const see = (finding, scan, score) => ctx.pool.query("INSERT INTO finding_observations (finding_id, scan_id, source_key, score, severity) VALUES ($1, $2, 'x', $3, 'High')", [finding, scan, score]);
    await see(a, scans[0], 80);
    await see(a, scans[1], 82);
    await see(b, scans[1], 90);
    await ctx.pool.query("INSERT INTO finding_events (finding_id, scan_id, kind) VALUES ($1, $2, 'detected'), ($3, $4, 'detected')", [a, scans[0], b, scans[1]]);
    const first = (await agent.get(`/api/scans/${scans[0]}/findings`)).body;
    expect(first.items.map((f) => [f.name, f.score, f.newInScan])).toEqual([['first', 80, true]]);
    const second = (await agent.get(`/api/scans/${scans[1]}/findings`)).body;
    expect(second.items.map((f) => [f.name, f.score, f.newInScan])).toEqual([['second', 90, true], ['first', 82, false]]);
    expect((await agent.get('/api/scans/99999/findings')).status).toBe(404);
    expect((await request(ctx.app).get(`/api/scans/${scans[0]}/findings`)).status).toBe(401);
  });
});
