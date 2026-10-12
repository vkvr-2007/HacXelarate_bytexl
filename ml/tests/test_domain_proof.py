"""Domain ownership proof. DNS and HTTP are faked: these tests never touch the network."""
import dns.resolver
import pytest

from brandml import domain_proof, safe_http

TOKEN = 'abc123def456'


class Reply:
    def __init__(self, status, body):
        self.status, self._body = status, body

    def text(self, limit=None):
        return self._body


@pytest.fixture
def world(monkeypatch):
    state = {'txt': dns.resolver.NXDOMAIN(), 'file': safe_http.UnsafeURLError('blocked'), 'fetched': []}

    def txt(name, lifetime=4.0):
        if isinstance(state['txt'], Exception):
            raise state['txt']
        return state['txt']

    def fetch(url, **kwargs):
        state['fetched'].append(url)
        if isinstance(state['file'], Exception):
            raise state['file']
        return state['file']
    monkeypatch.setattr(domain_proof, '_txt_records', txt)
    monkeypatch.setattr(domain_proof.safe_http, 'fetch', fetch)
    return state


def test_dns_txt_record_proves_control(world):
    world['txt'] = [f'signalguard-verify={TOKEN}']
    assert domain_proof.check('Acme.com', TOKEN) == {'verified': True, 'method': 'dns_txt', 'detail': 'TXT record found at _signalguard.acme.com.'}
    assert world['fetched'] == []


def test_well_known_file_proves_control(world):
    world['file'] = Reply(200, f' {TOKEN}\n')
    result = domain_proof.check('acme.com', TOKEN)
    assert result['verified'] and result['method'] == 'well_known_file'
    assert world['fetched'] == ['https://acme.com/.well-known/signalguard-verify.txt']


@pytest.mark.parametrize('txt,file', [
    (['signalguard-verify=someone-elses-token'], Reply(200, 'other')),
    (dns.resolver.NoAnswer(), Reply(404, '')),
    (dns.resolver.NXDOMAIN(), safe_http.UnsafeURLError('private address')),
    (dns.resolver.NoNameservers(), OSError('down')),
])
def test_wrong_token_missing_record_or_network_failure_is_not_proof(world, txt, file):
    world['txt'], world['file'] = txt, file
    result = domain_proof.check('acme.com', TOKEN)
    assert result['verified'] is False and result['method'] is None and result['detail'].startswith('Not proven')


def test_file_that_merely_contains_the_token_is_not_proof(world):
    world['file'] = Reply(200, f'<html>{TOKEN}</html>')
    assert domain_proof.check('acme.com', TOKEN)['verified'] is False


@pytest.mark.parametrize('domain,token', [('not a domain', TOKEN), ('acme.com', ''), ('-bad.com', TOKEN)])
def test_invalid_input_is_refused_without_lookups(world, domain, token):
    assert domain_proof.check(domain, token)['verified'] is False
    assert world['fetched'] == []
