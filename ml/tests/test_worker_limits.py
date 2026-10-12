"""Execution-budget and database-timeout settings that need no database."""
import pytest

from brandml import jobs


@pytest.mark.parametrize('elapsed, expected', [
    (0, True),       # plenty of time
    (150, True),     # exactly 90 s of a 240 s budget left: the boundary is allowed
    (150.5, False),  # just under the minimum
    (230, False),    # the audit's case: a scan started now would overrun the platform limit
    (240, False),    # budget used up
    (300, False),    # past it
])
def test_can_claim_needs_the_minimum_remaining_time(elapsed, expected):
    assert jobs.can_claim(elapsed, 240, 90) is expected


def test_a_minimum_larger_than_the_budget_still_lets_the_first_scan_run():
    assert jobs.can_claim(0, 60, 90) is True
    assert jobs.can_claim(1, 60, 90) is False


def test_a_zero_minimum_keeps_the_old_check():
    assert jobs.can_claim(239.9, 240, 0) is True
    assert jobs.can_claim(240, 240, 0) is False


def test_min_remaining_reads_the_environment(monkeypatch):
    monkeypatch.delenv('WORKER_MIN_REMAINING_SECONDS', raising=False)
    assert jobs.min_remaining_seconds() == 90
    monkeypatch.setenv('WORKER_MIN_REMAINING_SECONDS', '45')
    assert jobs.min_remaining_seconds() == 45
    monkeypatch.setenv('WORKER_MIN_REMAINING_SECONDS', '-5')
    assert jobs.min_remaining_seconds() == 0


def test_database_timeouts_default_and_parse(monkeypatch):
    for name in ('DATABASE_CONNECT_TIMEOUT_MS', 'DATABASE_STATEMENT_TIMEOUT_MS'):
        monkeypatch.delenv(name, raising=False)
    assert jobs.connect_timeout_seconds() == 8 and jobs.statement_timeout_ms() == 30000
    monkeypatch.setenv('DATABASE_CONNECT_TIMEOUT_MS', '500')
    assert jobs.connect_timeout_seconds() == 2  # libpq treats anything under 2 s as 2 s
    monkeypatch.setenv('DATABASE_CONNECT_TIMEOUT_MS', '10001')
    assert jobs.connect_timeout_seconds() == 11  # rounded up, never shorter than asked
    monkeypatch.setenv('DATABASE_CONNECT_TIMEOUT_MS', '')
    monkeypatch.setenv('DATABASE_STATEMENT_TIMEOUT_MS', '0')
    assert jobs.connect_timeout_seconds() == 8 and jobs.statement_timeout_ms() == 0


def test_connect_passes_the_connect_timeout_and_sets_the_statement_limit(monkeypatch):
    seen = {}

    class FakeConnection:
        statement_timeout_ms = 0

    def fake_connect(url, **kwargs):
        seen.update(kwargs, url=url)
        return FakeConnection()

    monkeypatch.setattr(jobs.TimeoutConnection, 'connect', fake_connect)
    monkeypatch.setenv('DATABASE_CONNECT_TIMEOUT_MS', '5000')
    monkeypatch.setenv('DATABASE_STATEMENT_TIMEOUT_MS', '1500')
    conn = jobs.connect('postgresql://example.invalid/db')
    assert seen['connect_timeout'] == 5 and seen['cursor_factory'] is jobs.TimeoutCursor and seen['autocommit'] is False
    assert conn.statement_timeout_ms == 1500


def test_connect_timeout_failure_is_raised_not_swallowed(monkeypatch):
    def refuse(url, **kwargs):
        raise jobs.psycopg.OperationalError('connection timeout expired')
    monkeypatch.setattr(jobs.TimeoutConnection, 'connect', refuse)
    with pytest.raises(jobs.psycopg.OperationalError):
        jobs.connect('postgresql://example.invalid/db')
