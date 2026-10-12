// Vercel entry point: the Express API as one function. Migrations run from the deploy step, not here.
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { createPool } from '../server/db.js';
import { createMlClient } from '../server/ml.js';

const config = loadConfig({ serveStatic: false });
const app = createApp({ config, pool: createPool(config), ml: createMlClient(config) });
let ready;
export default async function handler(request, response) {
  ready ||= app.locals.auth.bootstrapAdmin().catch((error) => console.error(`admin bootstrap failed: ${error.message}`));
  await ready;
  return app(request, response);
}
