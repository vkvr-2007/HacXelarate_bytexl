import { createApp } from '../../server/app.js';
import { hashPassword } from '../../server/auth.js';
import { loadConfig } from '../../server/config.js';
import { createPool } from '../../server/db.js';
import { migrate } from '../../server/migrate.js';

export const TEST_DB = process.env.TEST_DATABASE_URL || 'postgresql://postgres@127.0.0.1:5432/signalguard_test';
export const PASSWORD = 'correct-horse-battery';

export function fakeMl(overrides = {}) {
  const calls = [];
  const record = (name, value) => (...args) => { calls.push([name, ...args]); return Promise.resolve(typeof value === 'function' ? value(...args) : value); };
  return {
    calls,
    health: record('health', { model: 'test-model', metrics: { f1: 0.9 }, alerts: { configured: true }, sources: [{ key: 'bluesky', label: 'Bluesky', configured: true, support: 'supported', mode: 'live' }, { key: 'tiktok', label: 'TikTok', configured: false, support: 'unsupported', mode: 'live' }] }),
    validate: record('validate', { valid: true, errors: [], warnings: [], checks: [] }),
    lookalike: record('lookalike', (brand, names) => ({ results: names.map((name) => ({ name, score: 90 })) })),
    retrain: record('retrain', { model: 'v2' }),
    verifyDomain: record('verifyDomain', { verified: false, method: null, detail: 'Not proven' }),
    testAlert: record('testAlert', { ok: true, error: null }),
    retryAlert: record('retryAlert', { ok: true, error: null }),
    suggestProfile: record('suggest', { officialApps: [], officialSocials: [] }),
    runWorker: record('runWorker', { ran: [] }),
    ...overrides,
  };
}

export async function setup({ ml = fakeMl(), config: overrides = {} } = {}) {
  if (!TEST_DB.split('/').pop().endsWith('_test')) throw new Error('Refusing to reset a database whose name does not end in _test');
  // Explicit values so a developer's .env never changes test behaviour.
  const config = loadConfig({ databaseUrl: TEST_DB, jwtSecret: 'test-secret-that-is-long-enough-000000', serveStatic: false, workerSecret: '', cronSecret: '', mlSecret: '', appOrigin: '', ...overrides });
  const pool = createPool(config);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  const users = {};
  for (const role of ['admin', 'analyst', 'viewer']) {
    const { rows } = await pool.query('INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role', [`${role}@example.com`, await hashPassword(PASSWORD), role]);
    users[role] = rows[0];
  }
  const logger = { error: () => {} };
  return { app: createApp({ config, pool, ml, logger }), pool, ml, users, config };
}

export async function signIn(agent, role) {
  const response = await agent.post('/api/auth/login').send({ email: `${role}@example.com`, password: PASSWORD });
  if (response.status !== 200) throw new Error(`login failed: ${response.status}`);
  return agent;
}

export const BRAND = {
  name: 'Acme Pay', domain: 'acmepay.com', description: 'Payments for small businesses.',
  officialSocials: [{ platform: 'X', handle: '@acmepay' }],
  officialApps: [{ store: 'Google Play', name: 'Acme Pay', appId: 'com.acmepay.app', publisher: 'Acme Pay Inc.' }],
};

export async function addFinding(pool, brandId, extra = {}) {
  const { rows } = await pool.query(`INSERT INTO findings (brand_id, mode, type, platform, external_id, name, source_key, score, severity, features, evidence)
    VALUES ($1, 'live', $2, $3, $4, $5, 'bluesky', $6, $7, $8, $9) RETURNING *`, [brandId, extra.type || 'social', extra.platform || 'Bluesky',
    extra.externalId || `did:${Math.random()}`, extra.name || 'Acme Pay Support', extra.score ?? 88, extra.severity || 'Critical',
    JSON.stringify({ values: { name_sim: 0.9 }, factors: [] }), JSON.stringify({ url: 'https://bsky.app/profile/x', scoredAt: '2026-10-12T00:00:00Z' })]);
  return rows[0];
}
