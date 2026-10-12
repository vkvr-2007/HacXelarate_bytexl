"""Proof that someone controls a domain: a DNS TXT record or a file under /.well-known/ holding a token.

Only a proven domain may hide results from a scan. A guessed or typed-in domain proves nothing."""
import dns.exception
import dns.resolver

from . import safe_http
from .validation import DOMAIN_RE

TXT_PREFIX = '_signalguard.'
TXT_VALUE = 'signalguard-verify='
WELL_KNOWN = '/.well-known/signalguard-verify.txt'


def _txt_records(name, lifetime=4.0):
    resolver = dns.resolver.Resolver()
    resolver.lifetime = lifetime
    answers = resolver.resolve(name, 'TXT')
    return [b''.join(r.strings).decode('utf-8', 'replace') for r in answers]


def check(domain, token):
    """Return {'verified': bool, 'method': str|None, 'detail': str}. Never raises for network problems."""
    domain = (domain or '').strip().lower()
    if not DOMAIN_RE.match(domain) or not token:
        return {'verified': False, 'method': None, 'detail': 'Invalid domain or token.'}
    notes = []
    try:
        if any(r.strip() == TXT_VALUE + token for r in _txt_records(TXT_PREFIX + domain)):
            return {'verified': True, 'method': 'dns_txt', 'detail': f'TXT record found at {TXT_PREFIX}{domain}.'}
        notes.append(f'TXT record at {TXT_PREFIX}{domain} does not contain the token')
    except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer):
        notes.append(f'no TXT record at {TXT_PREFIX}{domain}')
    except (dns.resolver.NoNameservers, dns.exception.DNSException) as exc:
        notes.append(f'DNS lookup failed ({exc.__class__.__name__})')
    try:
        result = safe_http.fetch(f'https://{domain}{WELL_KNOWN}', timeout=6, max_bytes=2_000, check_robots=False, accept='text/plain')
        if result.status == 200 and result.text(2_000).strip() == token:
            return {'verified': True, 'method': 'well_known_file', 'detail': f'Token found at https://{domain}{WELL_KNOWN}.'}
        notes.append(f'file answered HTTP {result.status} without the token')
    except Exception as exc:  # unreachable, blocked or invalid: all mean "not proven"
        notes.append(f'file not readable ({exc.__class__.__name__})')
    return {'verified': False, 'method': None, 'detail': 'Not proven: ' + '; '.join(notes) + '.'}
