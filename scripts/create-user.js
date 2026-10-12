// npm run user:create -- email@example.com analyst   (password is read from SIGNALGUARD_PASSWORD or prompted)
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { hashPassword } from '../server/auth.js';
import { loadConfig } from '../server/config.js';
import { createPool } from '../server/db.js';

const [email, role = 'analyst'] = process.argv.slice(2);
if (!email || !['admin', 'analyst', 'viewer'].includes(role)) {
  console.error('Usage: npm run user:create -- <email> [admin|analyst|viewer]');
  process.exit(1);
}
let password = process.env.SIGNALGUARD_PASSWORD;
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question('Password (12+ characters): ');
  rl.close();
}
if (password.length < 12) {
  console.error('Password must be at least 12 characters.');
  process.exit(1);
}
const pool = createPool(loadConfig());
await pool.query('INSERT INTO users (email, password_hash, role) VALUES (lower($1), $2, $3) ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role',
  [email, await hashPassword(password), role]);
console.log(`Saved ${email} as ${role}.`);
await pool.end();
