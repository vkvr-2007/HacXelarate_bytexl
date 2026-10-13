"""API Direct adapter. Payloads follow the documented schemas at https://apidirect.io/docs; no test reaches the network."""
import httpx
import pytest
from conftest import NORTHSTAR

from brandml import pipeline
from brandml.sources import apidirect, registry
from brandml.sources.base import SourceError

KEY = 'ak_test_not_a_real_key'


def json_response(payload, status=200):
    return httpx.Response(status, json=payload)


@pytest.fixture
def keyed(monkeypatch):
    monkeypatch.setenv('APIDIRECT_API_KEY', KEY)


def test_x_users_are_normalised_with_platform_ids(fake_http, keyed):
    calls = fake_http(lambda m, u, kw: json_response({'users': [{
        'username': 'northstar_help', 'name': 'Northstar Help', 'user_id': '42', 'description': 'DM for refunds',
        'followers_count': 1200, 'verified': False, 'profile_image_url': 'https://pbs.twimg.com/a.jpg',
        'created_at': '2026-09-01 10:00:00', 'url': 'https://twitter.com/northstar_help'}], 'pages': 1, 'count': 1}))
    [user] = apidirect.ApiDirectXCollector().search('Northstar', NORTHSTAR)
    method, url, kw = calls[0]
    assert (method, url) == ('GET', 'https://apidirect.io/v1/twitter/users')
    assert kw['params'] == {'query': 'Northstar', 'pages': 1} and kw['headers']['X-API-Key'] == KEY
    assert user['platform'] == 'X' and user['externalId'] == '42' and user['handle'] == '@northstar_help'
    assert user['followers'] == '1,200 followers' and user['provider'] == 'apidirect' and user['url'].endswith('northstar_help')


def test_instagram_threads_and_facebook_parsers(fake_http, keyed):
    payloads = {
        '/v1/instagram/users': {'users': [{'username': 'northstar.support', 'full_name': 'Northstar Support', 'user_id': '77',
                                           'is_verified': False, 'is_private': False, 'profile_pic_url': 'https://cdn/p.jpg',
                                           'url': 'https://instagram.com/northstar.support'}], 'count': 1},
        '/v1/threads/users': {'users': [{'username': 'northstar.refunds', 'full_name': '', 'user_id': '88',
                                         'url': 'https://www.threads.com/@northstar.refunds'}], 'count': 1},
        '/v1/facebook/pages': {'results': [{'name': 'Northstar Help Center', 'facebook_id': '555', 'url': 'https://www.facebook.com/nshelp',
                                            'is_verified': False}], 'count': 1, 'pages': 1},
    }
    fake_http(lambda m, u, kw: json_response(payloads[u.replace(apidirect.BASE_URL, '')]))
    [ig] = apidirect.ApiDirectInstagramCollector().search('Northstar', NORTHSTAR)
    [th] = apidirect.ApiDirectThreadsCollector().search('Northstar', NORTHSTAR)
    [fb] = apidirect.ApiDirectFacebookCollector().search('Northstar', NORTHSTAR)
    assert (ig['platform'], ig['externalId'], ig['handle']) == ('Instagram', '77', '@northstar.support')
    assert (th['platform'], th['externalId'], th['name']) == ('Threads', 'northstar.refunds', 'northstar.refunds')
    assert (fb['platform'], fb['externalId'], fb['url']) == ('Facebook', '555', 'https://www.facebook.com/nshelp')


def test_missing_fields_and_items_without_ids_are_dropped(fake_http, keyed):
    fake_http(lambda m, u, kw: json_response({'users': [{'username': ''}, 'junk', {'username': 'ok_one'}]}))
    [only] = apidirect.ApiDirectXCollector().search('Northstar', NORTHSTAR)
    assert only['externalId'] == 'ok_one' and only['followers'] == '' and only['createdAt'] == ''


def test_empty_result_is_not_an_error(fake_http, keyed):
    fake_http(lambda m, u, kw: json_response({'users': [], 'count': 0}))
    assert apidirect.ApiDirectInstagramCollector().search('Northstar', NORTHSTAR) == []


@pytest.mark.parametrize('payload', [{'users': 'nope'}, ['a', 'list']])
def test_malformed_response_is_reported(fake_http, keyed, payload):
    fake_http(lambda m, u, kw: json_response(payload))
    with pytest.raises(SourceError) as err:
        apidirect.ApiDirectXCollector().search('Northstar', NORTHSTAR)
    assert err.value.status == 'unavailable'


def test_non_json_response_is_reported(fake_http, keyed):
    fake_http(lambda m, u, kw: httpx.Response(200, text='<html>'))
    with pytest.raises(SourceError) as err:
        apidirect.ApiDirectXCollector().search('Northstar', NORTHSTAR)
    assert err.value.status == 'unavailable'


@pytest.mark.parametrize('status,code,expected', [
    (402, 'payment_required', 'rate_limited'),
    (429, 'monthly_limit_exceeded', 'rate_limited'),
    (429, 'daily_limit_exceeded', 'rate_limited'),
    (401, 'invalid_api_key', 'auth_failed'),
    (401, 'missing_api_key', 'auth_failed'),
    (403, 'account_blocked', 'auth_failed'),
    (400, 'invalid_parameter', 'unavailable'),
])
def test_final_errors_are_not_retried(fake_http, keyed, status, code, expected):
    calls = fake_http(lambda m, u, kw: json_response({'error': 'x', 'code': code}, status))
    with pytest.raises(SourceError) as err:
        apidirect.ApiDirectXCollector().search('Northstar', NORTHSTAR)
    assert err.value.status == expected and len(calls) == 1


def test_quota_message_explains_the_free_tier(fake_http, keyed):
    fake_http(lambda m, u, kw: json_response({'error': 'x', 'code': 'payment_required'}, 402))
    with pytest.raises(SourceError) as err:
        apidirect.ApiDirectFacebookCollector().search('Northstar', NORTHSTAR)
    assert 'free tier' in str(err.value)


@pytest.mark.parametrize('status,code,expected', [
    (429, 'concurrency_limit_exceeded', 'rate_limited'),
    (429, 'upstream_rate_limit', 'rate_limited'),
    (502, 'upstream_error', 'unavailable'),
    (504, 'upstream_timeout', 'unavailable'),
    (503, 'service_unavailable', 'unavailable'),
])
def test_transient_errors_retry_then_give_up(fake_http, keyed, status, code, expected):
    calls = fake_http(lambda m, u, kw: json_response({'error': 'x', 'code': code}, status))
    with pytest.raises(SourceError) as err:
        apidirect.ApiDirectXCollector().search('Northstar', NORTHSTAR)
    assert err.value.status == expected and len(calls) == 3


def test_transient_error_then_success(fake_http, keyed):
    responses = iter([json_response({'code': 'upstream_timeout'}, 504), json_response({'users': [{'username': 'a', 'user_id': '1'}]})])
    calls = fake_http(lambda m, u, kw: next(responses))
    assert len(apidirect.ApiDirectXCollector().search('Northstar', NORTHSTAR)) == 1 and len(calls) == 2


def test_timeout_is_reported(monkeypatch, keyed):
    def slow(*a, **k):
        raise httpx.ReadTimeout('slow')
    monkeypatch.setattr(httpx, 'request', slow)
    with pytest.raises(SourceError) as err:
        apidirect.ApiDirectXCollector().search('Northstar', NORTHSTAR)
    assert err.value.status == 'unavailable' and 'timed out' in str(err.value)


def test_errors_never_contain_the_key(fake_http, keyed):
    for status, code in ((401, 'invalid_api_key'), (402, 'payment_required'), (502, 'upstream_error'), (418, '')):
        fake_http(lambda m, u, kw, s=status, c=code: json_response({'error': f'bad key {KEY}', 'code': c}, s))
        with pytest.raises(SourceError) as err:
            apidirect.ApiDirectXCollector().search('Northstar', NORTHSTAR)
        assert KEY not in str(err.value)


def test_without_a_key_every_api_direct_source_is_not_configured(monkeypatch):
    monkeypatch.delenv('APIDIRECT_API_KEY', raising=False)
    keys = {c.key for c in apidirect.COLLECTORS}
    _, sts = registry.run_collectors(NORTHSTAR, ['Northstar'], mode='live', enabled=keys)
    for s in sts:
        if s['key'] in keys:
            assert s['status'] == 'not_configured' and 'APIDIRECT_API_KEY' in s['message']


def test_one_request_per_scan_and_failure_does_not_stop_other_sources(fake_http, keyed, monkeypatch):
    def handler(method, url, kw):
        if 'twitter' in url:
            return json_response({'code': 'payment_required'}, 402)
        return json_response({'users': [{'username': 'northstar.help', 'user_id': '9'}]})
    calls = fake_http(handler)
    found, sts = registry.run_collectors(NORTHSTAR, ['Northstar', 'Northstar support', 'Northstar app'], mode='live',
                                         enabled={'apidirect_x', 'apidirect_instagram'}, cache=registry.MemoryCache())
    s = {x['key']: x for x in sts}
    assert s['apidirect_x']['status'] == 'rate_limited' and s['apidirect_instagram']['status'] == 'ok'
    assert len(calls) == 2 and found[0]['source'] == 'apidirect_instagram'


def test_demo_brands_never_call_api_direct(fake_http, keyed):
    calls = fake_http(lambda m, u, kw: json_response({'users': []}))
    _, sts = registry.run_collectors(NORTHSTAR, ['Northstar'], mode='demo')
    assert not calls and all(s['status'] == 'disabled' for s in sts if s['key'].startswith('apidirect_'))


def test_official_account_found_via_api_direct_is_excluded(fake_http, keyed):
    fake_http(lambda m, u, kw: json_response({'users': [{'username': 'northstarhq', 'user_id': '1'}]}))
    [user] = apidirect.ApiDirectXCollector().search('Northstar', NORTHSTAR)
    assert pipeline.Engine.official_match(NORTHSTAR, user)
