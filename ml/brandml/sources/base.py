"""Collector base classes, the trusted-API HTTP helper, rate limiting and retries."""
import os
import random
import threading
import time

import httpx

USER_AGENT = 'SignalGuard-DRP/2.0 (brand protection)'


def env(name, default=''):
    return os.getenv(name, default) or default


def timeout():
    return float(env('COLLECTOR_TIMEOUT', '10'))


class SourceError(Exception):
    """A source could not answer. `status` is one of the statuses below."""

    def __init__(self, status, message, retry_after=None):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


# Statuses a source can report after a scan.
STATUSES = ('ok', 'partial', 'cached', 'rate_limited', 'unavailable', 'auth_failed', 'not_configured', 'unsupported', 'disabled')


class RateLimiter:
    """Minimum spacing between requests to one source, shared by threads in this process."""

    def __init__(self):
        self._next = {}
        self._lock = threading.Lock()

    def wait(self, key, min_interval):
        if min_interval <= 0:
            return
        with self._lock:
            now = time.monotonic()
            start = max(now, self._next.get(key, now))
            self._next[key] = start + min_interval
        delay = start - now
        if delay > 0:
            time.sleep(delay)


limiter = RateLimiter()


def api_request(method, url, *, source, params=None, headers=None, data=None, auth=None, json_body=None,
                retries=2, min_interval=0.0, client=None):
    """Call a fixed, trusted API host with rate limiting and safe retries.

    Retries only idempotent failures (timeouts, connection errors, 429 and 5xx),
    with exponential backoff and jitter, honouring Retry-After up to 15 seconds.
    """
    attempt = 0
    while True:
        limiter.wait(source, min_interval)
        try:
            response = (client or httpx).request(
                method, url, params=params, data=data, json=json_body, auth=auth,
                headers={'User-Agent': USER_AGENT, **(headers or {})}, timeout=timeout(),
            )
        except httpx.TimeoutException as exc:
            error = SourceError('unavailable', 'Timed out')
            cause = exc
        except httpx.HTTPError as exc:
            error = SourceError('unavailable', f'Network error: {exc.__class__.__name__}')
            cause = exc
        else:
            if response.status_code < 400:
                try:
                    return response.json()
                except ValueError as exc:
                    raise SourceError('unavailable', 'Response was not JSON') from exc
            cause = None
            retry_after = _retry_after(response)
            if response.status_code == 429:
                error = SourceError('rate_limited', 'Rate limited by the platform', retry_after)
            elif response.status_code in (401, 403):
                raise SourceError('auth_failed', f'Access refused (HTTP {response.status_code}). Check the key and its permissions.')
            elif response.status_code >= 500:
                error = SourceError('unavailable', f'Platform error (HTTP {response.status_code})', retry_after)
            else:
                raise SourceError('unavailable', f'HTTP {response.status_code}: {response.text[:160]}')
        if attempt >= retries:
            raise error from cause
        delay = error.retry_after if error.retry_after is not None else (2 ** attempt) + random.random()
        if delay > 15:
            raise error from cause
        time.sleep(delay)
        attempt += 1


def _retry_after(response):
    value = response.headers.get('retry-after')
    try:
        return float(value) if value is not None else None
    except ValueError:
        return None


class Collector:
    key = ''
    label = ''
    category = 'social'          # social | app | web | domain
    mode = 'live'                # live | demo
    env_vars: tuple[str, ...] = ()      # all must be set for the source to run
    optional_env: tuple[str, ...] = ()
    docs = ''
    access = ''                  # human description of what access is needed
    cost = 'Free'
    support = 'supported'        # supported | approval_required | paid | unsupported
    per_query = True             # False: called once per scan with all queries

    def configured(self):
        return all(env(name) for name in self.env_vars)

    def missing(self):
        return [name for name in self.env_vars if not env(name)]

    def search(self, query, brand):
        raise NotImplementedError

    def describe(self):
        return {
            'key': self.key, 'label': self.label, 'category': self.category, 'mode': self.mode,
            'configured': self.configured(), 'envVars': list(self.env_vars), 'optionalEnv': list(self.optional_env),
            'missing': self.missing(), 'docs': self.docs, 'access': self.access, 'cost': self.cost, 'support': self.support,
        }


class UnsupportedCollector(Collector):
    """A platform with no API that allows this kind of search. Reported honestly, never faked."""
    support = 'unsupported'

    def configured(self):
        return False

    def search(self, query, brand):
        raise SourceError('unsupported', self.access)
