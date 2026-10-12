import pytest
from conftest import NORTHSTAR
from fastapi.testclient import TestClient

import service


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv('ML_SERVICE_SECRET', 'ml-secret')
    monkeypatch.setenv('WORKER_SECRET', 'worker-secret')
    monkeypatch.delenv('CRON_SECRET', raising=False)
    return TestClient(service.app)


def auth(token):
    return {'Authorization': f'Bearer {token}'}


def test_health_is_status_only_without_the_secret(client):
    assert client.get('/health').json() == {'status': 'ok'}
    assert client.get('/health', headers=auth('wrong')).json() == {'status': 'ok'}


def test_health_details_need_the_secret(client):
    body = client.get('/health', headers=auth('ml-secret')).json()
    assert {'tiktok', 'web_search', 'domains_dns'} <= {s['key'] for s in body['sources']}
    assert 'northstar' in body['demoBrands'] and body['model']


def test_production_without_a_secret_fails_closed(monkeypatch):
    monkeypatch.delenv('ML_SERVICE_SECRET', raising=False)
    monkeypatch.setenv('VERCEL', '1')
    c = TestClient(service.app)
    assert c.post('/score', json={'brand': {'name': 'x'}, 'candidate': {}}).status_code == 503
    assert c.get('/health').json() == {'status': 'ok'}


def test_local_development_without_a_secret_still_works(monkeypatch):
    monkeypatch.delenv('ML_SERVICE_SECRET', raising=False)
    for var in ('VERCEL', 'NODE_ENV', 'ENVIRONMENT'):
        monkeypatch.delenv(var, raising=False)
    assert 'model' in TestClient(service.app).get('/health').json()


@pytest.mark.parametrize('path', ['/scan', '/score', '/lookalike', '/validate', '/retrain'])
def test_internal_endpoints_need_the_service_secret(client, path):
    assert client.post(path, json={}).status_code == 401
    assert client.post(path, json={}, headers=auth('wrong')).status_code == 401


def test_worker_endpoint_needs_the_worker_secret(client, monkeypatch):
    assert client.post('/internal/run').status_code == 401
    assert client.post('/internal/run', headers=auth('ml-secret')).status_code == 401
    monkeypatch.delenv('WORKER_SECRET')
    assert client.post('/internal/run', headers=auth('anything')).status_code == 503


def test_demo_scan_over_http(client):
    response = client.post('/scan', json={'brand': NORTHSTAR, 'mode': 'demo'}, headers=auth('ml-secret'))
    assert response.status_code == 200 and response.json()['evaluation']['recall'] >= 0.9


def test_requests_are_validated(client):
    assert client.post('/scan', json={'brand': NORTHSTAR, 'mode': 'mixed'}, headers=auth('ml-secret')).status_code == 422
    assert client.post('/scan', json={'brand': {'name': ''}}, headers=auth('ml-secret')).status_code == 422
    too_many = {'brand': NORTHSTAR, 'names': ['x'] * 51}
    assert client.post('/lookalike', json=too_many, headers=auth('ml-secret')).status_code == 422


def test_lookalike_scores_domains(client):
    body = client.post('/lookalike', json={'brand': NORTHSTAR, 'names': ['n0rthstar-login.com', 'gardenbakery.com'], 'type': 'domain'}, headers=auth('ml-secret')).json()
    scores = {r['name']: r['score'] for r in body['results']}
    assert scores['n0rthstar-login.com'] > scores['gardenbakery.com']


def test_retrain_is_refused_on_vercel(client, monkeypatch):
    monkeypatch.setenv('VERCEL', '1')
    assert client.post('/retrain', headers=auth('ml-secret')).status_code == 409


def test_verify_domain_endpoint_needs_the_secret_and_reports_the_proof(client, monkeypatch):
    monkeypatch.setattr(service.domain_proof, 'check', lambda domain, token: {'verified': True, 'method': 'dns_txt', 'detail': f'{domain}/{token}'})
    body = {'domain': 'acme.com', 'token': 't'}
    assert client.post('/verify-domain', json=body).status_code == 401
    assert client.post('/verify-domain', json=body, headers=auth('ml-secret')).json()['detail'] == 'acme.com/t'


def test_scan_with_an_empty_source_list_is_refused_not_widened(client):
    response = client.post('/scan', json={'brand': NORTHSTAR, 'mode': 'demo', 'sources': []}, headers=auth('ml-secret'))
    assert response.status_code == 400


def test_suggested_profile_items_are_marked_as_guesses(client, monkeypatch):
    found = [{'type': 'app', 'platform': 'Google Play', 'name': 'Acme Pay', 'appId': 'com.acme', 'publisher': 'Acme Pay Inc', 'iconUrl': None},
             {'type': 'social', 'platform': 'Bluesky', 'handle': '@acmepay.bsky.social'}]
    monkeypatch.setattr(service.registry, 'run_collectors', lambda *a, **k: (found, []))
    body = client.get('/suggest-profile', params={'name': 'Acme Pay'}, headers=auth('ml-secret')).json()
    assert [x['trust'] for x in body['officialApps'] + body['officialSocials']] == ['suggested', 'suggested']


def test_env_file_ignores_trailing_comments_and_quotes(tmp_path, monkeypatch):
    from brandml.envfile import load_env, parse
    parsed = parse('A=   # optional\nB=value # note\nC="a # b"\nexport D=1\n# E=2\nbad line\nF=\n')
    assert parsed == {'A': '', 'B': 'value', 'C': 'a # b', 'D': '1', 'F': ''}
    env = tmp_path / '.env'
    env.write_text('SG_TEST_X=   # optional\nSG_TEST_Y=real\n')
    monkeypatch.setenv('SG_TEST_Y', 'kept')
    monkeypatch.delenv('SG_TEST_X', raising=False)
    load_env(env)
    import os
    assert os.environ['SG_TEST_X'] == '' and os.environ['SG_TEST_Y'] == 'kept'
    monkeypatch.delenv('SG_TEST_X', raising=False)
