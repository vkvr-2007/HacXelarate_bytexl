// Runtime configuration, read once from the environment and checked at startup.
const env = process.env;
const production = env.NODE_ENV === 'production';

export function loadConfig(overrides = {}) {
  const config = {
    production,
    port: Number(env.PORT || 4000),
    databaseUrl: env.DATABASE_URL || '',
    databaseSsl: env.DATABASE_SSL === 'true' || /sslmode=require/.test(env.DATABASE_URL || ''),
    // How long to wait for a database connection, and how long one statement may run (0 turns the statement limit off).
    databaseConnectTimeoutMs: Number(env.DATABASE_CONNECT_TIMEOUT_MS || 8000),
    databaseStatementTimeoutMs: Number(env.DATABASE_STATEMENT_TIMEOUT_MS || 30000),
    jwtSecret: env.JWT_SECRET || '',
    sessionHours: Number(env.SESSION_HOURS || 12),
    appOrigin: (env.APP_ORIGIN || '').replace(/\/$/, ''),
    mlUrl: (env.ML_SERVICE_URL || 'http://127.0.0.1:8000').replace(/\/$/, ''),
    mlSecret: env.ML_SERVICE_SECRET || '',
    workerSecret: env.WORKER_SECRET || '',
    cronSecret: env.CRON_SECRET || '',
    triggerWorker: env.TRIGGER_WORKER_ON_SCAN === 'true',
    adminEmail: env.ADMIN_EMAIL || '',
    adminPassword: env.ADMIN_PASSWORD || '',
    // How often something actually calls the scheduler. Vercel Hobby crons run once a day; a long-running worker polls every few seconds (0).
    schedulerCadenceMinutes: Number(env.SCHEDULER_CADENCE_MINUTES ?? (env.VERCEL ? 1440 : 0)),
    trustProxy: env.TRUST_PROXY || (env.VERCEL ? '1' : ''),
    ...overrides,
  };
  const problems = [];
  if (!config.databaseUrl) problems.push('DATABASE_URL is not set');
  if (config.production && config.jwtSecret.length < 32) problems.push('JWT_SECRET must be at least 32 characters in production');
  if (!config.production && !config.jwtSecret) config.jwtSecret = 'local-development-only-secret-change-me-0000';
  if (config.production && !config.mlSecret) problems.push('ML_SERVICE_SECRET must be set in production');
  if (config.production && !config.appOrigin) problems.push('APP_ORIGIN must be set in production (for example https://signalguard.vercel.app)');
  if (problems.length) {
    throw Object.assign(new Error(`Configuration error: ${problems.join('; ')}`), { code: 'CONFIG' });
  }
  return config;
}
