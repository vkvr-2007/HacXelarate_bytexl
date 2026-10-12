"""Worker tests against a real Postgres database (TEST_DATABASE_URL, a database whose name ends in _test)."""
import os
from pathlib import Path

import pytest
from conftest import NORTHSTAR

from brandml import jobs
from brandml.sources import social

URL = os.getenv('TEST_DATABASE_URL', 'postgresql://postgres@127.0.0.1:5432/signalguard_test')
MIGRATIONS = Path(__file__).resolve().parents[2] / 'db' / 'migrations'


def _available():
    try:
        jobs.connect(URL).close()
        return True
    except Exception:
        return False


# In CI a missing database is a failure, not a skip.
pytestmark = pytest.mark.skipif(not _available() and not os.getenv('CI'), reason='Postgres test database not reachable')


@pytest.fixture
def db():
    assert URL.rsplit('/', 1)[-1].endswith('_test'), 'refusing to reset a database whose name does not end in _test'
    with jobs.connect(URL) as conn:
        conn.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
        for path in sorted(MIGRATIONS.glob('*.sql')):
            conn.execute(path.read_text())
        conn.commit()
    yield URL


def add_brand(conn, mode='demo', **extra):
    row = conn.execute('''INSERT INTO brands (name, mode, domain, description, logo_url, official_socials, official_apps, sources, scan_interval_minutes)
                          VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id''', (
        extra.get('name', 'Northstar'), mode, 'northstar.com', NORTHSTAR['description'], NORTHSTAR['logoUrl'],
        jobs.Jsonb(extra.get('socials', NORTHSTAR['officialSocials'])), jobs.Jsonb(extra.get('apps', NORTHSTAR['officialApps'])),
        jobs.Jsonb(extra['sources']) if extra.get('sources') is not None else None, extra.get('interval'))).fetchone()
    conn.commit()
    return row['id']


def queue(conn, brand_id, mode='demo'):
    scan_id = conn.execute('INSERT INTO scans (brand_id, mode) VALUES (%s, %s) RETURNING id', (brand_id, mode)).fetchone()['id']
    conn.commit()
    return scan_id


def test_demo_scan_persists_findings_events_and_stats(db, engine):
    with jobs.connect(db) as conn:
        brand_id = add_brand(conn)
        scan_id = queue(conn, brand_id)
    result = jobs.run_pending(engine, db)
    assert result['ran'] == [{'scanId': scan_id, 'status': 'succeeded'}]
    with jobs.connect(db) as conn:
        scan = conn.execute('SELECT * FROM scans WHERE id=%s', (scan_id,)).fetchone()
        assert scan['status'] == 'succeeded' and scan['stats']['detections'] > 5 and scan['evaluation']['recall'] >= 0.9
        findings = conn.execute('SELECT * FROM findings WHERE brand_id=%s', (brand_id,)).fetchall()
        assert len(findings) == scan['stats']['detections'] and all(f['mode'] == 'demo' for f in findings)
        assert all(f['evidence']['scoredAt'] and f['evidence']['source'] == 'demo' for f in findings)
        events = conn.execute("SELECT count(*) AS n FROM finding_events WHERE kind='detected'").fetchone()['n']
        assert events == len(findings)
        health = conn.execute("SELECT status FROM source_health WHERE source_key='demo'").fetchone()
        assert health['status'] == 'ok'


def test_rescans_update_findings_without_duplicating_or_resetting_review(db, engine):
    with jobs.connect(db) as conn:
        brand_id = add_brand(conn)
        queue(conn, brand_id)
    jobs.run_pending(engine, db)
    with jobs.connect(db) as conn:
        first = conn.execute('SELECT id FROM findings ORDER BY score DESC LIMIT 1').fetchone()['id']
        conn.execute("UPDATE findings SET status='false_positive' WHERE id=%s", (first,))
        count = conn.execute('SELECT count(*) AS n FROM findings').fetchone()['n']
        queue(conn, brand_id)
    jobs.run_pending(engine, db)
    with jobs.connect(db) as conn:
        assert conn.execute('SELECT count(*) AS n FROM findings').fetchone()['n'] == count
        assert conn.execute('SELECT status FROM findings WHERE id=%s', (first,)).fetchone()['status'] == 'false_positive'
        assert conn.execute("SELECT count(*) AS n FROM finding_events WHERE kind='detected'").fetchone()['n'] == count


def test_live_scan_with_every_source_failing_is_marked_failed(db, engine):
    with jobs.connect(db) as conn:
        brand_id = add_brand(conn, mode='live', sources=['bluesky'])
        scan_id = queue(conn, brand_id, 'live')
    assert jobs.run_pending(engine, db)['ran'][0]['status'] == 'failed'  # network is off in tests
    with jobs.connect(db) as conn:
        scan = conn.execute('SELECT * FROM scans WHERE id=%s', (scan_id,)).fetchone()
        assert scan['status'] == 'failed' and 'source health' in scan['error']
        assert conn.execute('SELECT count(*) AS n FROM findings').fetchone()['n'] == 0
        health = conn.execute("SELECT * FROM source_health WHERE source_key='bluesky'").fetchone()
        assert health['status'] == 'unavailable' and health['consecutive_failures'] == 1


def test_live_scan_uses_postgres_cache_after_a_failure(db, engine, monkeypatch):
    results = [[{'type': 'social', 'platform': 'Bluesky', 'name': 'Northstar Support', 'handle': '@northstar-support.bsky.social',
                 'externalId': 'did:plc:x', 'description': 'DM us your account number for refunds', 'url': 'https://bsky.app/profile/x'}]]

    def search(self, query, brand):
        if results:
            return results.pop()
        raise social.SourceError('rate_limited', 'Rate limited')
    monkeypatch.setattr(social.BlueskyCollector, 'search', search)
    with jobs.connect(db) as conn:
        brand_id = add_brand(conn, mode='live', sources=['bluesky'])
        queue(conn, brand_id, 'live')
    jobs.run_pending(engine, db)
    with jobs.connect(db) as conn:
        queue(conn, brand_id, 'live')
    assert jobs.run_pending(engine, db)['ran'][0]['status'] == 'partial'
    with jobs.connect(db) as conn:
        scan = conn.execute('SELECT sources FROM scans ORDER BY id DESC LIMIT 1').fetchone()
        assert {s['key']: s['status'] for s in scan['sources']}['bluesky'] == 'cached'


def test_scheduled_rescans_are_queued_once(db):
    with jobs.connect(db) as conn:
        add_brand(conn, interval=60)
        add_brand(conn, name='Other')  # no schedule
        assert jobs.enqueue_due_scans(conn) == 1
        assert jobs.enqueue_due_scans(conn) == 0  # next_scan_at moved forward, and one is already queued
        row = conn.execute("SELECT trigger FROM scans").fetchone()
        assert row['trigger'] == 'schedule'


def test_stale_running_scans_are_retried_then_failed(db, engine):
    with jobs.connect(db) as conn:
        brand_id = add_brand(conn)
        scan_id = queue(conn, brand_id)
        conn.execute("UPDATE scans SET status='running', attempts=1, heartbeat_at=now() - interval '1 hour' WHERE id=%s", (scan_id,))
        conn.commit()
        claimed = jobs.claim(conn)
        assert claimed['id'] == scan_id and claimed['attempts'] == 2
        conn.execute("UPDATE scans SET status='running', attempts=%s, heartbeat_at=now() - interval '1 hour' WHERE id=%s", (jobs.MAX_ATTEMPTS, scan_id))
        conn.commit()
        assert jobs.claim(conn) is None
        assert jobs.reap_stale(conn) == [scan_id]


def test_two_workers_never_claim_the_same_scan(db):
    with jobs.connect(db) as conn:
        brand_id = add_brand(conn)
        queue(conn, brand_id)
    with jobs.connect(db) as a, jobs.connect(db) as b:
        first, second = jobs.claim(a), jobs.claim(b)
    assert first and second is None


def test_crash_during_scan_requeues_then_fails(db, engine, monkeypatch):
    with jobs.connect(db) as conn:
        brand_id = add_brand(conn)
        scan_id = queue(conn, brand_id)
    monkeypatch.setattr(engine, 'scan', lambda *a, **k: (_ for _ in ()).throw(RuntimeError('boom')))
    statuses = [run['status'] for run in jobs.run_pending(engine, db, max_jobs=5)['ran']]
    assert statuses == ['requeued', 'requeued', 'failed']
    with jobs.connect(db) as conn:
        scan = conn.execute('SELECT status, error FROM scans WHERE id=%s', (scan_id,)).fetchone()
        assert scan['status'] == 'failed' and 'boom' in scan['error']


def test_mode_mismatch_is_refused(db, engine):
    with jobs.connect(db) as conn:
        brand_id = add_brand(conn, mode='live')
        queue(conn, brand_id, 'demo')
    assert jobs.run_pending(engine, db)['ran'][0]['status'] == 'requeued'


def test_alerts_are_posted_and_recorded(db, engine, monkeypatch):
    sent = []
    monkeypatch.setattr(jobs.safe_http, 'fetch', lambda url, json_body=None, **kw: sent.append(json_body) or jobs.safe_http.FetchResult(url, 200, {}, b'', 0))
    monkeypatch.setenv('ALERT_WEBHOOK_URL', 'https://hooks.example.test/x')
    with jobs.connect(db) as conn:
        queue(conn, add_brand(conn))
    jobs.run_pending(engine, db)
    assert len(sent) == 1 and sent[0]['brand'] == 'Northstar'
    assert all(f['severity'] in ('High', 'Critical') for f in sent[0]['findings'])
    with jobs.connect(db) as conn:
        assert conn.execute("SELECT count(*) AS n FROM finding_events WHERE kind='alerted'").fetchone()['n'] == len(sent[0]['findings'])


# ---------- Phase 2: sources, asset trust, observations, not-seen ----------

SUPPORT = {'type': 'social', 'platform': 'Bluesky', 'name': 'Northstar Support', 'handle': '@northstar-support.bsky.social',
           'externalId': 'did:plc:x', 'description': 'DM us your account number for refunds', 'url': 'https://bsky.app/profile/x'}


def bluesky_returns(monkeypatch, state):
    """state['results'] is a list of candidates, or an Exception to raise."""
    def search(self, query, brand):
        if isinstance(state['results'], Exception):
            raise state['results']
        return [dict(c) for c in state['results']]
    monkeypatch.setattr(social.BlueskyCollector, 'search', search)


def test_empty_source_list_runs_nothing_and_says_so(db, engine):
    with jobs.connect(db) as conn:
        brand_id = add_brand(conn, mode='live', sources=[], interval=60)
        scan_id = queue(conn, brand_id, 'live')
        conn.execute('UPDATE brands SET next_scan_at = now() - interval \'1 hour\' WHERE id=%s', (brand_id,))
        conn.commit()
    result = jobs.run_pending(engine, db)
    assert result['ran'] == [{'scanId': scan_id, 'status': 'failed'}]
    with jobs.connect(db) as conn:
        scan = conn.execute('SELECT * FROM scans WHERE id=%s', (scan_id,)).fetchone()
        assert scan['status'] == 'failed' and 'No sources are enabled' in scan['error'] and scan['sources'] is None
        assert conn.execute('SELECT count(*) AS n FROM source_health').fetchone()['n'] == 0
        assert conn.execute("SELECT count(*) AS n FROM scans WHERE trigger='schedule'").fetchone()['n'] == 0  # never scheduled either


def test_only_confirmed_assets_and_proven_domains_hide_results(engine):
    brand = {**NORTHSTAR, 'confirmedDomains': [], 'officialSocials': [{'platform': 'Bluesky', 'handle': '@northstar.bsky.social', 'trust': 'unverified'}],
             'officialApps': [{'store': 'Google Play', 'appId': 'com.fake.northstar', 'publisher': 'Evil Ltd', 'trust': 'suggested'}]}
    account = {'type': 'social', 'platform': 'Bluesky', 'handle': '@northstar.bsky.social', 'externalId': 'did:plc:n'}
    app = {'type': 'app', 'platform': 'Google Play', 'appId': 'com.fake.northstar', 'externalId': 'com.fake.northstar', 'publisher': 'Evil Ltd'}
    site = {'type': 'domain', 'handle': 'northstar.com', 'url': 'https://northstar.com'}
    for cand in (account, app, site):
        assert engine.official_match(brand, cand) is None
        assert 'not' in (engine.declared_match(brand, cand) or '') or 'unverified' in (engine.declared_match(brand, cand) or '') or 'suggested' in (engine.declared_match(brand, cand) or '')
    confirmed = {**brand, 'confirmedDomains': ['northstar.com'],
                 'officialSocials': [{**brand['officialSocials'][0], 'trust': 'confirmed'}],
                 'officialApps': [{**brand['officialApps'][0], 'trust': 'confirmed'}]}
    for cand in (account, app, site):
        assert engine.official_match(confirmed, cand)
    # A proven domain never covers a look-alike that merely contains it.
    assert engine.official_match(confirmed, {'type': 'domain', 'handle': 'northstar.com.evil.example'}) is None


def test_load_brand_marks_trust_from_the_database(db):
    with jobs.connect(db) as conn:
        live = add_brand(conn, mode='live', name='Acme', socials=[{'platform': 'X', 'handle': '@acme'}, {'platform': 'X', 'handle': '@acme2', 'trust': 'confirmed'}], apps=[])
        demo = add_brand(conn, mode='demo', name='Northstar Demo', socials=[{'platform': 'X', 'handle': '@ns'}], apps=[])
        conn.execute("INSERT INTO domain_proofs (brand_id, domain, token, verified_at) VALUES (%s, 'northstar.com', 't', now()), (%s, 'elsewhere.com', 't2', now())", (live, live))
        conn.execute("INSERT INTO domain_proofs (brand_id, domain, token) VALUES (%s, 'other.com', 't3')", (live,))
        conn.commit()
        acme = jobs.load_brand(conn, live)
        assert [a['trust'] for a in acme['officialSocials']] == ['unverified', 'confirmed']
        assert acme['confirmedDomains'] == ['northstar.com']  # proven and declared; 'elsewhere.com' is not on the profile
        northstar = jobs.load_brand(conn, demo)
        assert northstar['officialSocials'][0]['trust'] == 'confirmed' and northstar['confirmedDomains'] == ['northstar.com']


def test_unconfirmed_declared_account_stays_in_results_until_confirmed(db, engine, monkeypatch):
    state = {'results': [{**SUPPORT, 'handle': '@northstar.bsky.social', 'externalId': 'did:plc:n', 'name': 'Northstar', 'description': 'Official updates'}]}
    bluesky_returns(monkeypatch, state)
    socials = [{'platform': 'Bluesky', 'handle': '@northstar.bsky.social', 'trust': 'unverified'}]
    with jobs.connect(db) as conn:
        brand_id = add_brand(conn, mode='live', sources=['bluesky'], socials=socials, apps=[])
        queue(conn, brand_id, 'live')
    jobs.run_pending(engine, db)
    with jobs.connect(db) as conn:
        scan = conn.execute('SELECT excluded, stats FROM scans ORDER BY id DESC LIMIT 1').fetchone()
        assert scan['excluded'] == [] and scan['stats']['retrieved'] == 1
        conn.execute("UPDATE brands SET official_socials = %s WHERE id=%s", (jobs.Jsonb([{**socials[0], 'trust': 'confirmed'}]), brand_id))
        queue(conn, brand_id, 'live')
    jobs.run_pending(engine, db)
    with jobs.connect(db) as conn:
        scan = conn.execute('SELECT excluded FROM scans ORDER BY id DESC LIMIT 1').fetchone()
        assert [x['handle'] for x in scan['excluded']] == ['@northstar.bsky.social']


def test_every_scan_keeps_its_own_observation(db, engine):
    with jobs.connect(db) as conn:
        brand_id = add_brand(conn)
        queue(conn, brand_id)
    jobs.run_pending(engine, db)
    with jobs.connect(db) as conn:
        queue(conn, brand_id)
    jobs.run_pending(engine, db)
    with jobs.connect(db) as conn:
        findings = conn.execute('SELECT id FROM findings').fetchall()
        assert findings
        for f in findings:
            obs = conn.execute('SELECT scan_id, evidence FROM finding_observations WHERE finding_id=%s ORDER BY scan_id', (f['id'],)).fetchall()
            assert len(obs) == 2 and obs[0]['scan_id'] != obs[1]['scan_id']
            assert obs[0]['evidence']['scoredAt'] != obs[1]['evidence']['scoredAt']  # the first scan's evidence was not overwritten
        latest = conn.execute('SELECT evidence, last_scan_id FROM findings WHERE id=%s', (findings[0]['id'],)).fetchone()
        newest = conn.execute('SELECT evidence FROM finding_observations WHERE finding_id=%s AND scan_id=%s', (findings[0]['id'], latest['last_scan_id'])).fetchone()
        assert latest['evidence'] == newest['evidence']


def test_not_seen_counts_only_complete_scans_and_clears_when_seen_again(db, engine, monkeypatch):
    state = {'results': [SUPPORT]}
    bluesky_returns(monkeypatch, state)
    with jobs.connect(db) as conn:
        brand_id = add_brand(conn, mode='live', sources=['bluesky'], socials=[], apps=[])

    def scan():
        with jobs.connect(db) as conn:
            queue(conn, brand_id, 'live')
        return jobs.run_pending(engine, db)['ran'][0]['status']

    def finding():
        with jobs.connect(db) as conn:
            row = conn.execute('SELECT id, missed_scans, status FROM findings').fetchone()
            events = [e['kind'] for e in conn.execute('SELECT kind FROM finding_events WHERE finding_id=%s ORDER BY id', (row['id'],)).fetchall()]
        return row, events

    assert scan() == 'succeeded'
    row, _ = finding()
    assert row['missed_scans'] == 0

    state['results'] = []                                 # a complete scan that does not return it
    assert scan() == 'succeeded'
    row, events = finding()
    assert row['missed_scans'] == 1 and events.count('not_seen') == 1 and row['status'] == 'new'  # never auto-resolved

    assert scan() == 'succeeded'
    row, events = finding()
    assert row['missed_scans'] == 2 and events.count('not_seen') == 1  # one event, not one per scan

    state['results'] = social.SourceError('rate_limited', 'Rate limited')  # a failing source proves nothing: cached copies neither add nor clear misses
    scan()
    assert finding()[0]['missed_scans'] == 2

    state['results'] = [SUPPORT]
    assert scan() == 'succeeded'
    row, events = finding()
    assert row['missed_scans'] == 0 and events[-1] == 'seen_again'


# ---------- Phase 3: alert delivery records and worker liveness ----------

def _alert_fixture(monkeypatch, outcome):
    sent = []

    def fake(url, **kwargs):
        sent.append(kwargs['json_body'])
        if isinstance(outcome['value'], Exception):
            raise outcome['value']
        return type('R', (), {'status': outcome['value']})()
    monkeypatch.setattr(jobs.safe_http, 'fetch', fake)
    monkeypatch.setenv('ALERT_WEBHOOK_URL', 'https://hooks.example.test/x')
    return sent


def test_failed_alert_is_recorded_not_just_logged_and_can_be_retried(db, engine, monkeypatch):
    outcome = {'value': 500}
    sent = _alert_fixture(monkeypatch, outcome)
    with jobs.connect(db) as conn:
        queue(conn, add_brand(conn))
    jobs.run_pending(engine, db)
    with jobs.connect(db) as conn:
        failed = conn.execute("SELECT * FROM alert_deliveries WHERE kind='findings'").fetchone()
        assert failed['ok'] is False and failed['error'] == 'Webhook answered HTTP 500' and len(failed['finding_ids']) == len(sent[0]['findings'])
        assert conn.execute("SELECT count(*) AS n FROM finding_events WHERE kind='alerted'").fetchone()['n'] == 0  # nothing claimed as sent

        assert jobs.retry_alert(conn, failed['id']) == {'ok': False, 'error': 'Webhook answered HTTP 500'}
        outcome['value'] = 200
        assert jobs.retry_alert(conn, failed['id']) == {'ok': True, 'error': None}
        assert conn.execute("SELECT count(*) AS n FROM finding_events WHERE kind='alerted'").fetchone()['n'] == len(failed['finding_ids'])
        assert jobs.retry_alert(conn, failed['id']) == {'ok': True, 'error': None}  # already redelivered: not sent twice
        assert len(sent) == 3
        ok_row = conn.execute("SELECT id FROM alert_deliveries WHERE ok AND kind='findings'").fetchone()
        assert jobs.retry_alert(conn, ok_row['id'])['ok'] is False  # only failed deliveries are retried


def test_unreachable_webhook_and_private_address_are_failures_with_a_reason(db, engine, monkeypatch):
    outcome = {'value': jobs.httpx.ConnectError('no route')}
    _alert_fixture(monkeypatch, outcome)
    with jobs.connect(db) as conn:
        assert jobs.send_test_alert(conn) == {'ok': False, 'error': 'Webhook not reachable (ConnectError)'}
        outcome['value'] = jobs.safe_http.UnsafeURLError('private')
        assert jobs.send_test_alert(conn)['error'] == 'Webhook not reachable (UnsafeURLError)'
        outcome['value'] = 204
        assert jobs.send_test_alert(conn) == {'ok': True, 'error': None}
        assert [r['ok'] for r in conn.execute("SELECT ok FROM alert_deliveries WHERE kind='test' ORDER BY id").fetchall()] == [False, False, True]


def test_test_alert_without_a_webhook_says_so(db, monkeypatch):
    monkeypatch.delenv('ALERT_WEBHOOK_URL', raising=False)
    with jobs.connect(db) as conn:
        assert jobs.send_test_alert(conn) == {'ok': False, 'error': 'ALERT_WEBHOOK_URL is not set.'}


def test_worker_liveness_is_recorded_for_every_run(db, engine):
    with jobs.connect(db) as conn:
        queue(conn, add_brand(conn))
    jobs.run_pending(engine, db, who=('host-1', 'worker'))
    jobs.run_pending(engine, db, who=('serverless', 'cron'))
    with jobs.connect(db) as conn:
        rows = {r['name']: r for r in conn.execute('SELECT * FROM workers').fetchall()}
        assert set(rows) == {'worker:host-1', 'cron:serverless'}
        assert rows['worker:host-1']['last_scan_id'] is not None and rows['cron:serverless']['last_scan_id'] is None


# ---------- Phase 4: reopen resolved findings, feedback eligibility ----------

def test_resolved_finding_that_reappears_in_a_live_scan_is_reopened_with_a_reason(db, engine, monkeypatch):
    state = {'results': [SUPPORT]}
    bluesky_returns(monkeypatch, state)
    with jobs.connect(db) as conn:
        brand_id = add_brand(conn, mode='live', sources=['bluesky'], socials=[], apps=[])
        queue(conn, brand_id, 'live')
    jobs.run_pending(engine, db)
    with jobs.connect(db) as conn:
        fid = conn.execute('SELECT id FROM findings').fetchone()['id']
        conn.execute("UPDATE findings SET status='resolved' WHERE id=%s", (fid,))
        queue(conn, brand_id, 'live')
    jobs.run_pending(engine, db)
    with jobs.connect(db) as conn:
        assert conn.execute('SELECT status FROM findings WHERE id=%s', (fid,)).fetchone()['status'] == 'new'
        event = conn.execute("SELECT * FROM finding_events WHERE kind='status_change' AND finding_id=%s", (fid,)).fetchone()
        assert (event['from_status'], event['to_status']) == ('resolved', 'new') and 'Reopened automatically' in event['note']
        # a false positive stays dismissed when seen again
        conn.execute("UPDATE findings SET status='false_positive' WHERE id=%s", (fid,))
        queue(conn, brand_id, 'live')
    jobs.run_pending(engine, db)
    with jobs.connect(db) as conn:
        assert conn.execute('SELECT status FROM findings WHERE id=%s', (fid,)).fetchone()['status'] == 'false_positive'


def _feedback(conn, mode, label, n, features=None):
    from brandml.features import FEATURE_NAMES
    values = features or {name: 0.5 for name in FEATURE_NAMES}
    for _ in range(n):
        conn.execute('INSERT INTO ml_feedback (label, features, mode) VALUES (%s, %s, %s)', (label, jobs.Jsonb(values), mode))
    conn.commit()


def test_training_feedback_only_uses_live_rows_with_enough_of_both_classes(db, monkeypatch):
    import train
    monkeypatch.setenv('DATABASE_URL', db)
    monkeypatch.setattr(train, 'MIN_FEEDBACK_PER_CLASS', 5)
    with jobs.connect(db) as conn:
        _feedback(conn, 'demo', 1, 50)            # synthetic decisions never count
        _feedback(conn, None, 0, 50)              # unknown origin never counts
        _feedback(conn, 'live', 1, 6)
        _feedback(conn, 'live', 0, 4)
    X, y, report = train.load_feedback()
    assert (X, y) == ([], []) and report['used'] is False
    assert report['skipped'] == {'demo': 50, 'unknown origin': 50} and 'has 6 and 4' in report['reason']
    with jobs.connect(db) as conn:
        _feedback(conn, 'live', 0, 1)
    X, y, report = train.load_feedback()
    assert len(y) == 11 and sum(y) == 6 and report['used'] is True and report['eligible'] == 11


# ---------- execution-budget guard and statement timeouts ----------

def ticking(*times):
    """A clock that returns the given readings in order (run_pending reads it once at start, then before each claim)."""
    readings = iter(times)
    return lambda: next(readings)


def scan_row(db, scan_id):
    with jobs.connect(db) as conn:
        return conn.execute('SELECT status, attempts, started_at, finished_at FROM scans WHERE id=%s', (scan_id,)).fetchone()


def test_budget_guard_runs_a_scan_while_enough_time_is_left_and_leaves_the_next_one_queued(db, engine):
    with jobs.connect(db) as conn:
        first = queue(conn, add_brand(conn))
        second = queue(conn, add_brand(conn, name='Other'))
    # start 0, check 0 (100 s left: claim), check 20 (80 s left, under the 90 s minimum: stop)
    result = jobs.run_pending(engine, db, budget_seconds=100, min_remaining=90, clock=ticking(0, 0, 20))
    assert [r['scanId'] for r in result['ran']] == [first]
    row = scan_row(db, second)
    assert row['status'] == 'queued' and row['attempts'] == 0 and row['started_at'] is None and row['finished_at'] is None
    # The next call picks it up: an unclaimed scan is not lost.
    result = jobs.run_pending(engine, db, budget_seconds=100, min_remaining=90, clock=ticking(0, 0, 50))
    assert result['ran'] == [{'scanId': second, 'status': 'succeeded'}]


def test_budget_guard_claims_with_exactly_the_minimum_left(db, engine):
    with jobs.connect(db) as conn:
        ids = [queue(conn, add_brand(conn, name=f'Brand {n}')) for n in range(2)]
    # check 10 leaves exactly 90 s of a 100 s budget: still allowed; check 100 leaves nothing.
    result = jobs.run_pending(engine, db, budget_seconds=100, min_remaining=90, clock=ticking(0, 0, 10, 100))
    assert [r['scanId'] for r in result['ran']] == ids


def test_budget_guard_claims_nothing_when_too_little_time_is_left(db, engine):
    with jobs.connect(db) as conn:
        scan_id = queue(conn, add_brand(conn))
    assert jobs.run_pending(engine, db, budget_seconds=100, min_remaining=90, clock=ticking(0, 15))['ran'] == []
    row = scan_row(db, scan_id)
    assert row['status'] == 'queued' and row['attempts'] == 0 and row['finished_at'] is None


def test_budget_guard_leaves_a_stale_scan_alone_and_it_is_recovered_later(db, engine):
    with jobs.connect(db) as conn:
        scan_id = queue(conn, add_brand(conn))
        conn.execute("UPDATE scans SET status='running', attempts=1, heartbeat_at=now() - interval '1 hour' WHERE id=%s", (scan_id,))
        conn.commit()
    assert jobs.run_pending(engine, db, budget_seconds=100, min_remaining=90, clock=ticking(0, 50))['ran'] == []
    row = scan_row(db, scan_id)
    assert row['status'] == 'running' and row['attempts'] == 1 and row['finished_at'] is None  # not failed, not completed, not re-counted
    result = jobs.run_pending(engine, db, budget_seconds=100, min_remaining=90, clock=ticking(0, 0, 60))
    assert result['ran'] == [{'scanId': scan_id, 'status': 'succeeded'}]
    assert scan_row(db, scan_id)['attempts'] == 2


def test_budget_guard_keeps_retry_then_fail_behaviour(db, engine, monkeypatch):
    with jobs.connect(db) as conn:
        scan_id = queue(conn, add_brand(conn))
    monkeypatch.setattr(engine, 'scan', lambda *a, **k: (_ for _ in ()).throw(RuntimeError('boom')))
    # Two attempts fit before the budget runs low; the scan goes back to the queue, not to failed or succeeded.
    result = jobs.run_pending(engine, db, budget_seconds=100, min_remaining=90, max_jobs=5, clock=ticking(0, 0, 5, 30))
    assert [r['status'] for r in result['ran']] == ['requeued', 'requeued']
    row = scan_row(db, scan_id)
    assert row['status'] == 'queued' and row['attempts'] == 2 and row['finished_at'] is None
    # The last allowed attempt fails it for good, as before the guard.
    result = jobs.run_pending(engine, db, budget_seconds=100, min_remaining=90, clock=ticking(0, 0, 30))
    assert result['ran'] == [{'scanId': scan_id, 'status': 'failed'}]
    assert scan_row(db, scan_id)['status'] == 'failed'


def test_statement_timeout_is_set_per_transaction_and_cancels_long_statements(db, monkeypatch):
    monkeypatch.setenv('DATABASE_STATEMENT_TIMEOUT_MS', '200')
    with jobs.connect(db) as conn:
        assert conn.execute('SHOW statement_timeout').fetchone()['statement_timeout'] == '200ms'
        conn.commit()
        assert conn.execute('SHOW statement_timeout').fetchone()['statement_timeout'] == '200ms'  # applied again in the next transaction
        with pytest.raises(jobs.psycopg.errors.QueryCanceled):
            conn.execute('SELECT pg_sleep(2)')
        conn.rollback()
        assert conn.execute('SELECT 1 AS ok').fetchone()['ok'] == 1  # the connection is usable after a timeout
        conn.commit()
        conn.autocommit = True
        assert conn.execute('SHOW statement_timeout').fetchone()['statement_timeout'] == '0'  # SET LOCAL never outlives a transaction


def test_statement_timeout_rolls_back_the_transaction(db, monkeypatch):
    monkeypatch.setenv('DATABASE_STATEMENT_TIMEOUT_MS', '200')
    with jobs.connect(db) as conn:
        brand_id = add_brand(conn)
    with pytest.raises(jobs.psycopg.errors.QueryCanceled):
        with jobs.connect(db) as conn:
            conn.execute("UPDATE brands SET name='changed' WHERE id=%s", (brand_id,))
            conn.execute('SELECT pg_sleep(2)')
    with jobs.connect(db) as conn:
        assert conn.execute('SELECT name FROM brands WHERE id=%s', (brand_id,)).fetchone()['name'] == 'Northstar'


def test_scan_whose_statement_times_out_is_requeued_not_completed(db, engine, monkeypatch):
    with jobs.connect(db) as conn:
        scan_id = queue(conn, add_brand(conn))
    timeout = jobs.psycopg.errors.QueryCanceled('canceling statement due to statement timeout')
    monkeypatch.setattr(engine, 'scan', lambda *a, **k: (_ for _ in ()).throw(timeout))
    assert jobs.run_pending(engine, db, max_jobs=1)['ran'] == [{'scanId': scan_id, 'status': 'requeued'}]
    row = scan_row(db, scan_id)
    assert row['status'] == 'queued' and row['finished_at'] is None


def test_statement_timeout_can_be_turned_off(db, monkeypatch):
    monkeypatch.setenv('DATABASE_STATEMENT_TIMEOUT_MS', '0')
    with jobs.connect(db) as conn:
        assert conn.execute('SHOW statement_timeout').fetchone()['statement_timeout'] == '0'
