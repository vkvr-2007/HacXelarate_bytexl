import socket

import httpx
import pytest
from conftest import NORTHSTAR

from brandml import safe_http, web_risk

PUBLIC = {'northstar-login.com': '203.0.113.10', 'evil.example': '198.51.100.20', 'redirector.example': '198.51.100.21',
          'rebind.example': '10.0.0.5', 'northstar.com': '93.184.215.14'}


@pytest.fixture
def dns(monkeypatch):
    # TEST-NET addresses are not "global" in ipaddress, so pretend these hosts resolve to a real public address
    def getaddrinfo(host, *args, **kwargs):
        if host not in PUBLIC:
            raise socket.gaierror('unknown host')
        ip = PUBLIC[host]
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (ip, 0))]
    monkeypatch.setattr(socket, 'getaddrinfo', getaddrinfo)
    real = safe_http._is_public
    monkeypatch.setattr(safe_http, '_is_public', lambda ip: ip.startswith(('203.0.113.', '198.51.100.', '93.184.')) or real(ip))


@pytest.fixture
def site(monkeypatch):
    """Serve fake pages through httpx.MockTransport inside safe_http.fetch."""
    pages = {}
    real_client = httpx.Client

    def handler(request):
        key = f"{request.headers['host'].split(':')[0]}{request.url.path}"
        status, headers, body = pages.get(key, (404, {}, ''))
        return httpx.Response(status, headers=headers, text=body)

    monkeypatch.setattr(safe_http.httpx, 'Client', lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    safe_http._robots.clear()
    return pages


# ---------- SSRF protection ----------

@pytest.mark.parametrize('url', [
    'file:///etc/passwd', 'gopher://evil.example/', 'ftp://evil.example/',
    'http://127.0.0.1/', 'http://localhost/', 'http://10.1.2.3/', 'http://192.168.0.1/', 'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://0.0.0.0/', 'http://metadata.google.internal/',
    'http://evil.example:22/', 'http://user:pass@evil.example/', 'http://rebind.example/', 'http://no-such-host.example/',
])
def test_unsafe_urls_are_refused(dns, url):
    with pytest.raises(safe_http.UnsafeURLError):
        safe_http.validate_url(url)


def test_public_url_is_allowed(dns):
    parts, ips = safe_http.validate_url('https://evil.example/login')
    assert parts.hostname == 'evil.example' and ips == ['198.51.100.20']


def test_redirect_to_private_address_is_refused(dns, site):
    site['redirector.example/robots.txt'] = (404, {}, '')
    site['redirector.example/'] = (302, {'location': 'http://169.254.169.254/latest/meta-data/'}, '')
    with pytest.raises(safe_http.UnsafeURLError):
        safe_http.fetch('http://redirector.example/')


def test_redirect_loops_are_capped(dns, site):
    site['redirector.example/robots.txt'] = (404, {}, '')
    site['redirector.example/'] = (302, {'location': '/'}, '')
    with pytest.raises(safe_http.UnsafeURLError, match='Too many redirects'):
        safe_http.fetch('http://redirector.example/')


def test_robots_txt_is_honoured(dns, site):
    site['evil.example/robots.txt'] = (200, {}, 'User-agent: *\nDisallow: /')
    site['evil.example/'] = (200, {'content-type': 'text/html'}, '<title>x</title>')
    with pytest.raises(safe_http.RobotsDisallowed):
        safe_http.fetch('https://evil.example/')


def test_body_size_is_capped(dns, site):
    site['evil.example/robots.txt'] = (404, {}, '')
    site['evil.example/big'] = (200, {'content-type': 'text/html'}, 'x' * 50_000)
    assert len(safe_http.fetch('https://evil.example/big', max_bytes=1000).body) == 1000


# ---------- page analysis and scoring ----------

PHISH = '''<html><head><title>Northstar | Sign in</title><meta name="description" content="Verify your account to restore access">
<link rel="icon" href="/fav.png"></head><body><form action="https://collect.evil.example/p"><input name="u"><input type="password" name="p"></form>
Your account is suspended. Northstar security alert.</body></html>'''


def test_analyze_html_finds_phishing_indicators():
    page = web_risk.analyze_html(PHISH, 'https://northstar-login.com/', NORTHSTAR)
    assert page['brandInTitle'] and page['passwordFields'] == 1
    assert page['offsiteFormActions'] == ['https://collect.evil.example/p']
    assert 'security alert' in page['phishingPhrases'] and page['iconUrl'] == 'https://northstar-login.com/fav.png'


def test_analyze_html_survives_garbage():
    page = web_risk.analyze_html('<<<<not html', 'https://x.example/', NORTHSTAR)
    assert page['passwordFields'] == 0


def test_inspect_fetches_and_scores_a_phishing_page(dns, site):
    site['northstar-login.com/robots.txt'] = (404, {}, '')
    site['northstar-login.com/'] = (200, {'content-type': 'text/html; charset=utf-8'}, PHISH)
    page = web_risk.inspect('https://northstar-login.com/', NORTHSTAR)
    assert page['fetched'] and page['passwordFields'] == 1
    cand = {'type': 'domain', 'dns': {'a': ['203.0.113.10'], 'mx': ['mx.evil.example']}, 'page': page}
    score, factors = web_risk.score(cand, 0.8)
    assert score >= 85 and any('password' in f['factor'] for f in factors)
    assert web_risk.category(cand) == 'Phishing / credential harvesting site'


def test_inspect_records_why_a_page_was_not_fetched(dns):
    assert web_risk.inspect('http://10.0.0.1/', NORTHSTAR)['reason'].startswith('Blocked by SSRF protection')


def test_defensive_registration_is_scored_down():
    cand = {'type': 'domain', 'dns': {'a': ['1.2.3.4']}, 'page': {'fetched': True, 'redirectsToOfficial': True}}
    score, _ = web_risk.score(cand, 0.9)
    assert score < 40 and web_risk.category(cand).startswith('Defensive registration')


def test_parked_domain_is_lower_risk_than_phishing():
    parked, _ = web_risk.score({'dns': {'a': ['x']}, 'page': {'fetched': True, 'parked': True}}, 0.7)
    phishing, _ = web_risk.score({'dns': {'a': ['x']}, 'page': {'fetched': True, 'passwordFields': 1, 'brandInTitle': True}}, 0.7)
    assert parked < phishing


def test_domain_findings_are_explained_by_the_engine(engine, monkeypatch):
    monkeypatch.setenv('PAGE_CHECKS', 'off')
    cand = {'type': 'domain', 'platform': 'Domain', 'name': 'n0rthstar-support.com', 'handle': 'n0rthstar-support.com', 'externalId': 'n0rthstar-support.com',
            'url': 'https://n0rthstar-support.com', 'dns': {'a': ['203.0.113.1'], 'mx': ['mx.example']}}
    result = engine.score(NORTHSTAR, cand)
    assert result['scoring'] == 'model+rules' and result['score'] >= 55
    assert sum(f['points'] for f in result['factors']) >= result['score']


def test_official_domains_are_excluded(engine):
    assert engine.official_match(NORTHSTAR, {'type': 'web', 'url': 'https://help.northstar.com/x'})
    assert engine.official_match(NORTHSTAR, {'type': 'domain', 'handle': 'northstar.com.evil.example'}) is None


# ---------- DNS rebinding: the connection goes to the address that was validated ----------

def test_request_is_pinned_to_the_validated_address(dns):
    ip_url, host_header, sni = safe_http.pinned_request_target('https://evil.example/login?x=1')
    assert ip_url == 'https://198.51.100.20/login?x=1' and host_header == 'evil.example' and sni == 'evil.example'


def test_dns_that_changes_after_validation_never_reaches_a_private_address(monkeypatch):
    answers = iter([[(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('198.51.100.20', 0))]])  # a second lookup would raise StopIteration

    monkeypatch.setattr(socket, 'getaddrinfo', lambda host, *a, **k: next(answers))
    monkeypatch.setattr(safe_http, '_is_public', lambda ip: ip == '198.51.100.20')
    seen = []
    real_client = httpx.Client

    def handler(request):
        seen.append(request.url.host)
        return httpx.Response(200, text='ok')
    monkeypatch.setattr(safe_http.httpx, 'Client', lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    safe_http.fetch('http://rebind.example/', check_robots=False)
    assert seen == ['198.51.100.20']  # the socket target is the validated IP, never a fresh lookup


def test_alert_webhook_to_a_private_address_is_blocked(monkeypatch):
    from brandml import jobs

    statements = []

    class Conn:
        def execute(self, sql, params=()):
            statements.append((sql, params))
            return type('R', (), {'fetchone': lambda self: {'id': 1}})()

        def commit(self):
            pass
    sent = jobs.send_alerts(Conn(), {'id': 1, 'name': 'X'}, 1, [{'findingId': 1, 'severity': 'High', 'score': 90}], url='http://169.254.169.254/hook')
    assert sent == 0
    assert len(statements) == 1 and 'alert_deliveries' in statements[0][0] and statements[0][1][3] is False  # recorded as failed, no 'alerted' event


def test_the_test_suite_cannot_reach_the_internet():
    import socket

    import pytest
    for call in (lambda s: s.connect(('93.184.216.34', 80)), lambda s: s.sendto(b'x', ('8.8.8.8', 53))):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s, pytest.raises(RuntimeError, match='over the network'):
            call(s)
