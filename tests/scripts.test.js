import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanText, scanTracked } from '../scripts/check-secrets.js';
import { fillEnv } from '../scripts/setup-env.js';

describe('setup:env', () => {
  const example = 'JWT_SECRET=                    # 32+ chars\nADMIN_EMAIL=\nADMIN_PASSWORD=\nML_SERVICE_SECRET=\nPORT=4000\nBRAVE_SEARCH_API_KEY=         # optional\n';

  it('turns a comment-only value into an empty one', () => {
    expect(fillEnv('BRAVE_SEARCH_API_KEY=   # optional\nOTHER=x\n').text).toBe('BRAVE_SEARCH_API_KEY=\nOTHER=x\n');
  });

  it('fills internal secrets with strong random values and leaves optional keys empty', () => {
    const { text, generated } = fillEnv(example, { adminEmail: 'boss@example.com' });
    const env = Object.fromEntries(text.split('\n').filter(Boolean).map((l) => l.split('=')));
    expect(generated).toEqual(['JWT_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ML_SERVICE_SECRET']);
    expect(env.JWT_SECRET.length).toBeGreaterThanOrEqual(64);
    expect(env.ADMIN_PASSWORD.length).toBeGreaterThanOrEqual(12);
    expect(env.ML_SERVICE_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(env.ADMIN_EMAIL).toBe('boss@example.com');
    expect(env.BRAVE_SEARCH_API_KEY.trim()).toMatch(/^#|^$/); // the optional key was not invented
    expect(fillEnv(example, { adminEmail: 'a@b.co' }).text).not.toBe(text); // new randomness each time
  });

  it('never changes a value that is already set', () => {
    const first = fillEnv(example, { adminEmail: 'boss@example.com' }).text;
    const second = fillEnv(first, { adminEmail: 'other@example.com' });
    expect(second.generated).toEqual([]);
    expect(second.text).toBe(first);
  });

  it('asks for the admin email instead of guessing one', () => {
    expect(fillEnv(example).missing).toEqual(['ADMIN_EMAIL']);
  });
});

describe('check:secrets', () => {
  it('finds real-looking secrets and masks them in the report', () => {
    const key = `AIza${'a1B2c3D4e5'.repeat(3)}12345`;
    const hits = scanText('server/x.js', `const key = '${key}';\nconst ok = 1;`);
    expect(hits).toEqual([{ path: 'server/x.js', line: 1, label: 'Google API key', preview: 'AIza…(39 chars)' }]);
    expect(JSON.stringify(hits)).not.toContain(key);
    expect(scanText('a.py', `SLACK = '${'xoxb'}-1234567890-abcdefghij'`)[0].label).toBe('Slack token');
    expect(scanText('a.txt', `${'-----BEGIN'} RSA PRIVATE KEY-----`)[0].label).toBe('Private key');
    expect(scanText('config.js', 'const JWT_SECRET = "aGVsbG8gd29ybGQgdGhpcyBpcyBsb25n";')[0].label).toBe('Assigned secret');
  });

  it('lets test fixtures use obvious placeholders but still catches provider keys there', () => {
    expect(scanText('tests/api/helpers.js', "jwtSecret: 'test-secret-that-is-long-enough-000000'")).toEqual([]);
    expect(scanText('tests/api/helpers.js', "token = 'ghp_" + 'a'.repeat(36) + "'")[0].label).toBe('GitHub token');
  });

  it('flags a tracked .env file and ignores .env.example', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sg-secrets-'));
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
    git('init', '-q');
    writeFileSync(join(dir, '.env.example'), 'JWT_SECRET=\n');
    writeFileSync(join(dir, '.env'), 'JWT_SECRET=x\n');
    git('add', '-f', '.env', '.env.example');
    expect(scanTracked(dir).map((p) => [p.path, p.label])).toEqual([['.env', 'Environment file is tracked']]);
  });

  it('the repository itself is clean', () => {
    expect(scanTracked('.')).toEqual([]);
  });
});

describe('vercel.json', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

  it('points every function and cron at files and routes that exist', () => {
    for (const file of Object.keys(config.functions)) expect(existsSync(new URL(`../${file}`, import.meta.url)), file).toBe(true);
    expect(config.crons[0].path).toBe('/api/internal/cron');
  });

  it('routes the ML mount before the API catch-all and never serves the SPA for /api', () => {
    const sources = config.rewrites.map((r) => r.source);
    expect(sources.indexOf('/api/ml/(.*)')).toBeLessThan(sources.indexOf('/api/(.*)'));
    expect(config.rewrites.at(-1).source).toContain('(?!api/');
  });

  it('keeps the CSP free of third-party hosts and ships the model with the Python function', () => {
    const csp = config.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
    expect(csp).not.toMatch(/googleapis|gstatic|unpkg|cdn/);
    expect(config.functions['api/ml.py'].includeFiles).toContain('ml/models/brandml.joblib');
  });
});
