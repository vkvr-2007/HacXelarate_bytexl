import httpx
import pytest
from conftest import NORTHSTAR

from brandml.sources import appstores, base, domains, registry, social, web
from brandml.sources.base import SourceError, api_request


def json_response(payload, status=200, headers=None):
    return httpx.Response(status, json=payload, headers=headers)


# ---------- the HTTP helper ----------

def test_api_request_retries_rate_limits_then_succeeds(fake_http):
    responses = iter([json_response({}, 429, {'retry-after': '2'}), json_response({}, 503), json_response({'ok': True})])
    calls = fake_http(lambda m, u, kw: next(responses))
    assert api_request('GET', 'https://api.example.test/x', source='t', retries=2) == {'ok': True}
    assert len(calls) == 3


def test_api_request_gives_up_after_retries(fake_http):
    fake_http(lambda m, u, kw: json_response({}, 429))
    with pytest.raises(SourceError) as err:
        api_request('GET', 'https://api.example.test/x', source='t', retries=1)
    assert err.value.status == 'rate_limited'


def test_api_request_does_not_wait_out_long_retry_after(fake_http):
    calls = fake_http(lambda m, u, kw: json_response({}, 429, {'retry-after': '3600'}))
    with pytest.raises(SourceError) as err:
        api_request('GET', 'https://api.example.test/x', source='t', retries=3)
    assert err.value.retry_after == 3600 and len(calls) == 1


@pytest.mark.parametrize('status', [401, 403])
def test_api_request_reports_auth_failures_without_retrying(fake_http, status):
    calls = fake_http(lambda m, u, kw: json_response({'error': 'bad token'}, status))
    with pytest.raises(SourceError) as err:
        api_request('GET', 'https://api.example.test/x', source='t')
    assert err.value.status == 'auth_failed' and len(calls) == 1


def test_api_request_never_logs_secrets_in_errors(fake_http):
    fake_http(lambda m, u, kw: json_response({}, 401))
    with pytest.raises(SourceError) as err:
        api_request('GET', 'https://api.example.test/x', source='t', params={'key': 'sk-secret-value'})
    assert 'sk-secret-value' not in str(err.value)


# ---------- parsers (mocked platform responses) ----------

def test_app_store_parser(fake_http):
    fake_http(lambda m, u, kw: json_response({'results': [{
        'trackName': 'Northstar Wallet', 'trackId': 123456789, 'bundleId': 'com.x.wallet', 'sellerName': 'X Labs',
        'description': 'Send money', 'artworkUrl512': 'https://is1.mzstatic.com/i.png', 'trackViewUrl': 'https://apps.apple.com/app/id123456789',
        'userRatingCount': 12, 'releaseDate': '2026-09-01T00:00:00Z'}]}))
    [app] = appstores.AppStoreCollector().search('Northstar', NORTHSTAR)
    assert app['appId'] == 'id123456789' and app['publisher'] == 'X Labs' and app['raw']['releaseDate'].startswith('2026')


def test_google_play_parser(monkeypatch):
    import google_play_scraper
    monkeypatch.setattr(google_play_scraper, 'search', lambda *a, **k: [{'appId': 'com.northstar.rewards', 'title': 'Northstar Rewards', 'developer': 'Apex Labs', 'icon': 'https://play-lh.googleusercontent.com/x', 'installs': '1,000+'}])
    [app] = appstores.GooglePlayCollector().search('Northstar', NORTHSTAR)
    assert app['externalId'] == 'com.northstar.rewards' and app['url'].endswith('id=com.northstar.rewards')


def test_google_play_failure_is_reported(monkeypatch):
    import google_play_scraper

    def boom(*a, **k):
        raise RuntimeError('blocked')
    monkeypatch.setattr(google_play_scraper, 'search', boom)
    with pytest.raises(SourceError) as err:
        appstores.GooglePlayCollector().search('Northstar', NORTHSTAR)
    assert err.value.status == 'unavailable'


def test_bluesky_parser(fake_http):
    fake_http(lambda m, u, kw: json_response({'actors': [{'did': 'did:plc:abc', 'handle': 'northstar-help.bsky.social', 'displayName': 'Northstar Help', 'description': 'DM us'}]}))
    [acct] = social.BlueskyCollector().search('Northstar', NORTHSTAR)
    assert acct['handle'] == '@northstar-help.bsky.social' and acct['externalId'] == 'did:plc:abc'


def test_mastodon_parser_strips_html(fake_http):
    fake_http(lambda m, u, kw: json_response({'accounts': [{'acct': 'northstar@evil.example', 'display_name': 'Northstar', 'note': '<p>Refunds <b>here</b></p>', 'url': 'https://evil.example/@northstar'}]}))
    [acct] = social.MastodonCollector().search('Northstar', NORTHSTAR)
    assert acct['description'] == 'Refunds  here' and acct['url'] == 'https://evil.example/@northstar'


def test_youtube_parser(fake_http, monkeypatch):
    monkeypatch.setenv('YOUTUBE_API_KEY', 'test-key')
    calls = fake_http(lambda m, u, kw: json_response({'items': [{'id': {'channelId': 'UC123'}, 'snippet': {'channelTitle': 'Northstar Support', 'description': 'Help'}}]}))
    [channel] = social.YouTubeCollector().search('Northstar', NORTHSTAR)
    assert channel['externalId'] == 'UC123' and calls[0][2]['params']['key'] == 'test-key'


def test_reddit_gets_a_token_then_searches(fake_http, monkeypatch):
    monkeypatch.setenv('REDDIT_CLIENT_ID', 'id')
    monkeypatch.setenv('REDDIT_CLIENT_SECRET', 'secret')
    monkeypatch.setattr(social.RedditCollector, '_token', (None, 0.0))

    def handler(method, url, kw):
        if url.endswith('/access_token'):
            assert kw['auth'] == ('id', 'secret')
            return json_response({'access_token': 'tok', 'expires_in': 3600})
        assert kw['headers']['Authorization'] == 'Bearer tok'
        if 'subreddits' in url:
            return json_response({'data': {'children': [{'data': {'display_name': 'NorthstarRefunds', 'title': 'Northstar refunds', 'url': '/r/NorthstarRefunds/'}}]}})
        return json_response({'data': {'children': [{'data': {'name': 'northstar_support', 'subreddit': {'title': 'Northstar Support'}}}]}})
    fake_http(handler)
    found = social.RedditCollector().search('Northstar', NORTHSTAR)
    assert {f['handle'] for f in found} == {'r/NorthstarRefunds', 'u/northstar_support'}


def test_x_looks_up_generated_handles(fake_http, monkeypatch):
    monkeypatch.setenv('X_BEARER_TOKEN', 'bearer')
    monkeypatch.setenv('X_MAX_LOOKUPS', '10')
    calls = fake_http(lambda m, u, kw: json_response({'data': [{'id': '42', 'username': 'northstar_support', 'name': 'Northstar Support', 'public_metrics': {'followers_count': 7}}]}))
    [user] = social.XCollector().search('', NORTHSTAR)
    usernames = calls[0][2]['params']['usernames'].split(',')
    assert len(usernames) <= 10 and 'northstarhq' not in usernames  # official handle is never looked up
    assert user['externalId'] == '42' and user['followers'] == '7 followers'


def test_instagram_skips_missing_accounts_but_stops_on_auth_failure(fake_http, monkeypatch):
    monkeypatch.setenv('INSTAGRAM_ACCESS_TOKEN', 'tok')
    monkeypatch.setenv('INSTAGRAM_BUSINESS_ACCOUNT_ID', '1784')
    monkeypatch.setenv('INSTAGRAM_MAX_LOOKUPS', '3')
    seen = []

    def handler(method, url, kw):
        seen.append(kw['params']['fields'])
        if len(seen) == 2:
            return json_response({'business_discovery': {'id': '9', 'username': 'northstarsupport', 'biography': 'DM for refunds'}})
        return json_response({'error': {'message': 'Invalid user id'}}, 400)
    fake_http(handler)
    [user] = social.InstagramCollector().search('', NORTHSTAR)
    assert user['handle'] == '@northstarsupport' and len(seen) == 3

    fake_http(lambda m, u, kw: json_response({}, 403))
    with pytest.raises(SourceError) as err:
        social.InstagramCollector().search('', NORTHSTAR)
    assert err.value.status == 'auth_failed'


def test_threads_groups_posts_by_author(fake_http, monkeypatch):
    monkeypatch.setenv('THREADS_ACCESS_TOKEN', 'tok')
    fake_http(lambda m, u, kw: json_response({'data': [
        {'id': '1', 'username': 'northstar.refunds', 'text': 'Claim your Northstar refund', 'permalink': 'https://threads.net/p/1'},
        {'id': '2', 'username': 'northstar.refunds', 'text': 'again'}]}))
    [acct] = social.ThreadsCollector().search('Northstar', NORTHSTAR)
    assert acct['postUrl'] == 'https://threads.net/p/1'


def test_facebook_pages_parser(fake_http, monkeypatch):
    monkeypatch.setenv('FACEBOOK_ACCESS_TOKEN', 'tok')
    fake_http(lambda m, u, kw: json_response({'data': [{'id': '555', 'name': 'Northstar Help Center', 'link': 'https://facebook.com/555'}]}))
    [page] = social.FacebookPagesCollector().search('Northstar', NORTHSTAR)
    assert page['externalId'] == '555'


@pytest.mark.parametrize('provider,var', [('brave', 'BRAVE_SEARCH_API_KEY'), ('serpapi', 'SERPAPI_API_KEY')])
def test_web_search_excludes_official_domains(fake_http, monkeypatch, provider, var):
    monkeypatch.setenv('WEB_SEARCH_PROVIDER', provider)
    monkeypatch.setenv(var, 'key')
    monkeypatch.setenv('WEB_SEARCH_MAX_QUERIES', '1')
    rows = [('https://northstar.com/login', 'Northstar'), ('https://help.northstar.com/x', 'Help'), ('https://northstar-verify.top/login', 'Northstar Login')]
    if provider == 'brave':
        payload = {'web': {'results': [{'url': u, 'title': t, 'description': ''} for u, t in rows]}}
    else:
        payload = {'organic_results': [{'link': u, 'title': t, 'snippet': ''} for u, t in rows]}
    fake_http(lambda m, u, kw: json_response(payload))
    found = web.WebSearchCollector().search('', NORTHSTAR)
    assert [f['handle'] for f in found] == ['northstar-verify.top']


def test_web_search_without_a_key_is_not_configured(monkeypatch):
    for var in ('WEB_SEARCH_PROVIDER', 'BRAVE_SEARCH_API_KEY', 'SERPAPI_API_KEY'):
        monkeypatch.delenv(var, raising=False)
    collector = web.WebSearchCollector()
    assert not collector.configured() and collector.missing() == ['BRAVE_SEARCH_API_KEY or SERPAPI_API_KEY']


def test_lookalike_domains_report_only_registered_names(monkeypatch):
    registered = {'northstar-login.com': {'a': ['203.0.113.7'], 'mx': ['mx.evil.example'], 'ns': []}}
    monkeypatch.setattr(domains, 'resolve', lambda d, lifetime=3.0: registered.get(d) or ({'a': ['1.1.1.1'], 'mx': [], 'ns': []} if d == 'northstar.com' else None))
    found = domains.LookalikeDomainCollector().search('', NORTHSTAR)
    assert [f['name'] for f in found] == ['northstar-login.com'] and found[0]['dns']['mx']


def test_lookalike_domains_detect_broken_dns(monkeypatch):
    monkeypatch.setattr(domains, 'resolve', lambda d, lifetime=3.0: None)
    with pytest.raises(SourceError) as err:
        domains.LookalikeDomainCollector().search('', NORTHSTAR)
    assert err.value.status == 'unavailable'


def test_certificate_transparency_parser(fake_http):
    fake_http(lambda m, u, kw: json_response([
        {'id': 1, 'name_value': '*.northstar-secure.net\nnorthstar-secure.net', 'issuer_name': "C=US, O=Let's Encrypt", 'not_before': '2026-10-01T00:00:00'},
        {'id': 2, 'name_value': 'www.northstar.com', 'issuer_name': 'x', 'not_before': '2026-01-01T00:00:00'}]))
    found = domains.CertTransparencyCollector().search('', NORTHSTAR)
    assert [f['name'] for f in found] == ['northstar-secure.net']


# ---------- the runner ----------

def statuses(result):
    return {s['key']: s for s in result[1]}


def test_unsupported_and_unconfigured_sources_are_reported_honestly(monkeypatch):
    for var in ('X_BEARER_TOKEN', 'YOUTUBE_API_KEY'):
        monkeypatch.delenv(var, raising=False)
    s = statuses(registry.run_collectors(NORTHSTAR, ['Northstar'], mode='live', enabled={'tiktok', 'x', 'youtube'}))
    assert s['tiktok']['status'] == 'unsupported' and 'Research API' in s['tiktok']['message']
    assert s['x']['status'] == 'not_configured' and 'X_BEARER_TOKEN' in s['x']['message']
    assert s['youtube']['status'] == 'not_configured'
    assert s['bluesky']['status'] == 'disabled'


def test_cached_results_are_reused_and_labelled(monkeypatch):
    calls = {'n': 0}

    def flaky(self, query, brand):
        calls['n'] += 1
        if calls['n'] > 1:
            raise SourceError('unavailable', 'Timed out')
        return [{'type': 'social', 'platform': 'Bluesky', 'name': 'Northstar Help', 'handle': '@ns-help.bsky.social', 'externalId': 'did:plc:1'}]

    monkeypatch.setattr(social.BlueskyCollector, 'search', flaky)
    cache = registry.MemoryCache()
    registry.run_collectors(NORTHSTAR, ['Northstar'], enabled={'bluesky'}, cache=cache, max_queries=1)
    found, sts = registry.run_collectors(NORTHSTAR, ['Northstar'], enabled={'bluesky'}, cache=cache, max_queries=1)
    assert {s['key']: s for s in sts}['bluesky']['status'] == 'cached'
    assert found and found[0]['cached'] is True


def test_partial_results_when_some_queries_fail(monkeypatch):
    def half(self, query, brand):
        if query == 'bad':
            raise SourceError('rate_limited', 'Rate limited')
        return [{'type': 'social', 'platform': 'Bluesky', 'name': query, 'handle': f'@{query}', 'externalId': query}]

    monkeypatch.setattr(social.BlueskyCollector, 'search', half)
    found, sts = registry.run_collectors(NORTHSTAR, ['good', 'bad'], enabled={'bluesky'}, cache=registry.MemoryCache(), max_queries=2)
    assert {s['key']: s for s in sts}['bluesky']['status'] == 'partial' and len(found) == 1


def test_a_crashing_source_does_not_break_the_scan(monkeypatch):
    def crash(self, query, brand):
        raise KeyError('unexpected payload')
    monkeypatch.setattr(appstores.AppStoreCollector, 'search', crash)
    found, sts = registry.run_collectors(NORTHSTAR, ['Northstar'], mode='demo', enabled=None)
    assert found  # demo still ran
    found, sts = registry.run_collectors(NORTHSTAR, ['Northstar'], enabled={'app_store'}, cache=registry.MemoryCache())
    assert {s['key']: s for s in sts}['app_store']['status'] == 'unavailable'


def test_unknown_mode_is_rejected():
    with pytest.raises(ValueError):
        registry.run_collectors(NORTHSTAR, ['x'], mode='mixed')


def test_every_source_documents_its_access():
    for info in registry.describe_all():
        assert info['access'] and info['label'], info['key']
        if info['support'] != 'unsupported' and info['mode'] == 'live':
            assert info['docs'].startswith('https://'), info['key']


def test_demo_brand_without_dataset_is_not_faked():
    found, sts = registry.run_collectors({'name': 'Acme'}, ['Acme'], mode='demo')
    assert found == [] and {s['key']: s for s in sts}['demo']['status'] == 'not_configured'


assert base.STATUSES  # imported for its side effect on the namespace


def test_check_sources_reports_each_live_source_and_fails_on_real_problems(monkeypatch, capsys):
    import check_sources
    rows = [{'key': 'bluesky', 'label': 'Bluesky', 'mode': 'live', 'status': 'ok', 'count': 3, 'latencyMs': 120, 'message': '3 results'},
            {'key': 'x', 'label': 'X', 'mode': 'live', 'status': 'not_configured', 'count': 0, 'latencyMs': None, 'message': 'Needs X_BEARER_TOKEN'},
            {'key': 'demo', 'label': 'Demo', 'mode': 'demo', 'status': 'disabled', 'count': 0, 'message': ''}]
    monkeypatch.setattr(check_sources.registry, 'run_collectors', lambda *a, **k: ([], rows))
    assert check_sources.main(['check_sources.py']) == 0          # a missing key is not a failure
    assert 'Demo' not in capsys.readouterr().out                    # demo source is not a live source
    rows[0]['status'] = 'unavailable'
    assert check_sources.main(['check_sources.py']) == 1
    assert 'Problems: Bluesky' in capsys.readouterr().out
