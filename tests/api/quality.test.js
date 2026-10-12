// Phase 4: what may become a training label, and what it takes to mark a finding official.
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BRAND, addFinding, setup, signIn } from './helpers.js';

let ctx;
let agent;
let brand;
beforeEach(async () => {
  if (ctx) await ctx.pool.end();
  ctx = await setup();
  agent = await signIn(request.agent(ctx.app), 'analyst');
  brand = (await agent.post('/api/brands').send(BRAND)).body;
});
afterAll(() => ctx?.pool.end());

const feedback = async () => (await ctx.pool.query('SELECT label, mode, decision, reviewer_id FROM ml_feedback ORDER BY id')).rows;
const review = (id, status, note) => agent.patch(`/api/findings/${id}`).send({ status, ...(note ? { note } : {}) });

describe('training feedback (P1-5)', () => {
  it('records live decisions with who made them and what they decided', async () => {
    const a = await addFinding(ctx.pool, brand.id);
    const b = await addFinding(ctx.pool, brand.id);
    await review(a.id, 'confirmed');
    await review(b.id, 'false_positive');
    expect(await feedback()).toEqual([
      { label: 1, mode: 'live', decision: 'confirmed', reviewer_id: Number(ctx.users.analyst.id) },
      { label: 0, mode: 'live', decision: 'false_positive', reviewer_id: Number(ctx.users.analyst.id) },
    ]);
  });

  it('never records a decision about demo findings', async () => {
    const demo = (await agent.post('/api/brands/demo')).body;
    const { rows } = await ctx.pool.query(`INSERT INTO findings (brand_id, mode, type, platform, external_id, source_key, score, severity, features)
      VALUES ($1, 'demo', 'social', 'X', 'd1', 'demo', 90, 'Critical', '{"values":{"name_sim":0.9}}') RETURNING id`, [demo.id]);
    expect((await review(rows[0].id, 'confirmed')).status).toBe(200);
    expect((await ctx.pool.query('SELECT status FROM findings WHERE id=$1', [rows[0].id])).rows[0].status).toBe('confirmed'); // the review itself works
    expect(await feedback()).toEqual([]);
  });

  it('removes the label again when a decision is withdrawn, and keeps one row per finding', async () => {
    const a = await addFinding(ctx.pool, brand.id);
    await review(a.id, 'confirmed');
    await review(a.id, 'false_positive');
    expect((await feedback()).map((r) => r.decision)).toEqual(['false_positive']);
    await review(a.id, 'reviewing');
    expect(await feedback()).toEqual([]);
  });

  it('migration 005 leaves old rows untouched and only vouches for ones it can trace to a live finding', async () => {
    const live = await addFinding(ctx.pool, brand.id);
    await ctx.pool.query("DELETE FROM ml_feedback");
    await ctx.pool.query('ALTER TABLE ml_feedback DROP COLUMN mode, DROP COLUMN decision, DROP COLUMN reviewer_id');
    await ctx.pool.query("INSERT INTO ml_feedback (finding_id, label, features) VALUES ($1, 1, '{}'), (NULL, 0, '{}')", [live.id]);
    const { readFileSync } = await import('node:fs');
    await ctx.pool.query(readFileSync(new URL('../../db/migrations/005_feedback_provenance.sql', import.meta.url), 'utf8'));
    expect((await ctx.pool.query('SELECT label, mode, decision FROM ml_feedback ORDER BY id')).rows).toEqual([
      { label: 1, mode: 'live', decision: 'confirmed' },
      { label: 0, mode: null, decision: null }, // origin unknown: kept, but training ignores it
    ]);
  });
});

describe('marking a finding official', () => {
  it('needs a written reason because it hides the item from every future scan', async () => {
    const f = await addFinding(ctx.pool, brand.id);
    const refused = await review(f.id, 'official');
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/hides it from every future scan/);
    expect((await review(f.id, 'official', 'ok')).status).toBe(400);
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM allowlist')).rows[0].n).toBe(0);
    const ok = await review(f.id, 'official', 'Listed on the company website footer');
    expect(ok.status).toBe(200);
    const row = (await ctx.pool.query('SELECT reason, added_by FROM allowlist')).rows[0];
    expect(row.reason).toBe('Listed on the company website footer');
    expect(await feedback()).toEqual([{ label: 0, mode: 'live', decision: 'official', reviewer_id: Number(ctx.users.analyst.id) }]);
  });

  it('removes the allowlist entry when the decision is reversed', async () => {
    const f = await addFinding(ctx.pool, brand.id);
    await review(f.id, 'official', 'Listed on the company website footer');
    await review(f.id, 'confirmed');
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM allowlist')).rows[0].n).toBe(0);
    expect((await feedback()).map((r) => r.decision)).toEqual(['confirmed']);
  });
});
