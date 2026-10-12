import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { COOKIE, createAuth, hashPassword } from './auth.js';
import { transaction } from './db.js';
import { MlUnavailableError } from './ml.js';
import { brandOut, brandRoutes, scanOut } from './routes/brands.js';
import { findingRoutes } from './routes/findings.js';
import * as s from './schemas.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

// APP_ORIGIN may list several origins, separated by commas. The Vite dev server origins are accepted outside production only.
function allowedOrigins(config, request) {
  const configured = config.appOrigin.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
  const own = configured.length ? configured : [`${request.protocol}://${request.get('host')}`];
  return config.production ? own : [...own, ...DEV_ORIGINS.filter((o) => !own.includes(o))];
}

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

export function createApp({ config, pool, ml, logger = console }) {
  const app = express();
  const auth = createAuth(config, pool);
  app.locals.auth = auth;
  if (config.trustProxy) app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'self'"],
        'img-src': ["'self'", 'data:', 'https:'],
        'connect-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'font-src': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(cookieParser());
  app.use(express.json({ limit: '200kb' }));

  const limiter = (windowMs, limit, message) => rateLimit({ windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: message } });
  app.use('/api', limiter(60_000, Number(process.env.API_RATE_LIMIT || 300), 'Too many requests. Slow down and try again in a minute.'));

  // CSRF: mutating requests must be JSON and, when the browser sends an Origin, come from this app.
  app.use('/api', (request, response, next) => {
    if (!MUTATING.has(request.method) || request.path.startsWith('/internal/')) return next();
    const origin = request.get('origin');
    const allowed = allowedOrigins(config, request);
    if (origin && !allowed.includes(origin)) {
      return response.status(403).json({ error: `Cross-site request refused: this page is served from ${origin}, but the API only accepts ${allowed[0]}. Set APP_ORIGIN to the address you open in the browser.` });
    }
    const hasBody = request.headers['transfer-encoding'] !== undefined || Number(request.headers['content-length'] || 0) > 0;
    if (hasBody && !request.is('application/json')) return response.status(415).json({ error: 'Send JSON.' });
    return next();
  });

  app.use('/api', auth.session);

  // ---------- system ----------
  app.get('/api/health', async (_request, response) => {
    const result = { status: 'ok', database: 'ok', ml: 'ok' };
    try { await pool.query('SELECT 1'); } catch { result.database = 'unavailable'; result.status = 'degraded'; }
    try { const h = await ml.health(); result.model = h.model; } catch { result.ml = 'unavailable'; result.status = 'degraded'; }
    response.status(result.status === 'ok' ? 200 : 503).json(result);
  });

  // ---------- auth ----------
  const loginLimiter = limiter(15 * 60_000, Number(process.env.LOGIN_RATE_LIMIT || 10), 'Too many sign-in attempts. Try again in 15 minutes.');
  app.post('/api/auth/login', loginLimiter, async (request, response) => {
    const { email, password } = s.parse(s.login, request.body);
    const result = await auth.login(email, password, request.ip);
    if (result.locked) return response.status(429).json({ error: 'Too many failed sign-in attempts. Try again in 15 minutes.' });
    if (!result.user) return response.status(401).json({ error: 'Email or password is incorrect.' });
    await auth.issue(response, result.user);
    return response.json({ user: result.user });
  });
  // Logout revokes the session on the server; a copied cookie stops working.
  app.post('/api/auth/logout', async (request, response) => {
    if (request.sessionId) {
      await auth.revokeSession(request.sessionId);
      await auth.audit('logout', { actorId: request.user.id, ip: request.ip });
    }
    response.clearCookie(COOKIE, { path: '/' });
    response.status(204).end();
  });
  app.get('/api/auth/me', auth.require('viewer'), (request, response) => response.json({ user: request.user }));

  app.post('/api/auth/password', auth.require('viewer'), async (request, response) => {
    const { currentPassword, newPassword } = s.parse(s.changePassword, request.body);
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [request.user.id]);
    if (!(await bcrypt.compare(currentPassword, rows[0].password_hash))) return response.status(400).json({ error: 'Current password is incorrect.' });
    await pool.query('UPDATE users SET password_hash=$2, password_changed_at=now() WHERE id=$1', [request.user.id, await hashPassword(newPassword)]);
    await auth.revokeAll(request.user.id, request.sessionId); // every other device is signed out
    await auth.audit('password_changed', { actorId: request.user.id, ip: request.ip });
    return response.status(204).end();
  });

  // ---------- user administration (admin only, audited) ----------
  const userOut = 'id, email, role, created_at, last_login_at, disabled_at';
  app.get('/api/users', auth.require('admin'), async (_request, response) => {
    response.json((await pool.query(`SELECT ${userOut} FROM users ORDER BY id`)).rows);
  });
  app.post('/api/users', auth.require('admin'), async (request, response) => {
    const user = s.parse(s.newUser, request.body);
    const { rows } = await pool.query('INSERT INTO users (email, password_hash, role) VALUES (lower($1), $2, $3) ON CONFLICT (email) DO NOTHING RETURNING id, email, role',
      [user.email, await hashPassword(user.password), user.role]);
    if (!rows[0]) return response.status(409).json({ error: 'A user with that email already exists.' });
    await auth.audit('user_created', { actorId: request.user.id, target: rows[0].email, detail: { role: rows[0].role }, ip: request.ip });
    return response.status(201).json(rows[0]);
  });

  // Role changes and disabling. The last active admin cannot be demoted or disabled, and nobody can do it to themselves.
  app.patch('/api/users/:id', auth.require('admin'), async (request, response) => {
    const change = s.parse(s.userUpdate, request.body);
    const id = Number(request.params.id);
    if (id === request.user.id) return response.status(400).json({ error: 'You cannot change your own role or disable your own account.' });
    const result = await transaction(pool, async (client) => {
      const { rows } = await client.query('SELECT id, email, role, disabled_at FROM users WHERE id=$1 FOR UPDATE', [id]);
      const target = rows[0];
      if (!target) return { status: 404, error: 'User not found.' };
      const losesAdmin = target.role === 'admin' && !target.disabled_at && ((change.role && change.role !== 'admin') || change.disabled === true);
      if (losesAdmin) {
        const { rows: admins } = await client.query("SELECT count(*)::int AS n FROM users WHERE role='admin' AND disabled_at IS NULL");
        if (admins[0].n <= 1) return { status: 400, error: 'There must be at least one active admin.' };
      }
      await client.query(`UPDATE users SET role = COALESCE($2, role), disabled_at = CASE WHEN $3::boolean IS NULL THEN disabled_at WHEN $3 THEN COALESCE(disabled_at, now()) ELSE NULL END WHERE id=$1`,
        [id, change.role ?? null, change.disabled ?? null]);
      return { target };
    });
    if (result.error) return response.status(result.status).json({ error: result.error });
    if (change.disabled || change.role) await auth.revokeAll(id); // a changed role or a disabled account must sign in again
    await auth.audit('user_updated', { actorId: request.user.id, target: result.target.email, detail: change, ip: request.ip });
    return response.json((await pool.query(`SELECT ${userOut} FROM users WHERE id=$1`, [id])).rows[0]);
  });

  app.post('/api/users/:id/password', auth.require('admin'), async (request, response) => {
    const { newPassword } = s.parse(s.resetPassword, request.body);
    const { rows } = await pool.query('UPDATE users SET password_hash=$2, password_changed_at=now() WHERE id=$1 RETURNING email', [Number(request.params.id), await hashPassword(newPassword)]);
    if (!rows[0]) return response.status(404).json({ error: 'User not found.' });
    await auth.revokeAll(Number(request.params.id));
    await pool.query('DELETE FROM login_failures WHERE lower(email)=lower($1)', [rows[0].email]);
    await auth.audit('password_reset', { actorId: request.user.id, target: rows[0].email, ip: request.ip });
    return response.status(204).end();
  });

  app.get('/api/audit', auth.require('admin'), async (request, response) => {
    const { rows } = await pool.query(`SELECT a.id, a.kind, a.target, a.detail, a.ip, a.created_at, u.email AS actor FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id
      ORDER BY a.created_at DESC, a.id DESC LIMIT $1`, [Math.min(Number(request.query.limit) || 100, 500)]);
    response.json(rows);
  });

  // ---------- brands, scans, findings ----------
  app.use('/api/brands', brandRoutes({ pool, ml, auth }));
  app.use('/api/findings', findingRoutes({ pool, auth }));

  app.get('/api/scans/:id', auth.require('viewer'), async (request, response) => {
    const { rows } = await pool.query('SELECT * FROM scans WHERE id=$1', [Number(request.params.id)]);
    if (!rows[0]) return response.status(404).json({ error: 'Scan not found.' });
    return response.json(scanOut(rows[0]));
  });

  // Everything one scan observed, with whether each finding was first detected by it.
  app.get('/api/scans/:id/findings', auth.require('viewer'), async (request, response) => {
    const id = Number(request.params.id);
    const scan = await pool.query('SELECT id FROM scans WHERE id=$1', [id]);
    if (!scan.rows[0]) return response.status(404).json({ error: 'Scan not found.' });
    const { rows } = await pool.query(`
      SELECT f.id, f.name, f.handle, f.platform, f.type, f.status, f.url, o.score, o.severity, o.source_key,
             EXISTS (SELECT 1 FROM finding_events e WHERE e.finding_id = f.id AND e.kind = 'detected' AND e.scan_id = o.scan_id) AS new_in_scan
      FROM finding_observations o JOIN findings f ON f.id = o.finding_id
      WHERE o.scan_id = $1 ORDER BY o.score DESC, f.id LIMIT 200`, [id]);
    response.json({ total: rows.length, items: rows.map((r) => ({ id: r.id, name: r.name, handle: r.handle, platform: r.platform, type: r.type, status: r.status, url: r.url, score: r.score, severity: r.severity, source: r.source_key, newInScan: r.new_in_scan })) });
  });

  // Runs queued scans now (inside this request) instead of waiting for the worker. Used where no
  // long-running worker exists, such as serverless hosting. Safe to call concurrently: jobs are claimed with SKIP LOCKED.
  const runLimiter = limiter(60 * 60_000, Number(process.env.SCAN_RATE_LIMIT || 30), 'Too many scans started this hour.');
  app.post('/api/scans/:id/run', auth.require('analyst'), runLimiter, async (request, response) => {
    if (!config.workerSecret && !config.cronSecret) return response.status(202).json({ queued: true, message: 'Queued for the background worker.' });
    const result = await ml.runWorker(1);
    const { rows } = await pool.query('SELECT * FROM scans WHERE id=$1', [Number(request.params.id)]);
    return response.json({ worker: result, scan: scanOut(rows[0]) });
  });

  // What the dashboard needs to be honest about background work: is a worker alive, how often the scheduler really fires,
  // and whether alerts can be sent.
  app.get('/api/system', auth.require('viewer'), async (_request, response) => {
    const { rows } = await pool.query("SELECT name, kind, last_seen_at, extract(epoch FROM now() - last_seen_at)::int AS age FROM workers ORDER BY last_seen_at DESC LIMIT 1");
    const seen = rows[0];
    const cadence = config.schedulerCadenceMinutes;
    // A polling worker checks in every few seconds; cron calls are as rare as the cadence. Allow one missed beat.
    const window = seen?.kind === 'worker' ? 90 : Math.max(cadence, 15) * 60 * 2;
    let alerts = { configured: null };
    try { alerts = { configured: Boolean((await ml.health()).alerts?.configured) }; } catch { /* the detection service is down; unknown */ }
    response.json({
      worker: { active: Boolean(seen && seen.age <= window), kind: seen?.kind || null, lastSeenAt: seen?.last_seen_at || null },
      scheduler: { cadenceMinutes: cadence, kind: cadence ? 'cron' : 'worker', canRunOnDemand: Boolean(config.workerSecret || config.cronSecret) },
      alerts,
    });
  });

  app.get('/api/alerts', auth.require('viewer'), async (request, response) => {
    const brandId = Number(request.query.brandId);
    const { rows } = await pool.query(`SELECT id, brand_id, scan_id, kind, ok, error, jsonb_array_length(finding_ids)::int AS findings, retry_of, created_at,
        EXISTS (SELECT 1 FROM alert_deliveries r WHERE r.retry_of = d.id AND r.ok) AS redelivered
      FROM alert_deliveries d WHERE brand_id = $1 OR kind = 'test' ORDER BY created_at DESC LIMIT 30`, [Number.isInteger(brandId) ? brandId : null]);
    response.json(rows.map((r) => ({ id: r.id, brandId: r.brand_id, scanId: r.scan_id, kind: r.kind, ok: r.ok, error: r.error, findings: r.findings, retryOf: r.retry_of, redelivered: r.redelivered, createdAt: r.created_at })));
  });

  app.post('/api/alerts/test', auth.require('admin'), async (request, response) => {
    const result = await ml.testAlert();
    await auth.audit('alert_test', { actorId: request.user.id, detail: { ok: result.ok, error: result.error }, ip: request.ip });
    response.status(result.ok ? 200 : 502).json(result);
  });

  app.post('/api/alerts/:id/retry', auth.require('analyst'), async (request, response) => {
    if (!/^\d+$/.test(request.params.id)) return response.status(400).json({ error: 'Invalid alert id.' });
    const result = await ml.retryAlert(request.params.id);
    await auth.audit('alert_retry', { actorId: request.user.id, target: `alert:${Number(request.params.id)}`, detail: { ok: result.ok, error: result.error }, ip: request.ip });
    response.status(result.ok ? 200 : 502).json(result);
  });

  app.get('/api/sources', auth.require('viewer'), async (_request, response) => {
    const health = (await pool.query('SELECT * FROM source_health')).rows;
    const byKey = Object.fromEntries(health.map((row) => [row.source_key, row]));
    let catalog = [];
    let mlError = null;
    try { catalog = (await ml.health()).sources; } catch (error) { mlError = error.message; }
    const sources = catalog.map((source) => {
      const h = byKey[source.key];
      return {
        ...source,
        lastStatus: h?.status || null, lastMessage: h?.message || null, lastOkAt: h?.last_ok_at || null,
        lastErrorAt: h?.last_error_at || null, consecutiveFailures: h?.consecutive_failures || 0, checkedAt: h?.updated_at || null,
      };
    });
    response.json({ sources, mlError });
  });

  app.post('/api/lookalike', auth.require('viewer'), async (request, response) => {
    const body = s.parse(s.lookalike, request.body);
    const brandId = Number(request.query.brandId);
    const { rows } = await pool.query('SELECT * FROM brands WHERE id=$1', [brandId]);
    if (!rows[0]) return response.status(404).json({ error: 'Brand not found.' });
    return response.json(await ml.lookalike(brandOut(rows[0]), body.names, body.type));
  });

  app.get('/api/model', auth.require('viewer'), async (_request, response) => {
    const [health, feedback] = await Promise.all([ml.health(), pool.query('SELECT label, count(*)::int AS n FROM ml_feedback GROUP BY label')]);
    response.json({ version: health.model, metrics: health.metrics, feedback: Object.fromEntries(feedback.rows.map((r) => [r.label ? 'threat' : 'notThreat', r.n])) });
  });

  app.post('/api/model/retrain', auth.require('admin'), async (_request, response) => response.json(await ml.retrain()));

  // ---------- scheduled work (Vercel Cron / GitHub Actions) ----------
  const cron = async (request, response) => {
    const token = (request.get('authorization') || '').replace(/^Bearer /, '');
    const secrets = [config.cronSecret, config.workerSecret].filter(Boolean);
    if (!secrets.length) return response.status(503).json({ error: 'Set CRON_SECRET to enable scheduled scans.' });
    if (!token || !secrets.some((secret) => safeEqual(token, secret))) return response.status(401).json({ error: 'Unauthorized' });
    return response.json(await ml.runWorker(Number(process.env.CRON_MAX_JOBS || 3)));
  };
  app.get('/api/internal/cron', cron);
  app.post('/api/internal/cron', cron);

  app.use('/api', (_request, response) => response.status(404).json({ error: 'Not found.' }));

  // Local production mode: serve the built frontend from the same origin.
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  if (config.serveStatic !== false && existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_request, response) => response.sendFile(`${dist}index.html`));
  }

  app.use((error, request, response, _next) => {
    if (error instanceof ZodError) {
      return response.status(400).json({ error: error.issues[0]?.message || 'Invalid request', issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (error.type === 'entity.parse.failed') return response.status(400).json({ error: 'Request body is not valid JSON.' });
    if (error.type === 'entity.too.large') return response.status(413).json({ error: 'Request body is too large.' });
    if (error instanceof MlUnavailableError) return response.status(503).json({ error: error.message });
    if (error.code === '22P02' || error.code === '23514') return response.status(400).json({ error: 'Invalid value.' });
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status >= 500) logger.error(`[api] ${request.method} ${request.path}: ${error.stack || error.message}`);
    return response.status(status).json({ error: status >= 500 && status !== 502 && status !== 503 ? 'Something went wrong on the server.' : error.message });
  });

  return app;
}
