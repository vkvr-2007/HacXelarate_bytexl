// Applies db/migrations/*.sql in order, once each. Never drops anything.
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPool, transaction } from './db.js';
import { loadConfig } from './config.js';

const dir = fileURLToPath(new URL('../db/migrations/', import.meta.url));

export async function migrate(pool) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((row) => row.name));
  const applied = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.sql')).sort()) {
    if (done.has(name)) continue;
    await transaction(pool, async (client) => {
      await client.query(readFileSync(dir + name, 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    });
    applied.push(name);
  }
  return applied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = createPool(loadConfig());
  migrate(pool)
    .then((applied) => console.log(applied.length ? `Applied ${applied.join(', ')}` : 'Database is up to date'))
    .catch((error) => { console.error(`Migration failed: ${error.message}`); process.exitCode = 1; })
    .finally(() => pool.end());
}
