import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config.js';
import { CLIENT_TIMEOUT_MARGIN_MS, createPool, transaction } from '../../server/db.js';
import { TEST_DB } from './helpers.js';

const quiet = { error: () => {} };
const configWith = (overrides = {}) => loadConfig({ databaseUrl: TEST_DB, jwtSecret: 'x'.repeat(40), ...overrides });

describe('database timeout configuration', () => {
  it('defaults to an 8 s connect timeout and a 30 s statement limit', () => {
    const config = configWith();
    expect(config.databaseConnectTimeoutMs).toBe(8000);
    expect(config.databaseStatementTimeoutMs).toBe(30000);
    const pool = createPool(config, quiet);
    expect(pool.options.connectionTimeoutMillis).toBe(8000);
    expect(pool.options.query_timeout).toBe(30000 + CLIENT_TIMEOUT_MARGIN_MS);
    return pool.end();
  });

  it('turns the statement limit off with 0 and keeps the connect timeout', () => {
    const pool = createPool(configWith({ databaseStatementTimeoutMs: 0, databaseConnectTimeoutMs: 3000 }), quiet);
    expect(pool.options.query_timeout).toBeUndefined();
    expect(pool.options.connectionTimeoutMillis).toBe(3000);
    return pool.end();
  });

  it('fails a connection attempt that never answers within the connect timeout', async () => {
    const net = await import('node:net');
    const sockets = [];
    const silent = net.createServer((socket) => sockets.push(socket)); // accepts TCP but never speaks the Postgres protocol
    await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = /** @type {import('node:net').AddressInfo} */ (silent.address());
    const pool = createPool(configWith({ databaseUrl: `postgresql://postgres@127.0.0.1:${port}/x_test`, databaseConnectTimeoutMs: 300 }), quiet);
    const started = Date.now();
    await expect(pool.query('SELECT 1')).rejects.toThrow(/timeout/i);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(pool.totalCount).toBe(0); // nothing half-open is kept
    await pool.end();
    sockets.forEach((socket) => socket.destroy());
    await new Promise((resolve) => silent.close(resolve));
  }, 15000);
});

describe('statement timeouts against the test database', () => {
  let pool;
  beforeAll(async () => {
    pool = createPool(configWith({ databaseStatementTimeoutMs: 300 }), quiet);
    await pool.query('CREATE TABLE IF NOT EXISTS timeout_probe (id INT PRIMARY KEY, note TEXT)');
    await pool.query('TRUNCATE timeout_probe');
  });
  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS timeout_probe');
    await pool.end();
  });

  it('applies the limit inside a transaction only', async () => {
    const inside = await transaction(pool, (client) => client.query('SHOW statement_timeout'));
    expect(inside.rows[0].statement_timeout).toBe('300ms');
    const client = await pool.connect();
    try {
      expect((await client.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('0'); // SET LOCAL did not outlive the transaction
    } finally {
      client.release();
    }
  });

  it('cancels a long statement on the server, rolls back the transaction and keeps the connection usable', async () => {
    await expect(transaction(pool, async (client) => {
      await client.query("INSERT INTO timeout_probe VALUES (1, 'should be rolled back')");
      await client.query('SELECT pg_sleep(2)');
    })).rejects.toMatchObject({ code: '57014' }); // query_canceled
    expect((await pool.query('SELECT count(*)::int AS n FROM timeout_probe')).rows[0].n).toBe(0);
    expect((await transaction(pool, (client) => client.query('SELECT 1 AS ok'))).rows[0].ok).toBe(1);
  });

  it('gives up on a statement outside a transaction on the client side and discards that connection', async () => {
    const before = pool.totalCount;
    const started = Date.now();
    // pg_sleep outside a transaction has no server limit here, so the client-side query_timeout (300 ms + margin) ends it.
    await expect(pool.query('SELECT pg_sleep(10)')).rejects.toThrow('Query read timeout');
    expect(Date.now() - started).toBeLessThan(300 + CLIENT_TIMEOUT_MARGIN_MS + 3000);
    expect(pool.totalCount).toBeLessThanOrEqual(before); // the timed-out client was not returned to the pool
    expect((await pool.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
  }, 20000);

  it('drops a connection whose statement stopped answering inside a transaction instead of reusing it', async () => {
    // No server limit and a short client limit: simulates a pooler or network that stops answering mid-transaction.
    const tiny = createPool(configWith({ databaseStatementTimeoutMs: 0 }), quiet);
    tiny.options.query_timeout = 300;
    await expect(transaction(tiny, async (client) => {
      await client.query("INSERT INTO timeout_probe VALUES (2, 'never committed')");
      await client.query('SELECT pg_sleep(1)');
    })).rejects.toThrow('Query read timeout');
    expect(tiny.totalCount).toBe(0); // discarded, not handed to the next caller mid-transaction
    expect((await pool.query('SELECT count(*)::int AS n FROM timeout_probe WHERE id = 2')).rows[0].n).toBe(0);
    await tiny.end();
  }, 20000);
});
