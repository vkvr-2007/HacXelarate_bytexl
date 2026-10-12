import { SignJWT } from 'jose';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../server/app.js';
import { loadConfig } from '../../server/config.js';
import { createPool } from '../../server/db.js';
import { PASSWORD, TEST_DB, fakeMl, setup, signIn } from './helpers.js';

let ctx;
beforeEach(async () => {
  if (ctx) await ctx.pool.end();
  ctx = await setup();
});
afterAll(() => ctx?.pool.end());

const agentFor = (role) => signIn(request.agent(ctx.app), role);
const cookieOf = async (role) => {
  const response = await request(ctx.app).post('/api/auth/login').send({ email: `${role}@example.com`, password: PASSWORD });
  return response.headers['set-cookie'][0].split(';')[0];
};

describe('sessions', () => {
  it('logout revokes the session on the server, so a copied cookie stops working', async () => {
    const cookie = await cookieOf('analyst');
    expect((await request(ctx.app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(200);
    await request(ctx.app).post('/api/auth/logout').set('Cookie', cookie);
    expect((await request(ctx.app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('rejects an expired token and a token for a revoked or unknown session', async () => {
    const key = new TextEncoder().encode(ctx.config.jwtSecret);
    const expired = await new SignJWT({ sid: '00000000-0000-4000-8000-000000000000' }).setProtectedHeader({ alg: 'HS256' }).setSubject(String(ctx.users.admin.id)).setExpirationTime('-1m').sign(key);
    expect((await request(ctx.app).get('/api/auth/me').set('Cookie', `sg_session=${expired}`)).status).toBe(401);
    const unknown = await new SignJWT({ sid: '00000000-0000-4000-8000-000000000000' }).setProtectedHeader({ alg: 'HS256' }).setSubject(String(ctx.users.admin.id)).setExpirationTime('1h').sign(key);
    expect((await request(ctx.app).get('/api/auth/me').set('Cookie', `sg_session=${unknown}`)).status).toBe(401);
  });

  it('ends sessions of an expired row in the database', async () => {
    const cookie = await cookieOf('viewer');
    await ctx.pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute'");
    expect((await request(ctx.app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('does not report a database failure as "signed out"', async () => {
    const cookie = await cookieOf('analyst');
    const failing = { query: (sql, ...rest) => (String(sql).includes('FROM sessions') ? Promise.reject(Object.assign(new Error('connection lost'), { code: '08006' })) : ctx.pool.query(sql, ...rest)) };
    const app = createApp({ config: ctx.config, pool: failing, ml: fakeMl(), logger: { error: () => {} } });
    const response = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toMatch(/connection lost/);
  });

  it('answers a login database error with a generic 500', async () => {
    const failing = { query: () => Promise.reject(new Error('password authentication failed for user "postgres"')) };
    const app = createApp({ config: ctx.config, pool: failing, ml: fakeMl(), logger: { error: () => {} } });
    const response = await request(app).post('/api/auth/login').send({ email: 'a@example.com', password: 'x' });
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toMatch(/password authentication|postgres/);
  });
});

describe('login input and throttling', () => {
  it('rejects malformed input without touching the database', async () => {
    for (const body of [{}, { email: 'x' }, { email: 'a@example.com', password: 5 }, { email: 'a@example.com', password: 'x'.repeat(500) }, { email: 'a@example.com', password: 'x', admin: true }]) {
      expect((await request(ctx.app).post('/api/auth/login').send(body)).status).toBe(400);
    }
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM login_failures')).rows[0].n).toBe(0);
  });

  it('locks an email after repeated failures, across app instances, and a correct password cannot bypass it', async () => {
    for (let i = 0; i < 5; i += 1) await request(ctx.app).post('/api/auth/login').send({ email: 'viewer@example.com', password: 'wrong-password' });
    const second = createApp({ config: ctx.config, pool: ctx.pool, ml: fakeMl(), logger: { error: () => {} } }); // another "serverless instance"
    const locked = await request(second).post('/api/auth/login').send({ email: 'viewer@example.com', password: PASSWORD });
    expect(locked.status).toBe(429);
    expect((await request(second).post('/api/auth/login').send({ email: 'analyst@example.com', password: PASSWORD })).status).toBe(200); // other accounts unaffected
  });

  it('records failed and successful sign-ins in the audit log', async () => {
    await request(ctx.app).post('/api/auth/login').send({ email: 'admin@example.com', password: 'wrong' });
    const admin = await agentFor('admin');
    const kinds = (await admin.get('/api/audit')).body.map((row) => row.kind);
    expect(kinds).toEqual(expect.arrayContaining(['login_failed', 'login']));
    expect((await (await agentFor('analyst')).get('/api/audit')).status).toBe(403);
  });
});

describe('account lifecycle', () => {
  it('changes a password: wrong current is refused, other sessions are revoked, the old password stops working', async () => {
    const other = await cookieOf('analyst');
    const agent = await agentFor('analyst');
    expect((await agent.post('/api/auth/password').send({ currentPassword: 'nope', newPassword: 'another-long-password' })).status).toBe(400);
    expect((await agent.post('/api/auth/password').send({ currentPassword: PASSWORD, newPassword: 'short' })).status).toBe(400);
    expect((await agent.post('/api/auth/password').send({ currentPassword: PASSWORD, newPassword: 'another-long-password' })).status).toBe(204);
    expect((await request(ctx.app).get('/api/auth/me').set('Cookie', other)).status).toBe(401);
    expect((await agent.get('/api/auth/me')).status).toBe(200); // the session that made the change continues
    expect((await request(ctx.app).post('/api/auth/login').send({ email: 'analyst@example.com', password: PASSWORD })).status).toBe(401);
    expect((await request(ctx.app).post('/api/auth/login').send({ email: 'analyst@example.com', password: 'another-long-password' })).status).toBe(200);
  });

  it('disables an account: its sessions end and it cannot sign in', async () => {
    const cookie = await cookieOf('viewer');
    const admin = await agentFor('admin');
    expect((await admin.patch(`/api/users/${ctx.users.viewer.id}`).send({ disabled: true })).body.disabled_at).toBeTruthy();
    expect((await request(ctx.app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
    expect((await request(ctx.app).post('/api/auth/login').send({ email: 'viewer@example.com', password: PASSWORD })).status).toBe(401);
    await admin.patch(`/api/users/${ctx.users.viewer.id}`).send({ disabled: false });
    expect((await request(ctx.app).post('/api/auth/login').send({ email: 'viewer@example.com', password: PASSWORD })).status).toBe(200);
  });

  it('protects the last admin and refuses self-changes', async () => {
    const admin = await agentFor('admin');
    expect((await admin.patch(`/api/users/${ctx.users.admin.id}`).send({ role: 'viewer' })).status).toBe(400);
    expect((await admin.patch(`/api/users/${ctx.users.admin.id}`).send({ disabled: true })).status).toBe(400);
    await ctx.pool.query("UPDATE users SET role='admin' WHERE id=$1", [ctx.users.analyst.id]);
    expect((await admin.patch(`/api/users/${ctx.users.analyst.id}`).send({ role: 'viewer' })).status).toBe(200); // two admins: allowed
    expect((await admin.patch('/api/users/999999').send({ role: 'viewer' })).status).toBe(404);
    expect((await admin.patch(`/api/users/${ctx.users.viewer.id}`).send({})).status).toBe(400);
    expect((await admin.patch(`/api/users/${ctx.users.viewer.id}`).send({ role: 'root' })).status).toBe(400);
  });

  it('lets only admins change roles, disable users or reset passwords', async () => {
    const analyst = await agentFor('analyst');
    expect((await analyst.patch(`/api/users/${ctx.users.viewer.id}`).send({ role: 'admin' })).status).toBe(403);
    expect((await analyst.post(`/api/users/${ctx.users.viewer.id}/password`).send({ newPassword: 'a-new-long-password' })).status).toBe(403);
    expect((await request(ctx.app).patch(`/api/users/${ctx.users.viewer.id}`).send({ role: 'admin' })).status).toBe(401);
  });

  it('resets a password as admin, signing the user out and clearing their lockout', async () => {
    const cookie = await cookieOf('viewer');
    for (let i = 0; i < 5; i += 1) await request(ctx.app).post('/api/auth/login').send({ email: 'viewer@example.com', password: 'wrong' });
    const admin = await agentFor('admin');
    expect((await admin.post(`/api/users/${ctx.users.viewer.id}/password`).send({ newPassword: 'a-new-long-password' })).status).toBe(204);
    expect((await request(ctx.app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
    expect((await request(ctx.app).post('/api/auth/login').send({ email: 'viewer@example.com', password: 'a-new-long-password' })).status).toBe(200);
    const log = (await admin.get('/api/audit')).body;
    expect(log.find((row) => row.kind === 'password_reset')).toMatchObject({ target: 'viewer@example.com', actor: 'admin@example.com' });
  });

  it('refuses duplicate and invalid users, and there is no public registration or recovery route', async () => {
    const admin = await agentFor('admin');
    expect((await admin.post('/api/users').send({ email: 'ANALYST@example.com', password: 'long-enough-password', role: 'viewer' })).status).toBe(409);
    expect((await admin.post('/api/users').send({ email: 'not-an-email', password: 'long-enough-password' })).status).toBe(400);
    expect((await admin.post('/api/users').send({ email: 'x@example.com', password: 'long-enough-password', role: 'superuser' })).status).toBe(400);
    for (const path of ['/api/auth/register', '/api/auth/signup', '/api/auth/forgot', '/api/auth/reset']) {
      expect((await request(ctx.app).post(path).send({ email: 'x@example.com', password: 'long-enough-password' })).status).toBe(404);
    }
  });

  it('creates the first admin only when there are no users, from the environment, never from a default', async () => {
    await ctx.pool.end();
    ctx = await setup({ config: { adminEmail: 'boss@example.com', adminPassword: 'first-admin-password' } });
    expect(await ctx.app.locals.auth.bootstrapAdmin()).toBe(false); // users already exist
    await ctx.pool.query('DELETE FROM users');
    expect(await ctx.app.locals.auth.bootstrapAdmin()).toBe(true);
    expect((await request(ctx.app).post('/api/auth/login').send({ email: 'boss@example.com', password: 'first-admin-password' })).status).toBe(200);
    await ctx.pool.query('DELETE FROM users');
    const weak = createApp({ config: { ...ctx.config, adminPassword: 'short' }, pool: ctx.pool, ml: fakeMl() });
    await expect(weak.locals.auth.bootstrapAdmin()).rejects.toThrow(/12 characters/);
    const none = createApp({ config: { ...ctx.config, adminEmail: '', adminPassword: '' }, pool: ctx.pool, ml: fakeMl() });
    expect(await none.locals.auth.bootstrapAdmin()).toBe(false);
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(0);
  });

  it('stores only bcrypt hashes', async () => {
    const { rows } = await ctx.pool.query('SELECT password_hash FROM users');
    for (const row of rows) expect(row.password_hash).toMatch(/^\$2[aby]\$12\$/);
  });
});

describe('origin and configuration', () => {
  const post = (app, origin) => request(app).post('/api/auth/login').set('Origin', origin).send({ email: 'x@example.com', password: 'x' });

  it('accepts several configured origins and names the expected one when refusing', async () => {
    const app = createApp({ config: { ...ctx.config, appOrigin: 'https://a.example, https://b.example' }, pool: ctx.pool, ml: fakeMl() });
    expect((await post(app, 'https://b.example')).status).toBe(401);
    const refused = await post(app, 'https://evil.example');
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain('https://a.example');
  });

  it('accepts the Vite dev origins outside production only', async () => {
    const dev = createApp({ config: { ...ctx.config, appOrigin: 'http://localhost:4000' }, pool: ctx.pool, ml: fakeMl() });
    expect((await post(dev, 'http://127.0.0.1:5173')).status).toBe(401);
    const prod = createApp({ config: { ...ctx.config, production: true, appOrigin: 'https://app.example' }, pool: ctx.pool, ml: fakeMl() });
    expect((await post(prod, 'http://localhost:5173')).status).toBe(403);
  });

  it('requires the ML service secret in production', () => {
    const base = { databaseUrl: 'postgres://x', jwtSecret: 'x'.repeat(40), appOrigin: 'https://app.example', production: true };
    expect(() => loadConfig({ ...base, mlSecret: '' })).toThrow(/ML_SERVICE_SECRET/);
    expect(() => loadConfig({ ...base, mlSecret: 'secret' })).not.toThrow();
  });

  it('survives a dropped database connection instead of crashing', async () => {
    const pool = createPool(loadConfig({ databaseUrl: TEST_DB, jwtSecret: 'x'.repeat(40) }), { error: () => {} });
    await pool.query('SELECT 1');
    const admin = new pg.Client(TEST_DB.replace(/\/[^/]+$/, '/postgres'));
    await admin.connect();
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'signalguard_test' AND application_name = '' AND pid <> pg_backend_pid() AND state = 'idle'");
    await admin.end();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await pool.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
    await pool.end();
  });
});
