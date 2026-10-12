// npm run setup:env [-- admin@example.com]
// Creates .env from .env.example and fills the internal secrets with random values. Existing values are never changed.
// Prints which keys were generated, never their values. The admin password is stored only in .env.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GENERATED = {
  JWT_SECRET: () => randomBytes(48).toString('base64url'),
  ML_SERVICE_SECRET: () => randomBytes(32).toString('hex'),
  WORKER_SECRET: () => randomBytes(32).toString('hex'),
  CRON_SECRET: () => randomBytes(32).toString('hex'),
  ADMIN_PASSWORD: () => randomBytes(18).toString('base64url'),
};

/** @param {string} text @param {{ adminEmail?: string, random?: Record<string, () => string> }} [options] */
export function fillEnv(text, { adminEmail = '', random = GENERATED } = {}) {
  const generated = [];
  const missing = [];
  const lines = text.split('\n').map((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=\s*(#.*)?$/.exec(line);
    if (!match) return line;
    const [, key] = match;
    if (random[key]) { generated.push(key); return `${key}=${random[key]()}`; }
    if (key === 'ADMIN_EMAIL') {
      if (adminEmail) { generated.push(key); return `${key}=${adminEmail}`; }
      missing.push(key);
    }
    return `${key}=`; // an empty value; drop any trailing comment, which some parsers read as the value
  });
  return { text: lines.join('\n'), generated, missing };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL('../', import.meta.url);
  const target = fileURLToPath(new URL('.env', root));
  const base = existsSync(target) ? readFileSync(target, 'utf8') : readFileSync(new URL('.env.example', root), 'utf8');
  const { text, generated, missing } = fillEnv(base, { adminEmail: process.argv[2] || process.env.SIGNALGUARD_ADMIN_EMAIL || '' });
  writeFileSync(target, text, { mode: 0o600 });
  chmodSync(target, 0o600);
  console.log(generated.length ? `Wrote .env. Generated: ${generated.join(', ')}.` : '.env already had every internal secret; nothing changed.');
  if (generated.includes('ADMIN_PASSWORD')) console.log('The first admin password is in .env (ADMIN_PASSWORD). Remove it from the file after the first sign-in.');
  if (missing.length) console.log(`Still needed: ${missing.join(', ')}. Run again with: npm run setup:env -- you@example.com`);
  console.log('Optional source keys (search, YouTube, Reddit, alerts) are listed in .env.example. Leave them empty to keep those sources off.');
}
