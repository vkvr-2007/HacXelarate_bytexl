import pg from 'pg';

// JSONB columns come back parsed; BIGINT ids come back as numbers (ids stay far below 2^53).
pg.types.setTypeParser(20, (value) => Number(value));

export function createPool(config, log = console) {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
    max: Number(process.env.DATABASE_POOL_MAX || (process.env.VERCEL ? 3 : 10)),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 8000,
  });
  // An idle connection can be dropped by the database or the network. Without this listener Node exits on the error event;
  // with it, the pool discards the client and opens a new one on the next query.
  pool.on('error', (error) => log.error(`[db] idle connection error: ${error.message}`));
  return pool;
}

export async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
