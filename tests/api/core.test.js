// Phase 2: asset trust, domain proof, validation on save, source selection, pagination, per-scan evidence, migration safety.
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BRAND, addFinding, fakeMl, setup, signIn } from './helpers.js';

let ctx;
beforeEach(async () => {
  if (ctx) await ctx.pool.end();
  ctx = undefined;
});
afterAll(() => ctx?.pool.end());

const start = async (options) => { ctx = await setup(options); };
const as = (role) => signIn(request.agent(ctx.app), role);
const createBrand = async (agent, extra = {}) => {
  const response = await agent.post('/api/brands').send({ ...BRAND, ...extra });
  expect(response.status).toBe(201);
  return response.body;
};
const auditKinds = async () => (await ctx.pool.query('SELECT kind FROM audit_log ORDER BY id')).rows.map((r) => r.kind);

describe('asset trust (P1-4)', () => {
  beforeEach(() => start());

  it('stores typed-in and suggested assets as untrusted, whatever the client claims', async () => {
    const agent = await as('analyst');
    const brand = await createBrand(agent, {
      officialSocials: [{ platform: 'X', handle: '@acmepay', trust: 'confirmed' }, { platform: 'Bluesky', handle: '@acme.bsky.social', trust: 'suggested' }],
      officialApps: [{ store: 'Google Play', appId: 'com.acmepay.app', publisher: 'Acme Pay Inc.', trust: 'confirmed' }],
    });
    expect(brand.officialSocials.map((a) => a.trust)).toEqual(['unverified', 'suggested']);
    expect(brand.officialApps.map((a) => a.trust)).toEqual(['unverified']);
    const stored = (await ctx.pool.query('SELECT official_socials, official_apps FROM brands WHERE id=$1', [brand.id])).rows[0];
    expect(JSON.stringify(stored)).not.toContain('confirmed');
  });

  it('confirms only with evidence, records who and why, and an analyst role is required', async () => {
    const agent = await as('analyst');
    const brand = await createBrand(agent);
    const ref = { kind: 'social', platform: 'X', handle: '@acmepay', trust: 'confirmed' };
    expect((await agent.post(`/api/brands/${brand.id}/assets/trust`).send(ref)).status).toBe(400); // no evidence
    expect((await agent.post(`/api/brands/${brand.id}/assets/trust`).send({ ...ref, evidence: 'short' })).status).toBe(400);
    expect((await (await as('viewer')).post(`/api/brands/${brand.id}/assets/trust`).send({ ...ref, evidence: 'Linked from website footer' })).status).toBe(403);
    expect((await agent.post(`/api/brands/${brand.id}/assets/trust`).send({ ...ref, handle: '@nobody', evidence: 'Linked from website footer' })).status).toBe(404);

    const done = await agent.post(`/api/brands/${brand.id}/assets/trust`).send({ ...ref, handle: 'ACMEPAY', evidence: 'Linked from website footer' });
    expect(done.status).toBe(200);
    expect(done.body.officialSocials[0]).toMatchObject({ trust: 'confirmed', confirmedBy: 'analyst@example.com', evidence: 'Linked from website footer' });
    expect(done.body.officialApps[0].trust).toBe('unverified'); // other assets untouched
    const log = (await ctx.pool.query("SELECT detail, target FROM audit_log WHERE kind='asset_confirmed'")).rows;
    expect(log).toHaveLength(1);
    expect(log[0].detail).toMatchObject({ asset: 'x:acmepay', evidence: 'Linked from website footer' });
  });

  it('keeps confirmation across edits, but drops it when a confirmed app changes publisher or is replaced', async () => {
    const agent = await as('analyst');
    const brand = await createBrand(agent);
    await agent.post(`/api/brands/${brand.id}/assets/trust`).send({ kind: 'app', store: 'Google Play', appId: 'com.acmepay.app', trust: 'confirmed', evidence: 'Listed on acmepay.com/download' });
    const keep = await agent.put(`/api/brands/${brand.id}`).send({ ...BRAND, description: 'Edited', officialApps: brand.officialApps.map((a) => ({ ...a, trust: 'unverified' })) });
    expect(keep.body.officialApps[0]).toMatchObject({ trust: 'confirmed', confirmedBy: 'analyst@example.com' }); // the client cannot downgrade or upgrade it by resubmitting
    const swapped = await agent.put(`/api/brands/${brand.id}`).send({ ...BRAND, officialApps: [{ ...BRAND.officialApps[0], publisher: 'Somebody Else Ltd' }] });
    expect(swapped.body.officialApps[0].trust).toBe('unverified');
    const replaced = await agent.put(`/api/brands/${brand.id}`).send({ ...BRAND, officialApps: [{ ...BRAND.officialApps[0], appId: 'com.other.app' }] });
    expect(replaced.body.officialApps[0].trust).toBe('unverified');
  });

  it('can withdraw a confirmation', async () => {
    const agent = await as('analyst');
    const brand = await createBrand(agent);
    const ref = { kind: 'app', store: 'Google Play', appId: 'com.acmepay.app' };
    await agent.post(`/api/brands/${brand.id}/assets/trust`).send({ ...ref, trust: 'confirmed', evidence: 'Listed on acmepay.com/download' });
    const back = await agent.post(`/api/brands/${brand.id}/assets/trust`).send({ ...ref, trust: 'unverified' });
    expect(back.body.officialApps[0]).toEqual({ store: 'Google Play', name: 'Acme Pay', appId: 'com.acmepay.app', publisher: 'Acme Pay Inc.', trust: 'unverified' });
    expect(await auditKinds()).toEqual(expect.arrayContaining(['asset_confirmed', 'asset_unconfirmed']));
  });

  it('treats legacy assets without a trust field as unverified and never rewrites them', async () => {
    const agent = await as('analyst');
    const brand = await createBrand(agent);
    await ctx.pool.query("UPDATE brands SET official_socials = '[{\"platform\":\"X\",\"handle\":\"@acmepay\"}]' WHERE id=$1", [brand.id]);
    expect((await agent.get(`/api/brands/${brand.id}`)).body.officialSocials[0].trust).toBe('unverified');
  });

  it('shows the demo brand as confirmed because its data is synthetic', async () => {
    const agent = await as('analyst');
    const demo = (await agent.post('/api/brands/demo')).body;
    expect(demo.officialApps.every((a) => a.trust === 'confirmed')).toBe(true);
    expect((await agent.post(`/api/brands/${demo.id}/assets/trust`).send({ kind: 'social', platform: 'X', handle: '@northstarhq', trust: 'unverified' })).status).toBe(400);
  });
});

describe('domain ownership proof', () => {
  let agent;
  let brand;
  let checker;
  const checked = [];
  beforeEach(async () => {
    checked.length = 0;
    checker = { result: { verified: false, method: null, detail: 'Not proven: no TXT record.' } };
    await start({ ml: fakeMl({ verifyDomain: (domain, token) => { checked.push([domain, token]); return Promise.resolve(checker.result); } }) });
    agent = await as('analyst');
    brand = await createBrand(agent, { domains: ['acmepay.io'] });
  });

  it('starts with every domain unproven', async () => {
    const states = (await agent.get(`/api/brands/${brand.id}`)).body.officialDomains;
    expect(states.map((d) => [d.domain, d.trust])).toEqual([['acmepay.com', 'unverified'], ['acmepay.io', 'unverified']]);
  });

  it('issues a stable token and both ways to prove control', async () => {
    const first = (await agent.post(`/api/brands/${brand.id}/domains/acmepay.com/challenge`)).body;
    const second = (await agent.post(`/api/brands/${brand.id}/domains/acmepay.com/challenge`)).body;
    expect(first.dnsTxt).toEqual({ name: '_signalguard.acmepay.com', value: expect.stringMatching(/^signalguard-verify=[0-9a-f]{32}$/) });
    expect(first.file).toEqual({ url: 'https://acmepay.com/.well-known/signalguard-verify.txt', contents: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(second.dnsTxt.value).toBe(first.dnsTxt.value);
  });

  it('only records proof when the check passes, and sends the stored token to the checker', async () => {
    expect((await agent.post(`/api/brands/${brand.id}/domains/acmepay.com/verify`)).status).toBe(409); // no challenge yet
    const { file } = (await agent.post(`/api/brands/${brand.id}/domains/acmepay.com/challenge`)).body;
    const failed = await agent.post(`/api/brands/${brand.id}/domains/acmepay.com/verify`);
    expect(failed.status).toBe(422);
    expect(checked).toEqual([['acmepay.com', file.contents]]);
    expect((await agent.get(`/api/brands/${brand.id}`)).body.officialDomains[0].trust).toBe('unverified');

    checker.result = { verified: true, method: 'dns_txt', detail: 'TXT record found.' };
    const ok = await agent.post(`/api/brands/${brand.id}/domains/acmepay.com/verify`);
    expect(ok.status).toBe(200);
    const states = (await agent.get(`/api/brands/${brand.id}`)).body.officialDomains;
    expect(states[0]).toMatchObject({ domain: 'acmepay.com', trust: 'confirmed', method: 'dns_txt' });
    expect(states[1].trust).toBe('unverified'); // proof is per domain
    expect(await auditKinds()).toEqual(expect.arrayContaining(['domain_verification_failed', 'domain_verified']));
  });

  it('refuses domains that are not on the profile and the demo brand', async () => {
    expect((await agent.post(`/api/brands/${brand.id}/domains/evil.example/challenge`)).status).toBe(404);
    expect((await agent.post(`/api/brands/${brand.id}/domains/not_a_domain/challenge`)).status).toBe(400);
    const demo = (await agent.post('/api/brands/demo')).body;
    expect((await agent.post(`/api/brands/${demo.id}/domains/northstar.com/challenge`)).status).toBe(400);
    expect((await (await as('viewer')).post(`/api/brands/${brand.id}/domains/acmepay.com/challenge`)).status).toBe(403);
  });
});

describe('validation on save (P2-12)', () => {
  it('rejects a profile the checker finds invalid and stores nothing', async () => {
    const invalid = { valid: false, errors: [{ field: 'officialApps[0]', message: '"x" is not a valid Android package name.' }], warnings: [], checks: [] };
    await start({ ml: fakeMl({ validate: () => Promise.resolve(invalid) }) });
    const agent = await as('analyst');
    const response = await agent.post('/api/brands').send(BRAND);
    expect(response.status).toBe(422);
    expect(response.body.validation.errors[0].field).toBe('officialApps[0]');
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM brands')).rows[0].n).toBe(0);
  });

  it('returns the validation result and stores it with the profile', async () => {
    const result = { valid: true, errors: [], warnings: [{ field: 'logoUrl', message: 'No logo.' }], checks: [{ field: 'officialApps[0]', status: 'verified' }] };
    const sent = [];
    await start({ ml: fakeMl({ validate: (brand) => { sent.push(brand); return Promise.resolve(result); } }) });
    const agent = await as('analyst');
    const brand = await createBrand(agent);
    expect(brand.validation).toEqual(result);
    expect(brand.verification).toEqual(result);
    expect(sent[0].officialApps[0].trust).toBe('unverified');
  });

  it('still saves when the checker is down, and says the profile was not checked', async () => {
    await start({ ml: fakeMl({ validate: () => Promise.reject(new Error('The detection service is unreachable (ECONNREFUSED).')) }) });
    const agent = await as('analyst');
    const brand = await createBrand(agent);
    expect(brand.validation).toMatchObject({ valid: true, unavailable: true });
    expect(brand.validation.warnings[0].message).toMatch(/could not be checked.*unreachable/);
  });

  it('rejects unknown source keys when the service can list them', async () => {
    await start();
    const agent = await as('analyst');
    const response = await agent.post('/api/brands').send({ ...BRAND, sources: ['bluesky', 'blueskyy'] });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Unknown source: blueskyy/);
    expect((await agent.post('/api/brands').send({ ...BRAND, sources: ['bluesky'] })).status).toBe(201);
  });
});

describe('source selection (P2-1)', () => {
  beforeEach(() => start());

  it('keeps an empty list as "no sources" and refuses to queue a scan for it', async () => {
    const agent = await as('analyst');
    const brand = await createBrand(agent, { sources: [] });
    expect((await agent.get(`/api/brands/${brand.id}`)).body.sources).toEqual([]);
    const scan = await agent.post(`/api/brands/${brand.id}/scans`);
    expect(scan.status).toBe(409);
    expect(scan.body.error).toMatch(/turned off/);
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM scans')).rows[0].n).toBe(0);
    await agent.put(`/api/brands/${brand.id}`).send({ ...BRAND, sources: null });
    expect((await agent.post(`/api/brands/${brand.id}/scans`)).status).toBe(202); // null still means every configured source
  });
});

describe('audit of profile changes (P2-11)', () => {
  beforeEach(() => start());

  it('records create, update (what changed, not the content), verify and delete', async () => {
    const agent = await as('analyst');
    const brand = await createBrand(agent);
    await agent.put(`/api/brands/${brand.id}`).send({ ...BRAND, officialSocials: [...BRAND.officialSocials, { platform: 'Bluesky', handle: '@acmepay.bsky.social' }], description: 'Changed' });
    await agent.put(`/api/brands/${brand.id}`).send({ ...BRAND, officialSocials: [...BRAND.officialSocials, { platform: 'Bluesky', handle: '@acmepay.bsky.social' }], description: 'Changed' }); // no change, no row
    await agent.post(`/api/brands/${brand.id}/verify`);
    await (await as('admin')).delete(`/api/brands/${brand.id}`);
    expect(await auditKinds()).toEqual(expect.arrayContaining(['brand_created', 'brand_updated', 'brand_verified', 'brand_deleted']));
    expect((await ctx.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE kind='brand_updated'")).rows[0].n).toBe(1);
    const update = (await ctx.pool.query("SELECT detail, target FROM audit_log WHERE kind='brand_updated'")).rows[0];
    expect(update.target).toBe(`brand:${brand.id}`);
    expect(update.detail.changed.sort()).toEqual(['description', 'officialSocials']);
    expect(update.detail.assets.officialSocials).toEqual({ added: ['bluesky:acmepay.bsky.social'], removed: [] });
    expect(JSON.stringify(update.detail)).not.toContain('Changed'); // field names and asset ids, no free text
  });

  it('shows brand changes in the admin security log', async () => {
    const agent = await as('analyst');
    await createBrand(agent);
    const log = await (await as('admin')).get('/api/audit');
    expect(log.body.map((r) => r.kind)).toContain('brand_created');
  });
});

describe('findings pagination, observations and not-seen (P2-8, P2-9, P2-10)', () => {
  let agent;
  let brand;
  beforeEach(async () => {
    await start();
    agent = await as('analyst');
    brand = await createBrand(agent);
  });

  it('pages through every finding exactly once', async () => {
    for (let i = 0; i < 120; i += 1) await addFinding(ctx.pool, brand.id, { externalId: `id-${i}`, score: 100 - (i % 40), name: `Acme ${i}` });
    const seen = new Set();
    for (const offset of [0, 50, 100]) {
      const page = await agent.get('/api/findings').query({ brandId: brand.id, limit: 50, offset, sort: 'first_seen' });
      expect(page.body.total).toBe(120);
      page.body.items.forEach((f) => seen.add(f.id));
      expect(page.body.items.length).toBe(offset === 100 ? 20 : 50);
    }
    expect(seen.size).toBe(120);
  });

  it('lists what every scan saw and includes it in the evidence export', async () => {
    const finding = await addFinding(ctx.pool, brand.id);
    const scans = [];
    for (let i = 0; i < 2; i += 1) {
      scans.push((await ctx.pool.query("INSERT INTO scans (brand_id, mode, status) VALUES ($1, 'live', 'succeeded') RETURNING id", [brand.id])).rows[0].id);
      await ctx.pool.query(`INSERT INTO finding_observations (finding_id, scan_id, source_key, score, severity, reasons, evidence)
        VALUES ($1, $2, 'bluesky', $3, 'High', $4, $5)`, [finding.id, scans[i], 70 + i * 10, JSON.stringify([`reason ${i}`]), JSON.stringify({ scoredAt: `2026-10-0${i + 1}T00:00:00Z` })]);
    }
    const list = await agent.get(`/api/findings/${finding.id}/observations`);
    expect(list.body.map((o) => [o.scanId, o.score, o.evidence.scoredAt])).toEqual([[scans[1], 80, '2026-10-02T00:00:00Z'], [scans[0], 70, '2026-10-01T00:00:00Z']]);
    const exported = await agent.get(`/api/findings/${finding.id}/evidence.json`);
    expect(exported.body.observations.map((o) => o.score)).toEqual([70, 80]);
    expect((await request(ctx.app).get(`/api/findings/${finding.id}/observations`)).status).toBe(401);
  });

  it('exposes the not-seen counter without changing the review status', async () => {
    const finding = await addFinding(ctx.pool, brand.id);
    await ctx.pool.query('UPDATE findings SET missed_scans = 2 WHERE id=$1', [finding.id]);
    const body = (await agent.get(`/api/findings/${finding.id}`)).body;
    expect(body).toMatchObject({ missedScans: 2, status: 'new' });
  });
});

describe('migration 003 on existing data', () => {
  it('keeps every existing row, backfills one observation per finding and confirms only demo assets', async () => {
    await start();
    const { pool } = ctx;
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    for (const file of ['001_init.sql', '002_auth_hardening.sql']) await pool.query(readFileSync(new URL(`../../db/migrations/${file}`, import.meta.url), 'utf8'));
    const social = JSON.stringify([{ platform: 'X', handle: '@a' }]);
    const live = (await pool.query("INSERT INTO brands (name, mode, domain, official_socials) VALUES ('Acme', 'live', 'acme.com', $1) RETURNING id", [social])).rows[0].id;
    const demo = (await pool.query("INSERT INTO brands (name, mode, domain, official_socials) VALUES ('Northstar', 'demo', 'northstar.com', $1) RETURNING id", [social])).rows[0].id;
    const scan = (await pool.query("INSERT INTO scans (brand_id, mode, status) VALUES ($1, 'live', 'succeeded') RETURNING id", [live])).rows[0].id;
    await pool.query(`INSERT INTO findings (brand_id, mode, type, platform, external_id, source_key, score, severity, last_scan_id, evidence)
      VALUES ($1, 'live', 'social', 'X', 'a', 'x', 80, 'High', $2, '{"scoredAt":"t"}'), ($1, 'live', 'social', 'X', 'b', 'x', 60, 'Medium', NULL, '{}')`, [live, scan]);

    await pool.query(readFileSync(new URL('../../db/migrations/003_core_persistence.sql', import.meta.url), 'utf8'));
    await pool.query(readFileSync(new URL('../../db/migrations/003_core_persistence.sql', import.meta.url), 'utf8')); // safe to run twice

    expect((await pool.query('SELECT count(*)::int AS n FROM findings')).rows[0].n).toBe(2);
    const obs = (await pool.query('SELECT score, evidence FROM finding_observations')).rows;
    expect(obs).toEqual([{ score: 80, evidence: { scoredAt: 't' } }]); // only the finding with a scan; no duplicates on the second run
    const trust = async (id) => (await pool.query('SELECT official_socials FROM brands WHERE id=$1', [id])).rows[0].official_socials[0];
    expect(await trust(demo)).toEqual({ platform: 'X', handle: '@a', trust: 'confirmed' });
    expect(await trust(live)).toEqual({ platform: 'X', handle: '@a' }); // live assets are not trusted by migration
  });
});
