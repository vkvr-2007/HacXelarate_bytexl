// Sessions: a signed JWT in an httpOnly cookie that points at a row in `sessions`, so a session can be
// revoked (logout, password change, disabled account). Roles: viewer < analyst < admin.
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';

export const COOKIE = 'sg_session';
const RANK = { viewer: 0, analyst: 1, admin: 2 };
const LOGIN_WINDOW_MINUTES = 15;
let dummyHash;

export const hashPassword = (password) => bcrypt.hash(password, 12);

export function createAuth(config, pool) {
  const key = new TextEncoder().encode(config.jwtSecret);
  const maxPerEmail = Number(process.env.LOGIN_MAX_FAILURES_PER_EMAIL || 5);
  const maxPerIp = Number(process.env.LOGIN_MAX_FAILURES_PER_IP || 20);

  async function audit(kind, { actorId = null, target = null, detail = {}, ip = null } = {}) {
    await pool.query('INSERT INTO audit_log (actor_id, kind, target, detail, ip) VALUES ($1, $2, $3, $4, $5)', [actorId, kind, target, JSON.stringify(detail), ip])
      .catch(() => {}); // an audit write must never turn a successful action into an error
  }

  async function issue(response, user) {
    const sid = randomUUID();
    const expires = new Date(Date.now() + config.sessionHours * 3600 * 1000);
    await pool.query('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', [sid, user.id, expires]);
    const token = await new SignJWT({ sid })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(user.id))
      .setIssuedAt()
      .setExpirationTime(expires)
      .sign(key);
    response.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.production, path: '/', maxAge: config.sessionHours * 3600 * 1000 });
    return sid;
  }

  // Failed attempts are counted per e-mail and per address in Postgres, so the limit holds across instances.
  async function lockedOut(email, ip) {
    const { rows } = await pool.query(`
      SELECT count(*) FILTER (WHERE lower(email) = lower($1))::int AS by_email, count(*) FILTER (WHERE ip = $2)::int AS by_ip
      FROM login_failures WHERE created_at > now() - make_interval(mins => $3)`, [email, ip, LOGIN_WINDOW_MINUTES]);
    return rows[0].by_email >= maxPerEmail || rows[0].by_ip >= maxPerIp;
  }

  /** Returns { user } on success, { locked: true } when throttled, or { user: null } for bad credentials. */
  async function login(email, password, ip = '') {
    if (await lockedOut(email, ip)) return { locked: true };
    const { rows } = await pool.query('SELECT id, email, role, password_hash, disabled_at FROM users WHERE lower(email) = lower($1)', [email]);
    const user = rows[0];
    // Compare against a dummy hash when the user does not exist, so timing does not reveal valid emails.
    dummyHash ||= await bcrypt.hash('not-a-real-password', 12);
    const ok = await bcrypt.compare(password, user?.password_hash || dummyHash);
    if (!user || !ok || user.disabled_at) {
      await pool.query('INSERT INTO login_failures (ip, email) VALUES ($1, lower($2))', [ip, email]);
      await audit('login_failed', { target: email.toLowerCase(), ip, detail: user?.disabled_at ? { reason: 'disabled' } : {} });
      return { user: null };
    }
    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    await pool.query('DELETE FROM login_failures WHERE lower(email) = lower($1)', [email]);
    await audit('login', { actorId: user.id, ip });
    return { user: { id: user.id, email: user.email, role: user.role } };
  }

  // Attaches request.user when the cookie is valid, the session is live and the account is enabled.
  // The role is read from the database on every request, so demotions apply at once.
  async function session(request, _response, next) {
    const token = request.cookies?.[COOKIE];
    if (!token) return next();
    try {
      const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
      const { rows } = await pool.query(`
        SELECT u.id, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`, [payload.sid, Number(payload.sub)]);
      if (rows[0]) {
        request.user = rows[0];
        request.sessionId = payload.sid;
      }
    } catch (error) {
      // An invalid or expired token means signed out. A database failure must not look like that.
      if (!String(error.code || '').startsWith('ERR_J')) return next(error); // jose errors are ERR_JWT_*, ERR_JWS_*, ERR_JOSE_*
    }
    return next();
  }

  const require = (role = 'viewer') => (request, response, next) => {
    if (!request.user) return response.status(401).json({ error: 'Sign in to continue.' });
    if (RANK[request.user.role] < RANK[role]) return response.status(403).json({ error: `This needs the ${role} role.` });
    return next();
  };

  const revokeSession = (id) => pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
  const revokeAll = (userId, exceptId = null) => pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)', [userId, exceptId]);

  async function bootstrapAdmin() {
    if (!config.adminEmail || !config.adminPassword) return false;
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
    if (rows[0].n > 0) return false;
    if (config.adminPassword.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
    await pool.query("INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin')", [config.adminEmail.toLowerCase(), await hashPassword(config.adminPassword)]);
    await audit('admin_bootstrap', { target: config.adminEmail.toLowerCase() });
    return true;
  }

  return { issue, login, session, require, bootstrapAdmin, revokeSession, revokeAll, audit };
}
