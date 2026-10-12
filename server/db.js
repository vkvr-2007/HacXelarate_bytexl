import pg from 'pg';

// JSONB columns come back parsed; BIGINT ids come back as numbers (ids stay far below 2^53).
pg.types.setTypeParser(20, (value) => Number(value));

// Extra time the client waits beyond the server-side statement limit before it gives up on a statement itself.
export const CLIENT_TIMEOUT_MARGIN_MS = 5000;
export const CLIENT_TIMEOUT_MESSAGE = 'Query read timeout'; // the error node-postgres raises when query_timeout fires
const statementTimeouts = new WeakMap();

function timeoutMs(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Timeouts that also work through Neon's pooled endpoint (PgBouncer in transaction mode), which does not support
 * session SET and may refuse unknown startup parameters such as statement_timeout:
 * - connectionTimeoutMillis: give up on opening a connection.
 * - query_timeout (client side, statement limit + margin): a statement that never answers rejects, and the pool
 *   discards that client instead of reusing it.
 * - SET LOCAL statement_timeout inside transaction(): the server cancels a long statement, and the setting ends
 *   with the transaction, so it never leaks to other clients of a pooled server connection.
 */
export function createPool(config, log = console) {
  const statementTimeoutMs = timeoutMs(config.databaseStatementTimeoutMs, 30000);
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
    max: Number(process.env.DATABASE_POOL_MAX || (process.env.VERCEL ? 3 : 10)),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: timeoutMs(config.databaseConnectTimeoutMs, 8000),
    query_timeout: statementTimeoutMs ? statementTimeoutMs + CLIENT_TIMEOUT_MARGIN_MS : undefined,
  });
  statementTimeouts.set(pool, statementTimeoutMs);
  // An idle connection can be dropped by the database or the network. Without this listener Node exits on the error event;
  // with it, the pool discards the client and opens a new one on the next query.
  pool.on('error', (error) => log.error(`[db] idle connection error: ${error.message}`));
  return pool;
}

export async function transaction(pool, work) {
  const client = await pool.connect();
  let broken; // set when the connection cannot be trusted any more; release(error) makes the pool discard it
  try {
    await client.query('BEGIN');
    const limit = statementTimeouts.get(pool);
    if (limit) await client.query(`SET LOCAL statement_timeout = ${limit}`);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // After a client-side timeout the statement may still be running on this connection, so ROLLBACK would only
    // queue behind it. Dropping the connection makes the server abort the transaction instead.
    if (error?.message === CLIENT_TIMEOUT_MESSAGE) broken = error;
    else await client.query('ROLLBACK').catch((rollbackError) => { broken = rollbackError; });
    throw error;
  } finally {
    client.release(broken);
  }
}
