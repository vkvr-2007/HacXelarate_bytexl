"""API Direct (https://apidirect.io): one third-party search API covering X, Instagram, Facebook and Threads.

These run beside the native platform collectors, never instead of them. Each platform is its own source so its
status and quota are reported separately. API Direct gives 50 free requests per endpoint per month (no card), then
returns 402 until a payment method is added, so each source makes one account-search request per scan, for the
brand's first query only.

Results keep the same `platform` and, where API Direct returns it, the platform's own ID as `externalId`, so a
profile found here and by a native collector dedupes into one finding and official accounts are excluded the same way.
"""
import random
import time

import httpx

from .base import USER_AGENT, Collector, SourceError, env, limiter, timeout

BASE_URL = 'https://apidirect.io'
DOCS = 'https://apidirect.io/docs/introduction'

# Error codes from https://apidirect.io/docs/error-handling, mapped onto base.STATUSES.
QUOTA_CODES = {'payment_required', 'daily_limit_exceeded', 'monthly_limit_exceeded'}
RETRY_CODES = {'concurrency_limit_exceeded', 'upstream_rate_limit', 'upstream_error', 'upstream_connection_error',
               'upstream_timeout', 'service_unavailable'}


def request(path, params, *, source, retries=2):
    """GET an API Direct endpoint. Retries only the codes the docs mark transient; never retries quota or auth errors."""
    attempt = 0
    while True:
        limiter.wait(source, 0.3)
        try:
            response = httpx.request('GET', f'{BASE_URL}{path}', params=params, timeout=timeout(), headers={
                'User-Agent': USER_AGENT, 'X-API-Key': env('APIDIRECT_API_KEY'),
            })
        except httpx.TimeoutException as exc:
            error, cause = SourceError('unavailable', 'API Direct timed out'), exc
        except httpx.HTTPError as exc:
            error, cause = SourceError('unavailable', f'API Direct network error: {exc.__class__.__name__}'), exc
        else:
            if response.status_code < 400:
                try:
                    data = response.json()
                except ValueError as exc:
                    raise SourceError('unavailable', 'API Direct response was not JSON') from exc
                if not isinstance(data, dict):
                    raise SourceError('unavailable', 'API Direct response was not a JSON object')
                return data
            error, cause = _error(response), None
            if error is None:
                raise _fatal(response)
        if attempt >= retries:
            raise error from cause
        time.sleep((2 ** attempt) + random.random())
        attempt += 1


def _code(response):
    try:
        body = response.json()
    except ValueError:
        return ''
    return str(body.get('code', '')) if isinstance(body, dict) else ''


def _error(response):
    """A retryable SourceError for transient failures, or None when the failure is final."""
    code, status = _code(response), response.status_code
    if code in QUOTA_CODES or status in (400, 401, 402, 403):
        return None
    if status == 429 or code in ('concurrency_limit_exceeded', 'upstream_rate_limit'):
        return SourceError('rate_limited', f'API Direct rate limit ({code or "HTTP 429"})')
    if status >= 500 or code in RETRY_CODES:
        return SourceError('unavailable', f'API Direct or the platform behind it failed ({code or f"HTTP {status}"})')
    return None


def _fatal(response):
    code, status = _code(response), response.status_code
    if code == 'payment_required' or status == 402:
        return SourceError('rate_limited', 'API Direct free tier for this endpoint is used up this month (50 requests). '
                                           'It resets on the 1st, or add a payment method in API Direct.')
    if code in ('daily_limit_exceeded', 'monthly_limit_exceeded'):
        return SourceError('rate_limited', f'API Direct spending limit reached ({code})')
    if status in (401, 403) or code in ('missing_api_key', 'invalid_api_key', 'user_not_found', 'account_blocked'):
        return SourceError('auth_failed', f'API Direct refused the key ({code or f"HTTP {status}"}). Check APIDIRECT_API_KEY.')
    return SourceError('unavailable', f'API Direct rejected the request ({code or f"HTTP {status}"})')


def _list(data, field):
    items = data.get(field)
    if items is None:
        return []
    if not isinstance(items, list):
        raise SourceError('unavailable', f'API Direct response had no "{field}" list')
    return [item for item in items if isinstance(item, dict)]


def _followers(value):
    return f'{value:,} followers' if isinstance(value, int) else ''


class ApiDirectCollector(Collector):
    """One API Direct account-search endpoint. Subclasses set the path and map one result."""
    category = 'social'
    env_vars = ('APIDIRECT_API_KEY',)
    docs = DOCS
    cost = 'Free: 50 requests a month per endpoint, no card. Then $0.006 to $0.008 per request.'
    per_query = False            # one request per scan keeps the free tier usable for ~50 scans a month
    path = ''
    field = ''
    platform = ''

    def search(self, query, brand):
        query = (query or brand.get('name') or '').strip()[:500]
        if not query:
            return []
        out = []
        for item in _list(request(self.path, self.params(query), source=self.key), self.field):
            mapped = self.map(item)
            if mapped and mapped.get('externalId'):
                out.append({'type': 'social', 'platform': self.platform, 'provider': 'apidirect', **mapped})
        return out

    def params(self, query):
        return {'query': query}

    def map(self, item):
        raise NotImplementedError


class ApiDirectXCollector(ApiDirectCollector):
    key = 'apidirect_x'
    label = 'X via API Direct'
    platform = 'X'
    path, field = '/v1/twitter/users', 'users'
    docs = 'https://apidirect.io/docs/twitter-users'
    access = 'API Direct key (APIDIRECT_API_KEY). Searches X accounts by keyword; one page per scan.'

    def params(self, query):
        return {'query': query, 'pages': 1}

    def map(self, u):
        username = u.get('username') or ''
        return {
            'name': u.get('name') or username, 'handle': f'@{username}' if username else '',
            'externalId': u.get('user_id') or username, 'description': u.get('description') or '',
            'iconUrl': u.get('profile_image_url') or '', 'url': u.get('url') or (f'https://x.com/{username}' if username else ''),
            'followers': _followers(u.get('followers_count')), 'createdAt': u.get('created_at') or '',
            'raw': {k: u.get(k) for k in ('user_id', 'username', 'verified', 'followers_count', 'tweet_count', 'created_at')},
        }


class ApiDirectInstagramCollector(ApiDirectCollector):
    key = 'apidirect_instagram'
    label = 'Instagram via API Direct'
    platform = 'Instagram'
    path, field = '/v1/instagram/users', 'users'
    docs = 'https://apidirect.io/docs/instagram-users'
    access = 'API Direct key (APIDIRECT_API_KEY). Searches Instagram accounts by keyword. Returns no bio or follower count.'

    def map(self, u):
        username = u.get('username') or ''
        return {
            'name': u.get('full_name') or username, 'handle': f'@{username}' if username else '',
            'externalId': u.get('user_id') or username, 'description': '',
            'iconUrl': u.get('profile_pic_url') or '', 'url': u.get('url') or (f'https://www.instagram.com/{username}/' if username else ''),
            'raw': {k: u.get(k) for k in ('user_id', 'username', 'is_verified', 'is_private', 'is_ai_generated_profile')},
        }


class ApiDirectThreadsCollector(ApiDirectCollector):
    key = 'apidirect_threads'
    label = 'Threads via API Direct'
    platform = 'Threads'
    path, field = '/v1/threads/users', 'users'
    docs = 'https://apidirect.io/docs/threads-users'
    access = 'API Direct key (APIDIRECT_API_KEY). Searches Threads accounts by keyword, up to about 15 per request. No bio.'

    def map(self, u):
        username = u.get('username') or ''
        # Native Threads collector keys accounts by username, so use it here too for dedupe.
        return {
            'name': u.get('full_name') or username, 'handle': f'@{username}' if username else '',
            'externalId': username, 'description': '',
            'iconUrl': u.get('profile_pic_url') or '', 'url': u.get('url') or (f'https://www.threads.net/@{username}' if username else ''),
            'raw': {k: u.get(k) for k in ('user_id', 'username', 'is_verified', 'is_private')},
        }


class ApiDirectFacebookCollector(ApiDirectCollector):
    key = 'apidirect_facebook'
    label = 'Facebook Pages via API Direct'
    platform = 'Facebook'
    path, field = '/v1/facebook/pages', 'results'
    docs = 'https://apidirect.io/docs/facebook-search-pages'
    access = 'API Direct key (APIDIRECT_API_KEY). Searches public Facebook Pages by keyword. No description.'

    def params(self, query):
        return {'query': query, 'pages': 1}

    def map(self, p):
        page_id = p.get('facebook_id') or ''
        return {
            'name': p.get('name') or '', 'handle': page_id, 'externalId': page_id, 'description': '',
            'iconUrl': p.get('image_url') or '', 'url': p.get('url') or p.get('profile_url') or (f'https://www.facebook.com/{page_id}' if page_id else ''),
            'raw': {k: p.get(k) for k in ('facebook_id', 'is_verified', 'profile_url')},
        }


COLLECTORS = [ApiDirectXCollector(), ApiDirectInstagramCollector(), ApiDirectThreadsCollector(), ApiDirectFacebookCollector()]
