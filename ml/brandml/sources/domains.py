"""Look-alike domain discovery: DNS checks of generated permutations and Certificate Transparency."""
from concurrent.futures import ThreadPoolExecutor

import dns.exception
import dns.resolver

from ..text import skeleton
from ..variants import domain_variants
from .base import Collector, SourceError, api_request, env


def resolve(domain, lifetime=3.0):
    """Return DNS facts for a domain, or None if it does not exist."""
    resolver = dns.resolver.Resolver()
    resolver.lifetime = lifetime
    facts: dict[str, list[str]] = {'a': [], 'mx': [], 'ns': []}
    try:
        facts['a'] = [r.to_text() for r in resolver.resolve(domain, 'A')]
    except dns.resolver.NXDOMAIN:
        return None
    except (dns.resolver.NoAnswer, dns.resolver.NoNameservers, dns.exception.Timeout):
        pass
    for kind in ('mx', 'ns'):
        try:
            facts[kind] = [r.to_text().rstrip('.') for r in resolver.resolve(domain, kind.upper())]
        except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer, dns.resolver.NoNameservers, dns.exception.Timeout):
            pass
    return facts if any(facts.values()) else None


class LookalikeDomainCollector(Collector):
    key = 'domains_dns'
    label = 'Look-alike domains (DNS)'
    category = 'domain'
    optional_env = ('DOMAIN_MAX_PERMUTATIONS',)
    docs = 'https://www.dnspython.org/'
    access = 'Generates typo, homoglyph, hyphen, keyword and TLD variants of the official domain and checks which are registered (DNS). No key.'
    per_query = False

    def search(self, query, brand):
        if not brand.get('domain'):
            raise SourceError('not_configured', 'The brand profile has no official domain')
        candidates = domain_variants(brand, limit=int(env('DOMAIN_MAX_PERMUTATIONS', '150')))
        with ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(lambda d: (d, resolve(d)), candidates))
        if candidates and all(facts is None for _, facts in results) and resolve(brand['domain']) is None:
            raise SourceError('unavailable', 'DNS lookups are failing (even the official domain did not resolve)')
        out = []
        for domain, facts in results:
            if facts:
                out.append({
                    'type': 'domain', 'platform': 'Domain', 'name': domain, 'handle': domain, 'externalId': domain,
                    'url': f'https://{domain}', 'description': '', 'dns': facts, 'discovery': 'permutation',
                    'raw': {'dns': facts},
                })
        return out


class CertTransparencyCollector(Collector):
    key = 'ct_logs'
    label = 'Certificate Transparency (crt.sh)'
    category = 'domain'
    docs = 'https://crt.sh/'
    access = 'Public crt.sh JSON search for certificates whose names contain the brand. No key; the service is often slow.'
    per_query = False

    def search(self, query, brand):
        label = skeleton(brand.get('name', ''))
        if len(label) < 4:
            raise SourceError('not_configured', 'Brand name is too short for a useful certificate search')
        data = api_request('GET', 'https://crt.sh/', source=self.key, retries=1, min_interval=5.0,
                           params={'q': f'%{label}%', 'output': 'json', 'exclude': 'expired'})
        official = {d.lower() for d in [brand.get('domain', '')] + list(brand.get('domains') or []) if d}
        seen, out = set(), []
        for row in data if isinstance(data, list) else []:
            for name in str(row.get('name_value', '')).lower().split('\n'):
                name = name.strip().lstrip('*.')
                if not name or name in seen or any(name == d or name.endswith('.' + d) for d in official):
                    continue
                seen.add(name)
                out.append({
                    'type': 'domain', 'platform': 'Domain', 'name': name, 'handle': name, 'externalId': name,
                    'url': f'https://{name}', 'description': '', 'discovery': 'certificate',
                    'certificate': {'issuer': row.get('issuer_name'), 'notBefore': row.get('not_before'), 'id': row.get('id')},
                    'raw': {'crtId': row.get('id'), 'issuer': row.get('issuer_name'), 'notBefore': row.get('not_before')},
                })
                if len(out) >= 100:
                    return out
        return out
