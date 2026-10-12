import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { DEMO_BRAND } from '../demo.js';
import * as s from '../schemas.js';
import { appKey, diffBrand, domainStates, resolveTrust, socialKey, withDefaultTrust } from '../assets.js';

// `proofs` are the brand's domain_proofs rows; when given, the declared domains are returned with their proof state.
export const brandOut = (row, proofs) => row && ({
  id: row.id, name: row.name, mode: row.mode, domain: row.domain, domains: row.domains, description: row.description,
  logoUrl: row.logo_url, aliases: row.aliases, keywords: row.keywords,
  officialSocials: row.mode === 'demo' ? (row.official_socials || []).map((a) => ({ ...a, trust: 'confirmed' })) : withDefaultTrust(row.official_socials),
  officialApps: row.mode === 'demo' ? (row.official_apps || []).map((a) => ({ ...a, trust: 'confirmed' })) : withDefaultTrust(row.official_apps),
  ...(proofs ? { officialDomains: domainStates(row, proofs) } : {}),
  sources: row.sources, scanIntervalMinutes: row.scan_interval_minutes,
  nextScanAt: row.next_scan_at, verification: row.verification, verifiedAt: row.verified_at,
  createdAt: row.created_at, updatedAt: row.updated_at,
});

export const scanOut = (row) => row && ({
  id: row.id, brandId: row.brand_id, mode: row.mode, status: row.status, trigger: row.trigger, attempts: row.attempts,
  queuedAt: row.queued_at, startedAt: row.started_at, finishedAt: row.finished_at, queries: row.queries, stats: row.stats,
  sources: row.sources, excluded: row.excluded, evaluation: row.evaluation, model: row.model, error: row.error,
});

const J = (value) => JSON.stringify(value);
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

export function brandRoutes({ pool, ml, auth }) {
  const router = Router();

  async function loadBrand(id) {
    const { rows } = await pool.query('SELECT * FROM brands WHERE id = $1', [Number(id)]);
    if (!rows[0]) throw fail(404, 'Brand not found.');
    return rows[0];
  }

  async function proofsFor(ids) {
    const { rows } = await pool.query('SELECT brand_id, domain, method, verified_at FROM domain_proofs WHERE brand_id = ANY($1::bigint[])', [ids]);
    return (id) => rows.filter((r) => r.brand_id === String(id) || Number(r.brand_id) === Number(id));
  }

  const present = async (row) => brandOut(row, (await proofsFor([row.id]))(row.id));
  const audit = (request, kind, brand, detail = {}) => auth.audit(kind, { actorId: request.user.id, target: `brand:${brand.id}`, detail: { brand: brand.name, ...detail }, ip: request.ip });

  // Source keys the detection service knows. If it cannot be reached the keys are not checked (the worker ignores unknown ones).
  async function unknownSources(sources) {
    if (!sources?.length) return [];
    try {
      const known = new Set((await ml.health()).sources.map((x) => x.key));
      return sources.filter((key) => !known.has(key));
    } catch { return []; }
  }

  // Format checks always; store lookups when the service can reach the stores. Problems block the save.
  async function validateProfile(input) {
    const unknown = await unknownSources(input.sources);
    if (unknown.length) throw fail(400, `Unknown source: ${unknown.join(', ')}.`);
    try {
      return await ml.validate(input, true);
    } catch (error) {
      return { valid: true, unavailable: true, errors: [], warnings: [{ field: 'profile', message: `Profile was saved but could not be checked: ${error.message}` }], checks: [], logo: null };
    }
  }

  router.get('/', auth.require('viewer'), async (_request, response) => {
    const { rows } = await pool.query(`
      SELECT b.*, (SELECT count(*)::int FROM findings f WHERE f.brand_id = b.id AND f.status IN ('new', 'reviewing', 'confirmed')) AS open_findings,
             (SELECT row_to_json(s) FROM (SELECT id, status, finished_at, queued_at FROM scans WHERE brand_id = b.id ORDER BY queued_at DESC LIMIT 1) s) AS last_scan
      FROM brands b ORDER BY b.mode, lower(b.name)`);
    const proofs = await proofsFor(rows.map((row) => row.id));
    response.json(rows.map((row) => ({ ...brandOut(row, proofs(row.id)), openFindings: row.open_findings, lastScan: row.last_scan })));
  });

  router.post('/', auth.require('analyst'), async (request, response) => {
    const b = s.parse(s.brandInput, request.body);
    const assets = { socials: resolveTrust([], b.officialSocials, socialKey), apps: resolveTrust([], b.officialApps, appKey, { scopeOf: (a) => a.publisher }) };
    const input = { ...b, officialSocials: assets.socials, officialApps: assets.apps };
    const validation = await validateProfile(input);
    if (!validation.valid) return response.status(422).json({ error: 'Fix these problems before saving the profile.', validation });
    const { rows } = await pool.query(`
      INSERT INTO brands (name, mode, domain, domains, description, logo_url, aliases, keywords, official_socials, official_apps, sources,
                          scan_interval_minutes, next_scan_at, created_by, verification, verified_at)
      VALUES ($1, 'live', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $11::int IS NULL THEN NULL ELSE now() END, $12, $13, now())
      ON CONFLICT (lower(name), mode) DO NOTHING RETURNING *`,
    [b.name, b.domain, J(b.domains), b.description, b.logoUrl, J(b.aliases), J(b.keywords), J(assets.socials), J(assets.apps),
      b.sources === null ? null : J(b.sources), b.scanIntervalMinutes, request.user.id, J(validation)]);
    if (!rows[0]) return response.status(409).json({ error: `A live brand named ${b.name} already exists.` });
    await audit(request, 'brand_created', rows[0], { domain: b.domain, socials: assets.socials.length, apps: assets.apps.length });
    return response.status(201).json({ ...(await present(rows[0])), validation });
  });

  // The fictional demo brand, scanned only against the labelled demo dataset.
  router.post('/demo', auth.require('analyst'), async (request, response) => {
    const b = DEMO_BRAND;
    const confirmed = (items) => items.map((item) => ({ ...item, trust: 'confirmed' }));
    const { rows } = await pool.query(`
      INSERT INTO brands (name, mode, domain, domains, description, logo_url, aliases, keywords, official_socials, official_apps, created_by)
      VALUES ($1, 'demo', $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (lower(name), mode) DO UPDATE SET updated_at = brands.updated_at RETURNING *`,
    [b.name, b.domain, J(b.domains), b.description, b.logoUrl, J(b.aliases), J(b.keywords), J(confirmed(b.officialSocials)), J(confirmed(b.officialApps)), request.user.id]);
    response.status(201).json(await present(rows[0]));
  });

  router.post('/suggest', auth.require('analyst'), async (request, response) => {
    const { name } = s.parse(s.suggest, request.body);
    response.json(await ml.suggestProfile(name));
  });

  router.get('/:id', auth.require('viewer'), async (request, response) => {
    response.json(await present(await loadBrand(request.params.id)));
  });

  router.put('/:id', auth.require('analyst'), async (request, response) => {
    const current = await loadBrand(request.params.id);
    if (current.mode === 'demo') return response.status(400).json({ error: 'The demo brand is fixed. Create a live brand to monitor a real company.' });
    const b = s.parse(s.brandInput, request.body);
    // Stored trust survives an edit; a changed publisher on a confirmed app drops it back to unverified.
    const socials = resolveTrust(current.official_socials, b.officialSocials, socialKey);
    const apps = resolveTrust(current.official_apps, b.officialApps, appKey, { scopeOf: (a) => a.publisher });
    const validation = await validateProfile({ ...b, officialSocials: socials, officialApps: apps });
    if (!validation.valid) return response.status(422).json({ error: 'Fix these problems before saving the profile.', validation });
    const diff = diffBrand(current, { ...b, officialSocials: socials, officialApps: apps });
    const { rows } = await pool.query(`
      UPDATE brands SET name=$2, domain=$3, domains=$4, description=$5, logo_url=$6, aliases=$7, keywords=$8, official_socials=$9,
        official_apps=$10, sources=$11, scan_interval_minutes=$12,
        next_scan_at = CASE WHEN $12::int IS NULL THEN NULL WHEN scan_interval_minutes IS DISTINCT FROM $12::int THEN now() ELSE next_scan_at END,
        verification = $13, verified_at = now(), updated_at=now()
      WHERE id=$1 RETURNING *`,
    [current.id, b.name, b.domain, J(b.domains), b.description, b.logoUrl, J(b.aliases), J(b.keywords), J(socials), J(apps),
      b.sources === null ? null : J(b.sources), b.scanIntervalMinutes, J(validation)]);
    if (diff.changed.length) await audit(request, 'brand_updated', rows[0], diff);
    response.json({ ...(await present(rows[0])), validation });
  });

  router.delete('/:id', auth.require('admin'), async (request, response) => {
    const brand = await loadBrand(request.params.id);
    await audit(request, 'brand_deleted', brand, { mode: brand.mode });
    await pool.query('DELETE FROM brands WHERE id = $1', [brand.id]);
    response.status(204).end();
  });

  // Format checks plus live existence checks of official apps. The result is stored on the brand.
  router.post('/:id/verify', auth.require('analyst'), async (request, response) => {
    const brand = await loadBrand(request.params.id);
    const result = await ml.validate(brandOut(brand), brand.mode === 'live');
    await pool.query('UPDATE brands SET verification=$2, verified_at=now() WHERE id=$1', [brand.id, J(result)]);
    await audit(request, 'brand_verified', brand, { valid: result.valid, errors: result.errors.length });
    response.json(result);
  });

  // A person confirms (or withdraws confirmation of) a declared social account or app, recording how they checked.
  // Platforms offer no ownership proof, so this is an attested decision, stored with who made it and when.
  router.post('/:id/assets/trust', auth.require('analyst'), async (request, response) => {
    const brand = await loadBrand(request.params.id);
    if (brand.mode === 'demo') throw fail(400, 'The demo brand is fixed.');
    const body = s.parse(s.assetTrust, request.body);
    const column = body.kind === 'social' ? 'official_socials' : 'official_apps';
    const keyOf = body.kind === 'social' ? socialKey : appKey;
    const wanted = keyOf(body);
    const items = withDefaultTrust(brand[column]);
    const index = items.findIndex((item) => keyOf(item) === wanted);
    if (index < 0) throw fail(404, 'That asset is not in the brand profile.');
    const { trust: _old, confirmedBy: _by, confirmedAt: _at, evidence: _ev, ...base } = items[index];
    items[index] = body.trust === 'confirmed'
      ? { ...base, trust: 'confirmed', confirmedBy: request.user.email, confirmedAt: new Date().toISOString(), evidence: body.evidence }
      : { ...base, trust: 'unverified' };
    const { rows } = await pool.query(`UPDATE brands SET ${column} = $2, updated_at = now() WHERE id = $1 RETURNING *`, [brand.id, J(items)]);
    await audit(request, body.trust === 'confirmed' ? 'asset_confirmed' : 'asset_unconfirmed', brand, { kind: body.kind, asset: wanted, evidence: body.evidence || undefined });
    response.json(await present(rows[0]));
  });

  // Domain ownership: publish the token as a DNS TXT record or a file, then ask us to check.
  async function declaredDomain(brand, raw) {
    const domain = s.parse(s.domainParam, raw);
    if (brand.mode === 'demo') throw fail(400, 'The demo brand is fixed.');
    if (![brand.domain, ...(brand.domains || [])].includes(domain)) throw fail(404, 'That domain is not in the brand profile.');
    return domain;
  }

  router.post('/:id/domains/:domain/challenge', auth.require('analyst'), async (request, response) => {
    const brand = await loadBrand(request.params.id);
    const domain = await declaredDomain(brand, request.params.domain);
    const { rows } = await pool.query(`
      INSERT INTO domain_proofs (brand_id, domain, token) VALUES ($1, $2, $3)
      ON CONFLICT (brand_id, domain) DO UPDATE SET domain = EXCLUDED.domain RETURNING token, verified_at`, [brand.id, domain, randomBytes(16).toString('hex')]);
    const { token, verified_at: verifiedAt } = rows[0];
    response.json({
      domain, verifiedAt,
      dnsTxt: { name: `_signalguard.${domain}`, value: `signalguard-verify=${token}` },
      file: { url: `https://${domain}/.well-known/signalguard-verify.txt`, contents: token },
      note: 'Add either one, then verify. Remove it afterwards if you like; the result is kept.',
    });
  });

  router.post('/:id/domains/:domain/verify', auth.require('analyst'), async (request, response) => {
    const brand = await loadBrand(request.params.id);
    const domain = await declaredDomain(brand, request.params.domain);
    const { rows } = await pool.query('SELECT token, verified_at FROM domain_proofs WHERE brand_id=$1 AND domain=$2', [brand.id, domain]);
    if (!rows[0]) throw fail(409, 'Start the challenge for this domain first.');
    const result = await ml.verifyDomain(domain, rows[0].token);
    if (result.verified) {
      await pool.query('UPDATE domain_proofs SET verified_at = now(), verified_by = $3, method = $4, evidence = $5 WHERE brand_id=$1 AND domain=$2',
        [brand.id, domain, request.user.id, result.method, J({ detail: result.detail, checkedAt: new Date().toISOString() })]);
    }
    await audit(request, result.verified ? 'domain_verified' : 'domain_verification_failed', brand, { domain, method: result.method, detail: result.detail });
    response.status(result.verified ? 200 : 422).json({ domain, ...result });
  });

  router.get('/:id/summary', auth.require('viewer'), async (request, response) => {
    const brand = await loadBrand(request.params.id);
    const [byStatus, bySeverity, byType, byPlatform, lastScan] = await Promise.all([
      pool.query('SELECT status AS k, count(*)::int AS n FROM findings WHERE brand_id=$1 GROUP BY 1', [brand.id]),
      pool.query("SELECT severity AS k, count(*)::int AS n FROM findings WHERE brand_id=$1 AND status IN ('new','reviewing','confirmed') GROUP BY 1", [brand.id]),
      pool.query("SELECT type AS k, count(*)::int AS n FROM findings WHERE brand_id=$1 AND status IN ('new','reviewing','confirmed') GROUP BY 1", [brand.id]),
      pool.query("SELECT platform AS k, count(*)::int AS n FROM findings WHERE brand_id=$1 AND status IN ('new','reviewing','confirmed') GROUP BY 1 ORDER BY 2 DESC", [brand.id]),
      pool.query('SELECT * FROM scans WHERE brand_id=$1 ORDER BY queued_at DESC LIMIT 1', [brand.id]),
    ]);
    const map = (result) => Object.fromEntries(result.rows.map((row) => [row.k, row.n]));
    response.json({
      brand: await present(brand), byStatus: map(byStatus), bySeverity: map(bySeverity), byType: map(byType),
      byPlatform: byPlatform.rows.map((row) => ({ platform: row.k, count: row.n })), lastScan: scanOut(lastScan.rows[0]),
    });
  });

  router.get('/:id/scans', auth.require('viewer'), async (request, response) => {
    const brand = await loadBrand(request.params.id);
    const limit = Math.min(Number(request.query.limit) || 20, 100);
    const { rows } = await pool.query('SELECT * FROM scans WHERE brand_id=$1 ORDER BY queued_at DESC LIMIT $2', [brand.id, limit]);
    response.json(rows.map(scanOut));
  });

  router.post('/:id/scans', auth.require('analyst'), async (request, response) => {
    const brand = await loadBrand(request.params.id);
    if (Array.isArray(brand.sources) && brand.sources.length === 0) {
      return response.status(409).json({ error: 'Every source is turned off for this brand. Turn on at least one in the brand profile, then scan.' });
    }
    const { rows } = await pool.query(`
      INSERT INTO scans (brand_id, mode, trigger, requested_by)
      SELECT $1, $2, 'manual', $3 WHERE NOT EXISTS (SELECT 1 FROM scans WHERE brand_id=$1 AND status IN ('queued','running'))
      RETURNING *`, [brand.id, brand.mode, request.user.id]);
    if (!rows[0]) {
      const active = await pool.query("SELECT * FROM scans WHERE brand_id=$1 AND status IN ('queued','running') ORDER BY queued_at DESC LIMIT 1", [brand.id]);
      return response.status(409).json({ error: 'A scan for this brand is already queued or running.', scan: scanOut(active.rows[0]) });
    }
    return response.status(202).json(scanOut(rows[0]));
  });

  router.get('/:id/allowlist', auth.require('viewer'), async (request, response) => {
    const { rows } = await pool.query('SELECT id, platform, external_id, type, name, reason, created_at FROM allowlist WHERE brand_id=$1 ORDER BY created_at DESC', [Number(request.params.id)]);
    response.json(rows);
  });

  return router;
}
