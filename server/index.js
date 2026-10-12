import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';
import { createMlClient } from './ml.js';

const config = loadConfig();
const pool = createPool(config);
const app = createApp({ config, pool, ml: createMlClient(config) });

try {
  const applied = await migrate(pool);
  if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
  if (await app.locals.auth.bootstrapAdmin()) console.log(`Created admin user ${config.adminEmail}`);
} catch (error) {
  console.error(`Database setup failed: ${error.message}`);
  process.exit(1);
}

app.listen(config.port, () => console.log(`SignalGuard API listening on http://localhost:${config.port}`));
