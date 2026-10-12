"""Postgres-backed scan queue, worker and alerts.

Scans are rows in `scans`. A worker claims one with FOR UPDATE SKIP LOCKED,
heartbeats while it runs, and writes findings, audit events, source health and
scan stats in one transaction. A scan whose worker died (no heartbeat for
STALE_MINUTES) is picked up again, up to MAX_ATTEMPTS, then marked failed.
"""
import json
import logging
import os
import threading
import time
from typing import Any

import httpx
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from . import safe_http

log = logging.getLogger('signalguard.worker')
STALE_MINUTES = int(os.getenv('SCAN_STALE_MINUTES', '10'))
MAX_ATTEMPTS = int(os.getenv('SCAN_MAX_ATTEMPTS', '3'))
SEVERITY_RANK = {'Low': 0, 'Medium': 1, 'High': 2, 'Critical': 3}
ERROR_STATUSES = {'rate_limited', 'unavailable', 'auth_failed'}
QUIET_STATUSES = {'false_positive', 'official', 'resolved'}


def _env_ms(name, default):
    return max(0, int(os.getenv(name) or default))


def connect_timeout_seconds():
    """libpq connect_timeout from DATABASE_CONNECT_TIMEOUT_MS (default 8000, the same as the Node pool). libpq needs whole seconds, at least 2."""
    ms = _env_ms('DATABASE_CONNECT_TIMEOUT_MS', 8000)
    return max(2, -(-ms // 1000)) if ms else 0


def statement_timeout_ms():
    """Per-statement limit from DATABASE_STATEMENT_TIMEOUT_MS (default 30000; 0 turns it off)."""
    return _env_ms('DATABASE_STATEMENT_TIMEOUT_MS', 30000)


class TimeoutCursor(psycopg.Cursor):
    """Sets statement_timeout for each transaction with set_config(..., is_local => true).

    Neon's pooled endpoint runs PgBouncer in transaction mode, where session SET is not supported and unknown
    startup parameters may be refused, so the limit is applied inside every transaction instead. It resets at
    COMMIT or ROLLBACK and never leaks to other clients of a pooled server connection. A statement that runs too
    long raises psycopg.errors.QueryCanceled; the transaction is aborted and `with connect()` rolls it back."""

    def execute(self, query, params=None, **kwargs):
        conn = self.connection
        limit = getattr(conn, 'statement_timeout_ms', 0)
        if limit and not conn.autocommit and conn.info.transaction_status == psycopg.pq.TransactionStatus.IDLE:
            super().execute("SELECT set_config('statement_timeout', %s, true)", (f'{int(limit)}ms',))
        return super().execute(query, params, **kwargs)


class TimeoutConnection(psycopg.Connection[Any]):
    statement_timeout_ms = 0


def connect(url=None):
    url = url or os.getenv('DATABASE_URL')
    if not url:
        raise RuntimeError('DATABASE_URL is not set')
    seconds = connect_timeout_seconds()
    options = {'connect_timeout': seconds} if seconds else {}
    conn = TimeoutConnection.connect(url, row_factory=dict_row, autocommit=False, cursor_factory=TimeoutCursor, **options)
    conn.statement_timeout_ms = statement_timeout_ms()
    return conn


class PgCache:
    """Last good results per source and brand, shared by every worker."""

    def __init__(self, url=None):
        self.url = url

    def get(self, source, brand_key):
        with connect(self.url) as conn:
            row = conn.execute('SELECT payload, extract(epoch FROM fetched_at) AS ts FROM source_cache WHERE source_key=%s AND cache_key=%s',
                               (source, brand_key)).fetchone()
        return (float(row['ts']), row['payload']) if row else None

    def put(self, source, brand_key, items):
        with connect(self.url) as conn:
            conn.execute('''INSERT INTO source_cache (source_key, cache_key, payload, fetched_at) VALUES (%s, %s, %s, now())
                            ON CONFLICT (source_key, cache_key) DO UPDATE SET payload=EXCLUDED.payload, fetched_at=now()''',
                         (source, brand_key, Jsonb(items)))


def enqueue_due_scans(conn):
    """Queue a scheduled scan for every brand whose interval has passed. Returns the number queued."""
    rows = conn.execute('''
        WITH due AS (
          SELECT b.id, b.mode FROM brands b
          WHERE b.scan_interval_minutes IS NOT NULL AND (b.next_scan_at IS NULL OR b.next_scan_at <= now())
            AND b.sources IS DISTINCT FROM '[]'::jsonb
            AND NOT EXISTS (SELECT 1 FROM scans s WHERE s.brand_id = b.id AND s.status IN ('queued', 'running'))
          FOR UPDATE OF b SKIP LOCKED
        ), queued AS (
          INSERT INTO scans (brand_id, mode, trigger) SELECT id, mode, 'schedule' FROM due RETURNING brand_id
        )
        UPDATE brands SET next_scan_at = now() + make_interval(mins => scan_interval_minutes)
        WHERE id IN (SELECT brand_id FROM queued) RETURNING id''').fetchall()
    conn.commit()
    return len(rows)


def reap_stale(conn):
    """Fail scans that died too many times. Returns their ids."""
    rows = conn.execute('''UPDATE scans SET status='failed', finished_at=now(), error='Worker stopped responding; gave up after %s attempts'
                           WHERE status='running' AND heartbeat_at < now() - make_interval(mins => %s) AND attempts >= %s RETURNING id''',
                        (MAX_ATTEMPTS, STALE_MINUTES, MAX_ATTEMPTS)).fetchall()
    conn.commit()
    return [r['id'] for r in rows]


def claim(conn):
    row = conn.execute('''
        UPDATE scans SET status='running', started_at=now(), heartbeat_at=now(), attempts=attempts+1, error=NULL
        WHERE id = (
          SELECT id FROM scans
          WHERE status='queued' OR (status='running' AND heartbeat_at < now() - make_interval(mins => %s) AND attempts < %s)
          ORDER BY queued_at FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING *''', (STALE_MINUTES, MAX_ATTEMPTS)).fetchone()
    conn.commit()
    return row


def load_brand(conn, brand_id):
    b = conn.execute('SELECT * FROM brands WHERE id=%s', (brand_id,)).fetchone()
    if not b:
        return None
    allow = conn.execute('SELECT platform, external_id, type FROM allowlist WHERE brand_id=%s', (brand_id,)).fetchall()
    demo = b['mode'] == 'demo'  # synthetic data: its assets stand in for confirmed ones so the benchmark stays measurable
    declared = {d.lower() for d in [b['domain']] + list(b['domains'] or []) if d}
    if demo:
        proven = declared
    else:
        rows = conn.execute('SELECT domain FROM domain_proofs WHERE brand_id=%s AND verified_at IS NOT NULL', (brand_id,)).fetchall()
        proven = {r['domain'].lower() for r in rows} & declared

    def with_trust(items):
        return [{**x, 'trust': 'confirmed' if demo else (x.get('trust') or 'unverified')} for x in items or []]

    return {
        'id': b['id'], 'name': b['name'], 'mode': b['mode'], 'domain': b['domain'], 'domains': b['domains'], 'description': b['description'],
        'logoUrl': b['logo_url'], 'aliases': b['aliases'], 'keywords': b['keywords'], 'officialSocials': with_trust(b['official_socials']),
        'officialApps': with_trust(b['official_apps']), 'confirmedDomains': sorted(proven), 'sources': b['sources'],
        'allowlist': [{'platform': a['platform'], 'externalId': a['external_id'], 'type': a['type']} for a in allow],
    }


def scan_status(sources):
    attempted = [s for s in sources if s['status'] not in ('disabled', 'not_configured', 'unsupported')]
    failed = [s for s in attempted if s['status'] in ERROR_STATUSES]
    if attempted and len(failed) == len(attempted):
        return 'failed'
    if failed or any(s['status'] in ('partial', 'cached') for s in attempted):
        return 'partial'
    return 'succeeded'


def _heartbeat(url, scan_id, stop):
    while not stop.wait(30):
        try:
            with connect(url) as conn:
                conn.execute('UPDATE scans SET heartbeat_at=now() WHERE id=%s', (scan_id,))
        except Exception:  # a missed heartbeat only risks a duplicate run, which is idempotent
            log.warning('heartbeat failed for scan %s', scan_id)


def mark_not_seen(conn, scan, brand, sources):
    """Count a miss for findings that a fully successful source did not return this time.

    A source that failed, was throttled, answered partially or from cache says nothing about absence, so those
    findings are left alone. Nothing is resolved automatically: a person decides what a missing finding means."""
    for s in sources:
        if s['status'] != 'ok':
            continue
        rows = conn.execute('''
            UPDATE findings SET missed_scans = missed_scans + 1, last_missed_scan_id = %s
            WHERE brand_id=%s AND mode=%s AND source_key=%s AND last_scan_id IS DISTINCT FROM %s
              AND last_missed_scan_id IS DISTINCT FROM %s
            RETURNING id, missed_scans''', (scan['id'], brand['id'], scan['mode'], s['key'], scan['id'], scan['id'])).fetchall()
        for r in rows:
            if r['missed_scans'] == 1:
                conn.execute("INSERT INTO finding_events (finding_id, scan_id, kind, note) VALUES (%s, %s, 'not_seen', %s)",
                             (r['id'], scan['id'], f"Not returned by {s['label']} in a complete scan"))


def persist(conn, scan, brand, result):
    """Write a finished scan. Upserts findings and records audit events. Returns new findings to alert on."""
    new_alerts = []
    for d in result['detections']:
        row = conn.execute('''
            INSERT INTO findings (brand_id, mode, type, platform, external_id, name, handle, app_id, publisher, url, icon_url,
                                  description, category, source_key, score, severity, probability, signals, reasons, features, evidence, last_scan_id)
            VALUES (%(brand)s, %(mode)s, %(type)s, %(platform)s, %(ext)s, %(name)s, %(handle)s, %(app)s, %(pub)s, %(url)s, %(icon)s,
                    %(desc)s, %(cat)s, %(src)s, %(score)s, %(sev)s, %(prob)s, %(signals)s, %(reasons)s, %(features)s, %(evidence)s, %(scan)s)
            ON CONFLICT (brand_id, platform, external_id) DO UPDATE SET
              name=EXCLUDED.name, handle=EXCLUDED.handle, publisher=EXCLUDED.publisher, url=EXCLUDED.url, icon_url=EXCLUDED.icon_url,
              description=EXCLUDED.description, category=EXCLUDED.category, score=EXCLUDED.score, severity=EXCLUDED.severity,
              probability=EXCLUDED.probability, signals=EXCLUDED.signals, reasons=EXCLUDED.reasons, features=EXCLUDED.features,
              evidence=EXCLUDED.evidence, last_seen_at=now(), last_scan_id=EXCLUDED.last_scan_id,
              missed_scans=CASE WHEN %(cached)s THEN findings.missed_scans ELSE 0 END, updated_at=now()
            RETURNING id, status, (xmax = 0) AS inserted,
              (SELECT score FROM findings f WHERE f.brand_id=%(brand)s AND f.platform=%(platform)s AND f.external_id=%(ext)s) AS old_score,
              (SELECT missed_scans FROM findings f WHERE f.brand_id=%(brand)s AND f.platform=%(platform)s AND f.external_id=%(ext)s) AS old_missed''', {
            'brand': brand['id'], 'mode': scan['mode'], 'type': d.get('type', 'social'), 'platform': d.get('platform', ''),
            'ext': str(d.get('externalId') or d.get('name', ''))[:500], 'name': (d.get('name') or '')[:300], 'handle': (d.get('handle') or '')[:300],
            'app': d.get('appId') or '', 'pub': d.get('publisher') or '', 'url': d.get('url') or '', 'icon': d.get('iconUrl') or '',
            'desc': (d.get('description') or '')[:2000], 'cat': d.get('category') or '', 'src': d.get('source') or '', 'score': d['score'],
            'sev': d['severity'], 'prob': d.get('probability'), 'signals': Jsonb(d.get('signals') or []),
            'reasons': Jsonb(d.get('reasons') or []), 'features': Jsonb({'values': d.get('features'), 'factors': d.get('factors')}),
            'evidence': Jsonb(d.get('evidence') or {}), 'scan': scan['id'], 'cached': bool((d.get('evidence') or {}).get('cached')),
        }).fetchone()
        # Every scan keeps its own copy of what it saw; the findings row only holds the latest.
        conn.execute('''
            INSERT INTO finding_observations (finding_id, scan_id, source_key, score, severity, probability, signals, reasons, features, evidence)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (finding_id, scan_id) DO UPDATE SET source_key=EXCLUDED.source_key, score=EXCLUDED.score, severity=EXCLUDED.severity,
              probability=EXCLUDED.probability, signals=EXCLUDED.signals, reasons=EXCLUDED.reasons, features=EXCLUDED.features,
              evidence=EXCLUDED.evidence, observed_at=now()''',
                     (row['id'], scan['id'], d.get('source') or '', d['score'], d['severity'], d.get('probability'), Jsonb(d.get('signals') or []),
                      Jsonb(d.get('reasons') or []), Jsonb({'values': d.get('features'), 'factors': d.get('factors')}), Jsonb(d.get('evidence') or {})))
        if row['inserted']:
            conn.execute("INSERT INTO finding_events (finding_id, scan_id, kind, to_status, score) VALUES (%s, %s, 'detected', 'new', %s)",
                         (row['id'], scan['id'], d['score']))
            if SEVERITY_RANK.get(d['severity'], 0) >= SEVERITY_RANK.get(os.getenv('ALERT_MIN_SEVERITY', 'High'), 2):
                new_alerts.append({**d, 'findingId': row['id']})
        elif row['status'] == 'resolved' and not (d.get('evidence') or {}).get('cached'):
            # Taken down, yet a live scan sees it again: that needs a person's attention, not silence.
            conn.execute("UPDATE findings SET status='new', updated_at=now() WHERE id=%s", (row['id'],))
            conn.execute("INSERT INTO finding_events (finding_id, scan_id, kind, from_status, to_status, score, note) VALUES (%s, %s, 'status_change', 'resolved', 'new', %s, %s)",
                         (row['id'], scan['id'], d['score'], 'Reopened automatically: observed again after being marked resolved'))
        elif row['old_missed'] and not (d.get('evidence') or {}).get('cached'):  # a cached copy is not a new sighting
            conn.execute("INSERT INTO finding_events (finding_id, scan_id, kind, score, note) VALUES (%s, %s, 'seen_again', %s, %s)",
                         (row['id'], scan['id'], d['score'], f"Observed again after {row['old_missed']} scan(s) without it"))
        elif row['old_score'] is not None and abs(row['old_score'] - d['score']) >= 5 and row['status'] not in QUIET_STATUSES:
            conn.execute("INSERT INTO finding_events (finding_id, scan_id, kind, score, note) VALUES (%s, %s, 'rescored', %s, %s)",
                         (row['id'], scan['id'], d['score'], f"Score changed from {row['old_score']} to {d['score']}"))

    mark_not_seen(conn, scan, brand, result['sources'])

    for s in result['sources']:
        if s['status'] in ('disabled',):
            continue
        ok = s['status'] in ('ok', 'partial')
        conn.execute('''
            INSERT INTO source_health (source_key, label, status, message, last_ok_at, last_error_at, consecutive_failures, updated_at)
            VALUES (%(k)s, %(l)s, %(s)s, %(m)s, CASE WHEN %(ok)s THEN now() END, CASE WHEN %(err)s THEN now() END, CASE WHEN %(err)s THEN 1 ELSE 0 END, now())
            ON CONFLICT (source_key) DO UPDATE SET label=EXCLUDED.label, status=EXCLUDED.status, message=EXCLUDED.message,
              last_ok_at=COALESCE(EXCLUDED.last_ok_at, source_health.last_ok_at),
              last_error_at=COALESCE(EXCLUDED.last_error_at, source_health.last_error_at),
              consecutive_failures=CASE WHEN %(err)s THEN source_health.consecutive_failures + 1 WHEN %(ok)s THEN 0 ELSE source_health.consecutive_failures END,
              updated_at=now()''', {'k': s['key'], 'l': s['label'], 's': s['status'], 'm': s.get('message', '')[:500],
                                     'ok': ok, 'err': s['status'] in ERROR_STATUSES})

    status = scan_status(result['sources'])
    conn.execute('''UPDATE scans SET status=%s, finished_at=now(), queries=%s, stats=%s, sources=%s, excluded=%s, evaluation=%s, model=%s,
                    error=%s WHERE id=%s''', (
        status, Jsonb(result['queries']), Jsonb(result['stats']), Jsonb(result['sources']), Jsonb(result['excluded']),
        Jsonb(result['evaluation']) if result['evaluation'] else None, Jsonb(result['model']),
        'Every source that ran failed; see source health' if status == 'failed' else None, scan['id']))
    conn.commit()
    return new_alerts


def _post_alert(url, brand_name, scan_id, findings):
    """POST findings to the webhook through the SSRF-safe fetcher. Returns None on success or a short error."""
    lines = [f"• [{f['severity']}] {f.get('platform')}: {f.get('name')} ({f['score']}/100) {f.get('url') or ''}" for f in findings[:20]]
    text = f"SignalGuard found {len(findings)} new {'finding' if len(findings) == 1 else 'findings'} for {brand_name}:\n" + '\n'.join(lines)
    payload = {'text': text, 'brand': brand_name, 'scanId': scan_id,
               'findings': [{k: f.get(k) for k in ('findingId', 'platform', 'name', 'url', 'score', 'severity', 'category')} for f in findings]}
    try:
        response = safe_http.fetch(url, timeout=10, max_bytes=10_000, check_robots=False, accept='*/*', method='POST', json_body=payload)
        if response.status >= 400:
            return f'Webhook answered HTTP {response.status}'
    except (httpx.HTTPError, safe_http.UnsafeURLError) as exc:
        log.warning('alert webhook failed: %s', exc.__class__.__name__)
        return f'Webhook not reachable ({exc.__class__.__name__})'
    return None


def _record_delivery(conn, brand_id, scan_id, kind, error, finding_ids, retry_of=None):
    row = conn.execute('''INSERT INTO alert_deliveries (brand_id, scan_id, kind, ok, error, finding_ids, retry_of)
                          VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id''', (brand_id, scan_id, kind, error is None, error, Jsonb(finding_ids), retry_of)).fetchone()
    conn.commit()
    return row['id']


def send_alerts(conn, brand, scan_id, findings, url=None, retry_of=None):
    """POST new high-severity findings to ALERT_WEBHOOK_URL (Slack-compatible) and record the outcome.

    Returns the number sent. A failure is stored in alert_deliveries so people can see it and retry."""
    url = url or os.getenv('ALERT_WEBHOOK_URL')
    if not url or not findings:
        return 0
    ids = [f['findingId'] for f in findings]
    error = _post_alert(url, brand['name'], scan_id, findings)
    _record_delivery(conn, brand['id'], scan_id, 'findings', error, ids, retry_of)
    if error:
        return 0
    for f in findings:
        conn.execute("INSERT INTO finding_events (finding_id, scan_id, kind, note) VALUES (%s, %s, 'alerted', 'Sent to alert webhook')", (f['findingId'], scan_id))
    conn.commit()
    return len(findings)


def retry_alert(conn, delivery_id, url=None):
    """Resend a failed delivery. Returns {'ok': bool, 'error': str|None}."""
    url = url or os.getenv('ALERT_WEBHOOK_URL')
    d = conn.execute('SELECT * FROM alert_deliveries WHERE id=%s', (delivery_id,)).fetchone()
    if not d or d['ok'] or d['kind'] != 'findings':
        return {'ok': False, 'error': 'Only a failed alert delivery can be retried.'}
    if not url:
        return {'ok': False, 'error': 'ALERT_WEBHOOK_URL is not set.'}
    if conn.execute('SELECT 1 FROM alert_deliveries WHERE retry_of=%s AND ok', (delivery_id,)).fetchone():
        return {'ok': True, 'error': None}  # already redelivered
    brand = conn.execute('SELECT id, name FROM brands WHERE id=%s', (d['brand_id'],)).fetchone()
    rows = conn.execute('SELECT id, platform, name, url, score, severity, category FROM findings WHERE id = ANY(%s)', (list(d['finding_ids']),)).fetchall()
    if not brand or not rows:
        return {'ok': False, 'error': 'The findings for this alert no longer exist.'}
    sent = send_alerts(conn, brand, d['scan_id'], [{**r, 'findingId': r['id']} for r in rows], url, retry_of=delivery_id)
    last = conn.execute('SELECT ok, error FROM alert_deliveries ORDER BY id DESC LIMIT 1').fetchone()
    return {'ok': bool(sent), 'error': last['error']}


def send_test_alert(conn, url=None):
    """Post a clearly labelled test message. Returns {'ok': bool, 'error': str|None}."""
    url = url or os.getenv('ALERT_WEBHOOK_URL')
    if not url:
        return {'ok': False, 'error': 'ALERT_WEBHOOK_URL is not set.'}
    try:
        response = safe_http.fetch(url, timeout=10, max_bytes=10_000, check_robots=False, accept='*/*', method='POST',
                                   json_body={'text': 'SignalGuard test alert. No finding is attached.', 'test': True})
        error = f'Webhook answered HTTP {response.status}' if response.status >= 400 else None
    except (httpx.HTTPError, safe_http.UnsafeURLError) as exc:
        error = f'Webhook not reachable ({exc.__class__.__name__})'
    _record_delivery(conn, None, None, 'test', error, [])
    return {'ok': error is None, 'error': error}


def touch_worker(conn, name, kind, scan_id=None):
    """Record that a worker, cron call or API-triggered run is alive. The dashboard reads this."""
    conn.execute('''INSERT INTO workers (name, kind, last_seen_at, last_scan_id) VALUES (%s, %s, now(), %s)
                    ON CONFLICT (name) DO UPDATE SET last_seen_at=now(), kind=EXCLUDED.kind, last_scan_id=COALESCE(EXCLUDED.last_scan_id, workers.last_scan_id)''', (name, kind, scan_id))
    conn.commit()


def run_job(engine, scan, url=None):
    stop = threading.Event()
    beat = threading.Thread(target=_heartbeat, args=(url, scan['id'], stop), daemon=True)
    beat.start()
    try:
        with connect(url) as conn:
            brand = load_brand(conn, scan['brand_id'])
            if brand is None:
                conn.execute("UPDATE scans SET status='failed', finished_at=now(), error='Brand was deleted' WHERE id=%s", (scan['id'],))
                conn.commit()
                return 'failed'
            if brand['mode'] != scan['mode']:
                raise RuntimeError(f"Scan mode {scan['mode']} does not match brand mode {brand['mode']}")
            # null means every configured source; an empty list means the user turned them all off.
            if brand.get('sources') is not None and not brand['sources']:
                conn.execute("UPDATE scans SET status='failed', finished_at=now(), error=%s WHERE id=%s",
                             ('No sources are enabled for this brand. Turn at least one on in the brand profile.', scan['id']))
                conn.commit()
                return 'failed'
            enabled = set(brand['sources']) if brand.get('sources') is not None else None
            result = engine.scan(brand, mode=scan['mode'], enabled=enabled, cache=PgCache(url))
            alerts = persist(conn, scan, brand, result)
            send_alerts(conn, brand, scan['id'], alerts)
            return scan_status(result['sources'])
    except Exception as exc:
        log.exception('scan %s failed', scan['id'])
        with connect(url) as conn:
            final = scan['attempts'] >= MAX_ATTEMPTS
            conn.execute("UPDATE scans SET status=%s, finished_at=CASE WHEN %s THEN now() END, error=%s WHERE id=%s",
                         ('failed' if final else 'queued', final, f'{exc.__class__.__name__}: {exc}'[:500], scan['id']))
            conn.commit()
        return 'failed' if final else 'requeued'
    finally:
        stop.set()


def min_remaining_seconds():
    """Time a scan needs left in the budget before a worker may claim it (WORKER_MIN_REMAINING_SECONDS, default 90)."""
    return max(0.0, float(os.getenv('WORKER_MIN_REMAINING_SECONDS', '90')))


def can_claim(elapsed, budget_seconds, min_remaining):
    """True when enough of the budget is left to start another scan.

    The minimum is capped at the budget itself, so a call with a small budget still runs its first scan
    instead of leaving the queue to stall. Exactly the minimum left is enough."""
    remaining = budget_seconds - elapsed
    return remaining > 0 and remaining >= min(min_remaining, budget_seconds)


def run_pending(engine, url=None, budget_seconds=240, max_jobs=10, who=('local', 'worker'), min_remaining=None, clock=time.monotonic):
    """Queue due scans, then run queued ones until the time budget or job limit is reached.

    A scan is only claimed while at least `min_remaining` seconds of the budget are left, so a scan is not
    started just before the platform kills the call. Scans left unclaimed stay queued for the next call."""
    min_remaining = min_remaining_seconds() if min_remaining is None else min_remaining
    started, done = clock(), list[dict]()
    with connect(url) as conn:
        touch_worker(conn, f"{who[1]}:{who[0]}", who[1])
        queued = enqueue_due_scans(conn)
        reaped = reap_stale(conn)
    while len(done) < max_jobs and can_claim(clock() - started, budget_seconds, min_remaining):
        with connect(url) as conn:
            scan = claim(conn)
        if not scan:
            break
        done.append({'scanId': scan['id'], 'status': run_job(engine, scan, url)})
        with connect(url) as conn:
            touch_worker(conn, f"{who[1]}:{who[0]}", who[1], scan['id'])
    return {'scheduled': queued, 'reaped': reaped, 'ran': done}


def to_json(value):
    return json.loads(json.dumps(value, default=str))
