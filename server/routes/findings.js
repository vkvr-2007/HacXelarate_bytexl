import { Router } from 'express';
import { transaction } from '../db.js';
import * as s from '../schemas.js';

const SORTS = { score: 'f.score DESC, f.last_seen_at DESC', last_seen: 'f.last_seen_at DESC', first_seen: 'f.first_seen_at DESC' };
const LABELS = { confirmed: 1, false_positive: 0, official: 0 };

export const findingOut = (row) => row && ({
  id: row.id, brandId: row.brand_id, mode: row.mode, type: row.type, platform: row.platform, externalId: row.external_id,
  name: row.name, handle: row.handle, appId: row.app_id, publisher: row.publisher, url: row.url, iconUrl: row.icon_url,
  description: row.description, category: row.category, source: row.source_key, score: row.score, severity: row.severity,
  probability: row.probability, signals: row.signals, reasons: row.reasons, factors: row.features?.factors || [],
  features: row.features?.values || null, evidence: row.evidence, status: row.status,
  firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, lastScanId: row.last_scan_id, updatedAt: row.updated_at,
  missedScans: row.missed_scans, lastMissedScanId: row.last_missed_scan_id,
});

const observationOut = (row) => ({
  id: row.id, scanId: row.scan_id, source: row.source_key, score: row.score, severity: row.severity, probability: row.probability,
  signals: row.signals, reasons: row.reasons, factors: row.features?.factors || [], evidence: row.evidence, observedAt: row.observed_at,
});

const eventOut = (row) => ({
  id: row.id, kind: row.kind, fromStatus: row.from_status, toStatus: row.to_status, score: row.score, note: row.note,
  scanId: row.scan_id, actor: row.actor_email || null, createdAt: row.created_at,
});

// Spreadsheet apps execute cells starting with these characters.
const csvCell = (value) => {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

export function findingRoutes({ pool, auth }) {
  const router = Router();

  async function load(id) {
    const { rows } = await pool.query('SELECT * FROM findings WHERE id=$1', [Number(id)]);
    if (!rows[0]) throw Object.assign(new Error('Finding not found.'), { status: 404 });
    return rows[0];
  }

  function filters(query) {
    const q = s.parse(s.findingQuery, query);
    const where = ['f.brand_id = $1'];
    const values = [q.brandId];
    const add = (sql, value) => { values.push(value); where.push(sql.replace('?', `$${values.length}`)); };
    if (q.type) add('f.type = ?', q.type);
    if (q.status) add('f.status = ?', q.status);
    if (q.severity) add('f.severity = ?', q.severity);
    if (q.platform) add('f.platform = ?', q.platform);
    if (q.minScore != null) add('f.score >= ?', q.minScore);
    if (q.q) {
      values.push(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`);
      const i = `$${values.length}`;
      where.push(`(f.name ILIKE ${i} OR f.handle ILIKE ${i} OR f.url ILIKE ${i} OR f.publisher ILIKE ${i})`);
    }
    return { q, where: where.join(' AND '), values };
  }

  router.get('/', auth.require('viewer'), async (request, response) => {
    const { q, where, values } = filters(request.query);
    const [list, count] = await Promise.all([
      pool.query(`SELECT f.* FROM findings f WHERE ${where} ORDER BY ${SORTS[q.sort]} LIMIT ${q.limit} OFFSET ${q.offset}`, values),
      pool.query(`SELECT count(*)::int AS n FROM findings f WHERE ${where}`, values),
    ]);
    response.json({ total: count.rows[0].n, items: list.rows.map(findingOut) });
  });

  router.get('/export.csv', auth.require('viewer'), async (request, response) => {
    const { where, values } = filters({ ...request.query, limit: 200 });
    const { rows } = await pool.query(`SELECT f.* FROM findings f WHERE ${where} ORDER BY f.score DESC LIMIT 5000`, values);
    const header = ['id', 'status', 'severity', 'score', 'type', 'platform', 'name', 'handle', 'publisher', 'url', 'category', 'first_seen', 'last_seen', 'reasons'];
    const lines = rows.map((r) => [r.id, r.status, r.severity, r.score, r.type, r.platform, r.name, r.handle, r.publisher, r.url, r.category,
      r.first_seen_at?.toISOString(), r.last_seen_at?.toISOString(), (r.reasons || []).join('; ')].map(csvCell).join(','));
    response.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="findings.csv"');
    response.send([header.join(','), ...lines].join('\n'));
  });

  router.get('/:id', auth.require('viewer'), async (request, response) => {
    const finding = await load(request.params.id);
    const { rows } = await pool.query(`
      SELECT e.*, u.email AS actor_email FROM finding_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.finding_id=$1 ORDER BY e.created_at, e.id`, [finding.id]);
    response.json({ ...findingOut(finding), events: rows.map(eventOut) });
  });

  // What each scan saw, newest first. The finding row itself only holds the latest scan.
  router.get('/:id/observations', auth.require('viewer'), async (request, response) => {
    const finding = await load(request.params.id);
    const { rows } = await pool.query('SELECT * FROM finding_observations WHERE finding_id=$1 ORDER BY observed_at DESC, id DESC LIMIT 200', [finding.id]);
    response.json(rows.map(observationOut));
  });

  router.get('/:id/evidence.json', auth.require('viewer'), async (request, response) => {
    const finding = await load(request.params.id);
    const { rows } = await pool.query('SELECT e.*, u.email AS actor_email FROM finding_events e LEFT JOIN users u ON u.id=e.actor_id WHERE finding_id=$1 ORDER BY e.created_at, e.id', [finding.id]);
    const observations = await pool.query('SELECT * FROM finding_observations WHERE finding_id=$1 ORDER BY observed_at, id', [finding.id]);
    response.set('Content-Disposition', `attachment; filename="finding-${finding.id}-evidence.json"`);
    response.json({
      exportedAt: new Date().toISOString(),
      notice: 'Scores are model risk estimates to support review. They are not proof of malicious intent.',
      finding: findingOut(finding), observations: observations.rows.map(observationOut), auditTrail: rows.map(eventOut),
    });
  });

  router.patch('/:id', auth.require('analyst'), async (request, response) => {
    const body = s.parse(s.findingUpdate, request.body);
    const result = await transaction(pool, async (client) => {
      const { rows } = await client.query('SELECT * FROM findings WHERE id=$1 FOR UPDATE', [Number(request.params.id)]);
      const finding = rows[0];
      if (!finding) throw Object.assign(new Error('Finding not found.'), { status: 404 });
      if (body.status === 'official' && finding.status !== 'official' && (body.note || '').trim().length < 8) {
        throw Object.assign(new Error('Marking a finding official hides it from every future scan. Say how you know it belongs to the brand (at least 8 characters).'), { status: 400 });
      }
      if (finding.status !== body.status) {
        await client.query('UPDATE findings SET status=$2, updated_at=now() WHERE id=$1', [finding.id, body.status]);
        await client.query("INSERT INTO finding_events (finding_id, actor_id, kind, from_status, to_status, note) VALUES ($1, $2, 'status_change', $3, $4, $5)",
          [finding.id, request.user.id, finding.status, body.status, body.note || null]);
        // Reviewer decisions become labelled rows for the next model retrain (one row per finding).
        await client.query('DELETE FROM ml_feedback WHERE finding_id=$1', [finding.id]);
        // Only live findings teach the model. Demo decisions are about fictional data and never become training labels.
        if (body.status in LABELS && finding.mode === 'live' && finding.features?.values) {
          await client.query('INSERT INTO ml_feedback (finding_id, label, features, mode, decision, reviewer_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [finding.id, LABELS[body.status], JSON.stringify(finding.features.values), finding.mode, body.status, request.user.id]);
        }
        if (body.status === 'official') {
          await client.query(`INSERT INTO allowlist (brand_id, platform, external_id, type, name, reason, added_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
                              ON CONFLICT (brand_id, platform, external_id) DO NOTHING`,
          [finding.brand_id, finding.platform, finding.external_id, finding.type, finding.name, body.note || 'Marked official by a reviewer', request.user.id]);
        } else if (finding.status === 'official') {
          await client.query('DELETE FROM allowlist WHERE brand_id=$1 AND platform=$2 AND external_id=$3', [finding.brand_id, finding.platform, finding.external_id]);
        }
      } else if (body.note) {
        await client.query("INSERT INTO finding_events (finding_id, actor_id, kind, note) VALUES ($1, $2, 'note', $3)", [finding.id, request.user.id, body.note]);
      }
      return (await client.query('SELECT * FROM findings WHERE id=$1', [finding.id])).rows[0];
    });
    response.json(findingOut(result));
  });

  router.post('/:id/notes', auth.require('analyst'), async (request, response) => {
    const { note } = s.parse(s.note, request.body);
    const finding = await load(request.params.id);
    const { rows } = await pool.query("INSERT INTO finding_events (finding_id, actor_id, kind, note) VALUES ($1, $2, 'note', $3) RETURNING *", [finding.id, request.user.id, note]);
    response.status(201).json(eventOut({ ...rows[0], actor_email: request.user.email }));
  });

  return router;
}
