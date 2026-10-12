import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BRAND, addFinding, fakeMl, setup, signIn } from './helpers.js';

let ctx;
beforeEach(async () => {
  if (ctx) await ctx.pool.end();
  ctx = await setup();
});
afterAll(() => ctx?.pool.end());

const agentFor = (role) => signIn(request.agent(ctx.app), role);

describe('authentication', () => {
  it('rejects unauthenticated access to data', async () => {
    for (const path of ['/api/brands', '/api/findings?brandId=1', '/api/sources', '/api/auth/me']) {
      expect((await request(ctx.app).get(path)).status).toBe(401);
    }
  });

  it('signs in with an httpOnly cookie and signs out', async () => {
    const agent = request.agent(ctx.app);
    const login = await agent.post('/api/auth/login').send({ email: 'ANALYST@example.com', password: 'correct-horse-battery' });
    expect(login.status).toBe(200);
    expect(login.headers['set-cookie'][0]).toMatch(/sg_session=.*HttpOnly.*SameSite=Lax/i);
    expect(login.body.user).toEqual({ id: ctx.users.analyst.id, email: 'analyst@example.com', role: 'analyst' });
    expect(JSON.stringify(login.body)).not.toMatch(/password|hash/i);
    expect((await agent.get('/api/auth/me')).body.user.role).toBe('analyst');
    await agent.post('/api/auth/logout');
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrong = await request(ctx.app).post('/api/auth/login').send({ email: 'admin@example.com', password: 'nope' });
    const unknown = await request(ctx.app).post('/api/auth/login').send({ email: 'ghost@example.com', password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('rejects a tampered session token', async () => {
    const response = await request(ctx.app).get('/api/auth/me').set('Cookie', 'sg_session=eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.');
    expect(response.status).toBe(401);
  });

  it('rate-limits repeated sign-in attempts', async () => {
    let last;
    for (let i = 0; i < 11; i += 1) last = await request(ctx.app).post('/api/auth/login').send({ email: 'admin@example.com', password: 'wrong' });
    expect(last.status).toBe(429);
  });
});

describe('authorization', () => {
  it('lets viewers read but not change anything', async () => {
    const viewer = await agentFor('viewer');
    expect((await viewer.get('/api/brands')).status).toBe(200);
    expect((await viewer.post('/api/brands').send(BRAND)).status).toBe(403);
    expect((await viewer.post('/api/brands/demo')).status).toBe(403);
  });

  it('keeps user management and retraining to admins', async () => {
    const analyst = await agentFor('analyst');
    expect((await analyst.get('/api/users')).status).toBe(403);
    expect((await analyst.post('/api/model/retrain')).status).toBe(403);
    const admin = await agentFor('admin');
    expect((await admin.post('/api/users').send({ email: 'new@example.com', password: 'long-enough-password', role: 'viewer' })).status).toBe(201);
    expect((await admin.post('/api/users').send({ email: 'new2@example.com', password: 'short', role: 'viewer' })).status).toBe(400);
  });

  it('applies a demotion immediately, even with an existing session', async () => {
    const agent = await agentFor('analyst');
    await ctx.pool.query("UPDATE users SET role='viewer' WHERE id=$1", [ctx.users.analyst.id]);
    expect((await agent.post('/api/brands').send(BRAND)).status).toBe(403);
  });
});

describe('input validation and request safety', () => {
  it('validates brand profiles', async () => {
    const analyst = await agentFor('analyst');
    const bad = await analyst.post('/api/brands').send({ ...BRAND, domain: 'not a domain' });
    expect(bad.status).toBe(400);
    expect(bad.body.issues[0].path).toBe('domain');
    expect((await analyst.post('/api/brands').send({ ...BRAND, logoUrl: 'http://169.254.169.254/x.png' })).status).toBe(400);
    expect((await analyst.post('/api/brands').send({ ...BRAND, mode: 'demo' })).status).toBe(400); // unknown keys refused
    expect((await analyst.post('/api/brands').send({ ...BRAND, scanIntervalMinutes: 5 })).status).toBe(400);
  });

  it('refuses cross-site and non-JSON writes', async () => {
    const analyst = await agentFor('analyst');
    expect((await analyst.post('/api/brands').set('Origin', 'https://evil.example').send(BRAND)).status).toBe(403);
    expect((await analyst.post('/api/brands').set('Content-Type', 'text/plain').send('name=x')).status).toBe(415);
    expect((await analyst.post('/api/brands').set('Content-Type', 'application/json').send('{bad json')).status).toBe(400);
  });

  it('treats search text as data, not SQL', async () => {
    const analyst = await agentFor('analyst');
    const brand = (await analyst.post('/api/brands').send(BRAND)).body;
    await addFinding(ctx.pool, brand.id);
    const response = await analyst.get('/api/findings').query({ brandId: brand.id, q: "x' OR 1=1; DROP TABLE findings; --" });
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(0);
    expect((await analyst.get('/api/findings').query({ brandId: brand.id, sort: 'score; DROP TABLE x' })).status).toBe(400);
  });

  it('sets security headers', async () => {
    const response = await request(ctx.app).get('/api/health');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

describe('brands, scans and findings', () => {
  it('creates a live brand and queues one scan at a time', async () => {
    const analyst = await agentFor('analyst');
    const brand = (await analyst.post('/api/brands').send(BRAND)).body;
    expect(brand.mode).toBe('live');
    expect((await analyst.post('/api/brands').send(BRAND)).status).toBe(409);
    const scan = await analyst.post(`/api/brands/${brand.id}/scans`);
    expect(scan.status).toBe(202);
    expect(scan.body).toMatchObject({ status: 'queued', mode: 'live', trigger: 'manual' });
    expect((await analyst.post(`/api/brands/${brand.id}/scans`)).status).toBe(409);
    expect((await analyst.get(`/api/brands/${brand.id}/scans`)).body).toHaveLength(1);
  });

  it('creates the demo brand in demo mode and keeps it read-only', async () => {
    const analyst = await agentFor('analyst');
    const demo = (await analyst.post('/api/brands/demo')).body;
    expect(demo).toMatchObject({ name: 'Northstar', mode: 'demo' });
    expect((await analyst.put(`/api/brands/${demo.id}`).send(BRAND)).status).toBe(400);
    const scan = (await analyst.post(`/api/brands/${demo.id}/scans`)).body;
    expect(scan.mode).toBe('demo');
  });

  it('records review decisions with an audit trail, feedback and allowlisting', async () => {
    const analyst = await agentFor('analyst');
    const brand = (await analyst.post('/api/brands').send(BRAND)).body;
    const finding = await addFinding(ctx.pool, brand.id, { externalId: 'did:plc:fake' });

    expect((await analyst.patch(`/api/findings/${finding.id}`).send({ status: 'confirmed', note: 'Asks for card numbers' })).body.status).toBe('confirmed');
    await analyst.post(`/api/findings/${finding.id}/notes`).send({ note: 'Takedown requested' });
    expect((await analyst.patch(`/api/findings/${finding.id}`).send({ status: 'official', note: 'Verified on the official website' })).status).toBe(200);

    const detail = (await analyst.get(`/api/findings/${finding.id}`)).body;
    expect(detail.events.map((e) => e.kind)).toEqual(['status_change', 'note', 'status_change']);
    expect(detail.events[0]).toMatchObject({ fromStatus: 'new', toStatus: 'confirmed', note: 'Asks for card numbers', actor: 'analyst@example.com' });
    const allow = (await analyst.get(`/api/brands/${brand.id}/allowlist`)).body;
    expect(allow.map((a) => a.external_id)).toEqual(['did:plc:fake']);
    const feedback = (await ctx.pool.query('SELECT label FROM ml_feedback WHERE finding_id=$1', [finding.id])).rows;
    expect(feedback).toEqual([{ label: 0 }]); // one row per finding, from the latest decision

    await analyst.patch(`/api/findings/${finding.id}`).send({ status: 'reviewing' });
    expect((await analyst.get(`/api/brands/${brand.id}/allowlist`)).body).toEqual([]);
  });

  it('filters findings and exports CSV safely', async () => {
    const analyst = await agentFor('analyst');
    const brand = (await analyst.post('/api/brands').send(BRAND)).body;
    await addFinding(ctx.pool, brand.id, { name: '=HYPERLINK("http://evil")', score: 91, severity: 'Critical' });
    await addFinding(ctx.pool, brand.id, { name: 'Acme Pay Rewards', type: 'app', platform: 'Google Play', score: 60, severity: 'Medium' });
    const critical = (await analyst.get('/api/findings').query({ brandId: brand.id, severity: 'Critical' })).body;
    expect(critical.total).toBe(1);
    const apps = (await analyst.get('/api/findings').query({ brandId: brand.id, type: 'app', minScore: 50 })).body;
    expect(apps.items.map((f) => f.name)).toEqual(['Acme Pay Rewards']);
    const csv = await analyst.get('/api/findings/export.csv').query({ brandId: brand.id });
    expect(csv.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });

  it('exports evidence with the risk-estimate notice', async () => {
    const analyst = await agentFor('analyst');
    const brand = (await analyst.post('/api/brands').send(BRAND)).body;
    const finding = await addFinding(ctx.pool, brand.id);
    const evidence = (await analyst.get(`/api/findings/${finding.id}/evidence.json`)).body;
    expect(evidence.notice).toMatch(/not proof/);
    expect(evidence.finding.evidence.url).toBe('https://bsky.app/profile/x');
  });

  it('summarises open findings by severity, type and platform', async () => {
    const analyst = await agentFor('analyst');
    const brand = (await analyst.post('/api/brands').send(BRAND)).body;
    await addFinding(ctx.pool, brand.id);
    const summary = (await analyst.get(`/api/brands/${brand.id}/summary`)).body;
    expect(summary.bySeverity).toEqual({ Critical: 1 });
    expect(summary.byPlatform).toEqual([{ platform: 'Bluesky', count: 1 }]);
  });
});

describe('sources, ML and scheduled work', () => {
  it('merges the source catalogue with recorded health', async () => {
    await ctx.pool.query("INSERT INTO source_health (source_key, label, status, message, consecutive_failures) VALUES ('bluesky', 'Bluesky', 'rate_limited', 'Rate limited', 2)");
    const viewer = await agentFor('viewer');
    const { sources } = (await viewer.get('/api/sources')).body;
    expect(sources.find((s) => s.key === 'bluesky')).toMatchObject({ lastStatus: 'rate_limited', consecutiveFailures: 2 });
    expect(sources.find((s) => s.key === 'tiktok')).toMatchObject({ support: 'unsupported', lastStatus: null });
  });

  it('reports the detection service as unavailable instead of inventing results', async () => {
    const { MlUnavailableError } = await import('../../server/ml.js');
    await ctx.pool.end();
    ctx = await setup({ ml: fakeMl({ lookalike: () => Promise.reject(new MlUnavailableError('The detection service is unreachable (ECONNREFUSED).')), health: () => Promise.reject(new MlUnavailableError('down')) }) });
    const analyst = await agentFor('analyst');
    const brand = (await analyst.post('/api/brands').send(BRAND)).body;
    const response = await analyst.post('/api/lookalike').query({ brandId: brand.id }).send({ names: ['Acme Pay Support'] });
    expect(response.status).toBe(503);
    expect(response.body.error).toMatch(/unreachable/);
    expect((await request(ctx.app).get('/api/health')).body).toMatchObject({ status: 'degraded', ml: 'unavailable', database: 'ok' });
  });

  it('protects the cron endpoint with a secret', async () => {
    await ctx.pool.end();
    ctx = await setup({ config: { cronSecret: 'cron-secret-value-1234567890' } });
    expect((await request(ctx.app).get('/api/internal/cron')).status).toBe(401);
    expect((await request(ctx.app).get('/api/internal/cron').set('Authorization', 'Bearer wrong')).status).toBe(401);
    expect((await request(ctx.app).get('/api/internal/cron').set('Authorization', 'Bearer cron-secret-value-1234567890')).status).toBe(200);
    expect(ctx.ml.calls.some(([name]) => name === 'runWorker')).toBe(true);
  });

  it('disables the cron endpoint when no secret is configured', async () => {
    expect((await request(ctx.app).get('/api/internal/cron').set('Authorization', 'Bearer ')).status).toBe(503);
  });
});

describe('configuration', () => {
  it('refuses to start in production without a strong secret and origin', async () => {
    const { loadConfig } = await import('../../server/config.js');
    expect(() => loadConfig({ production: true, jwtSecret: 'short', databaseUrl: 'postgres://x' })).toThrow(/JWT_SECRET/);
  });
});
