"""Every source SignalGuard knows about, and the runner that calls them.

Live and Demo are kept strictly apart: a demo brand runs only the demo
collector, and a live brand never runs it. A failing source never fails the
scan; it reports one of base.STATUSES. When a live source fails, the last good
live results for that source and brand are reused and marked as cached, with
the time they were collected.
"""
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout

from . import apidirect
from .appstores import AppStoreCollector, GooglePlayCollector
from .base import SourceError, env, timeout
from .demo import DemoCollector
from .domains import CertTransparencyCollector, LookalikeDomainCollector
from .social import (
    BlueskyCollector, FacebookPagesCollector, InstagramCollector, LinkedInCollector, MastodonCollector,
    RedditCollector, TelegramCollector, ThreadsCollector, TikTokCollector, XCollector, YouTubeCollector,
)
from .web import WebSearchCollector

ALL_COLLECTORS = [
    DemoCollector(),
    AppStoreCollector(), GooglePlayCollector(),
    BlueskyCollector(), MastodonCollector(), YouTubeCollector(), RedditCollector(),
    XCollector(), InstagramCollector(), ThreadsCollector(), FacebookPagesCollector(),
    *apidirect.COLLECTORS,
    TikTokCollector(), LinkedInCollector(), TelegramCollector(),
    WebSearchCollector(), LookalikeDomainCollector(), CertTransparencyCollector(),
]
BY_KEY = {c.key: c for c in ALL_COLLECTORS}
CACHE_MAX_AGE = 7 * 24 * 3600


class MemoryCache:
    """Last good results per (source, brand). The worker swaps in a Postgres-backed cache."""

    def __init__(self):
        self._items = {}

    def get(self, source, brand_key):
        return self._items.get((source, brand_key))

    def put(self, source, brand_key, items):
        self._items[(source, brand_key)] = (time.time(), items)


memory_cache = MemoryCache()


def describe_all():
    return [c.describe() for c in ALL_COLLECTORS]


def _skip_reason(collector, mode, enabled):
    if mode == 'demo' and collector.mode != 'demo':
        return 'disabled', 'Demo brand: live sources never run for demo data'
    if mode == 'live' and collector.mode == 'demo':
        return 'disabled', 'Live brand: demo data is never used'
    if enabled is not None and collector.key not in enabled:
        return 'disabled', 'Turned off for this brand'
    if collector.support == 'unsupported':
        return 'unsupported', collector.access
    if not collector.configured():
        return 'not_configured', f"Needs {', '.join(collector.missing())}. See {collector.docs}"
    return None


def run_collectors(brand, queries, mode='live', enabled=None, cache=None, max_queries=None):
    """Run the sources that apply to this brand in parallel. Returns (candidates, statuses)."""
    if mode not in ('live', 'demo'):
        raise ValueError(f'Unknown mode {mode!r}')
    cache = cache or memory_cache
    brand_key = str(brand.get('id') or brand.get('name', '')).lower()
    max_queries = max_queries or int(env('MAX_QUERIES_PER_SOURCE', '4'))
    statuses, candidates, jobs = [], [], {}
    pool = ThreadPoolExecutor(max_workers=int(env('COLLECTOR_CONCURRENCY', '8')))
    for collector in ALL_COLLECTORS:
        info = {'key': collector.key, 'label': collector.label, 'category': collector.category,
                'mode': collector.mode, 'support': collector.support, 'count': 0}
        skip = _skip_reason(collector, mode, enabled)
        if skip:
            statuses.append({**info, 'status': skip[0], 'message': skip[1]})
            continue
        query_list = queries[:max_queries] if collector.per_query else queries[:1]
        jobs[collector.key] = (collector, info, [pool.submit(collector.search, q, brand) for q in query_list], time.time())

    deadline = float(env('SOURCE_DEADLINE', str(timeout() * 4 + 10)))
    for key, (collector, info, futures, started) in jobs.items():
        found, errors = [], []
        for future in futures:
            remaining = max(1.0, deadline - (time.time() - started))
            try:
                found.extend(future.result(timeout=remaining))
            except FutureTimeout:
                errors.append(SourceError('unavailable', 'Timed out'))
            except SourceError as exc:
                errors.append(exc)
            except Exception as exc:  # one broken source must not break the scan
                errors.append(SourceError('unavailable', f'{exc.__class__.__name__}: {exc}'[:160]))
        latency = int((time.time() - started) * 1000)
        for item in found:
            item.setdefault('source', collector.key)
            item.setdefault('collectedAt', time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
        result = {**info, 'latencyMs': latency, 'queries': len(futures)}
        if found:
            status = 'partial' if errors else 'ok'
            message = f'{len(errors)} of {len(futures)} queries failed: {errors[0]}' if errors else f'{len(found)} results from {len(futures)} queries'
            if collector.mode == 'live':
                cache.put(key, brand_key, found)
        else:
            cached = cache.get(key, brand_key) if errors and collector.mode == 'live' else None
            if cached and time.time() - cached[0] < CACHE_MAX_AGE:
                when, items = cached
                found = [{**item, 'cached': True} for item in items]
                status = 'cached'
                message = f"{errors[0]}. Reusing results collected {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(when))}"
                result['cachedAt'] = when
            elif errors:
                status, message = errors[0].status, str(errors[0])
                if errors[0].retry_after:
                    result['retryAfter'] = errors[0].retry_after
            else:
                status, message = 'ok', 'No matching results'
        candidates.extend(found)
        statuses.append({**result, 'status': status, 'message': message, 'count': len(found)})
    pool.shutdown(wait=False, cancel_futures=True)
    order = {c.key: i for i, c in enumerate(ALL_COLLECTORS)}
    statuses.sort(key=lambda s: order.get(s['key'], 99))
    return candidates, statuses
