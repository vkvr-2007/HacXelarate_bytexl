// npm run release:gate
// The local release gate: secrets, audits, lint, types, every test, the production build, then a production-mode
// stack (API, ML service, Postgres) driven by a real browser. Nothing is deployed and nothing leaves this machine
// except what the e2e walkthrough needs (it makes no calls to live sources).
// Needs Postgres with a database whose name ends in _test (TEST_DATABASE_URL), Python deps and Chromium (PLAYWRIGHT_CHROMIUM).
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { runE2E } from './e2e.mjs';
import { createPool } from '../server/db.js';
import { loadConfig } from '../server/config.js';
import { migrate } from '../server/migrate.js';

const DB = process.env.TEST_DATABASE_URL || 'postgresql://postgres@127.0.0.1:5432/signalguard_test';
if (!DB.split('/').pop().split('?')[0].endsWith('_test')) { console.error('Refusing to run: the gate resets its database and the name must end in _test.'); process.exit(2); }

const results = [];
const run = (name, command, args, env = {}) => {
  process.stdout.write(`• ${name} … `);
  const started = Date.now();
  const r = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 50 * 1024 * 1024 });
  const ok = r.status === 0;
  results.push({ name, ok, detail: ok ? '' : `${r.stdout.slice(-1500)}${r.stderr.slice(-1500)}` });
  console.log(`${ok ? 'ok' : 'FAILED'} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  return ok;
};
const skip = (name, why) => { results.push({ name, ok: true, skipped: why }); console.log(`• ${name} … skipped (${why})`); };
const have = (cmd, args = ['--version']) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;

const steps = [
  () => run('no secrets in tracked files', 'node', ['scripts/check-secrets.js']),
  () => run('npm audit (all dependencies)', 'npm', ['audit', '--audit-level=high']),
  () => (have('pip-audit') ? run('pip-audit', 'pip-audit', ['-r', 'ml/requirements.txt', '--no-deps', '--disable-pip']) : skip('pip-audit', 'pip-audit is not installed')),
  // --skip-check exists only to iterate on the browser walkthrough; the report says so and the gate must be run without it to count.
  () => (process.argv.includes('--skip-check') ? skip('lint, types, all tests, production build', 'skipped by --skip-check, so this run does not count') : run('lint, types, all tests, production build', 'npm', ['run', 'check'], { TEST_DATABASE_URL: DB })),
];
for (const step of steps) step();

async function stack() {
  const password = randomBytes(15).toString('base64url');
  const secrets = { JWT_SECRET: randomBytes(48).toString('base64url'), ML_SERVICE_SECRET: randomBytes(24).toString('hex'), WORKER_SECRET: randomBytes(24).toString('hex') };
  const email = 'gate-admin@example.com';
  const pool = createPool(loadConfig({ databaseUrl: DB, jwtSecret: secrets.JWT_SECRET }));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  await pool.end();
  const env = { ...process.env, ...secrets, DATABASE_URL: DB, NODE_ENV: 'production', ADMIN_EMAIL: email, ADMIN_PASSWORD: password, APP_ORIGIN: 'http://127.0.0.1:4100',
    PORT: '4100', ML_SERVICE_URL: 'http://127.0.0.1:8100', ALERT_WEBHOOK_URL: '', PAGE_CHECKS: 'off' };
  const children = [
    spawn('python3', ['-m', 'uvicorn', 'service:app', '--app-dir', 'ml', '--host', '127.0.0.1', '--port', '8100'], { env, stdio: 'ignore' }),
    spawn('node', ['server/index.js'], { env, stdio: 'ignore' }),
  ];
  try {
    for (let i = 0; i < 60; i += 1) {
      const up = await Promise.all(['http://127.0.0.1:4100/api/auth/me', 'http://127.0.0.1:8100/health'].map((u) => fetch(u).then((r) => r.status < 500, () => false)));
      if (up.every(Boolean)) break;
      if (i === 59) throw new Error('The stack did not start within 60 s');
      await new Promise((r) => setTimeout(r, 1000));
    }
    const unauth = await fetch('http://127.0.0.1:8100/health').then((r) => r.json());
    results.push({ name: 'production ML service hides metrics from callers without the secret', ok: Object.keys(unauth).join() === 'status' });
    const noSecret = await fetch('http://127.0.0.1:8100/score', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    results.push({ name: 'production ML service refuses unauthenticated scoring', ok: noSecret.status === 401 });
    const steps2 = await runE2E({ base: 'http://127.0.0.1:4100', email, password });
    for (const s of steps2) results.push({ name: `e2e: ${s.name}`, ok: s.ok, detail: s.detail });
  } finally {
    for (const c of children) c.kill('SIGTERM');
  }
}

console.log('• production-mode stack with a real browser …');
try { await stack(); } catch (error) { results.push({ name: 'production-mode stack and browser walkthrough', ok: false, detail: error.message }); }

console.log('\nRelease gate');
for (const r of results) console.log(`${r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.skipped ? ` (${r.skipped})` : ''}${!r.ok && r.detail ? `\n      ${String(r.detail).replace(/\n/g, '\n      ')}` : ''}`);
const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped && r.skipped.includes('does not count'));
console.log(failed.length ? `\n${failed.length} check(s) failed. Not ready.` : skipped.length ? '\nNo failures, but a step was skipped: this run does not count as a release gate.' : '\nAll checks passed. This says nothing about live sources, Vercel or real-world accuracy; see REPAIR_PROGRESS.md.');
process.exit(failed.length || skipped.length ? 1 : 0);
