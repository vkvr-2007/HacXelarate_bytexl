"""Phishing indicators for look-alike domains and web pages.

The page check fetches at most one page per candidate through safe_http
(public addresses only, robots.txt honoured, size and redirect caps), then
looks for the signs of a credential-harvesting or impersonating site. The
result is a set of named, weighted factors so every score can be explained.
These are risk indicators, not proof that a site is malicious.
"""
import re
from datetime import datetime, UTC
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

from . import logo, safe_http
from .text import fold, skeleton

PHISHING_WORDS = re.compile(
    r'verify (your )?account|confirm (your )?identity|account (is )?(suspended|locked)|update (your )?payment|'
    r'seed phrase|recovery phrase|wallet connect|connect wallet|one[- ]time password|\botp\b|unusual activity|'
    r'claim (your )?(reward|prize|refund)|security alert', re.I)
PARKED_WORDS = re.compile(r'domain (is )?for sale|buy this domain|this domain may be for sale|parked (free|domain)|sedo|dan\.com|afternic', re.I)


class _PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title, self.description, self.icon = '', '', ''
        self.forms, self.password_inputs, self.links, self.scripts = [], 0, [], 0
        self._in_title, self.text = False, []

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or '') for k, v in attrs}
        if tag == 'title':
            self._in_title = True
        elif tag == 'meta' and a.get('name', '').lower() in ('description', 'og:description'):
            self.description = self.description or a.get('content', '')
        elif tag == 'link' and 'icon' in a.get('rel', '').lower():
            self.icon = self.icon or a.get('href', '')
        elif tag == 'form':
            self.forms.append(a.get('action', ''))
        elif tag == 'input' and a.get('type', '').lower() == 'password':
            self.password_inputs += 1
        elif tag == 'a' and a.get('href'):
            self.links.append(a['href'])
        elif tag == 'script' and a.get('src'):
            self.scripts += 1

    def handle_endtag(self, tag):
        if tag == 'title':
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif len(self.text) < 400:
            self.text.append(data.strip())


def _host(url):
    return (urlsplit(url).hostname or '').lower()


def _is_official(host, official):
    return any(host == d or host.endswith('.' + d) for d in official)


def analyze_html(html, page_url, brand):
    """Facts about a fetched page. Pure function so it can be tested without the network."""
    parser = _PageParser()
    try:
        parser.feed(html[:500_000])
    except Exception:  # noqa: S110 - malformed HTML: keep what was parsed
        pass
    official = {d.lower() for d in [brand.get('domain', '')] + list(brand.get('domains') or []) if d}
    host = _host(page_url)
    body = ' '.join(t for t in parser.text if t)
    text = f'{parser.title} {parser.description} {body}'
    brand_skel = skeleton(brand.get('name', ''))
    actions = [urljoin(page_url, a) if a else page_url for a in parser.forms]
    offsite_actions = [a for a in actions if _host(a) and _host(a) != host]
    official_links = sum(_is_official(_host(urljoin(page_url, href)), official) for href in parser.links)
    return {
        'title': parser.title.strip()[:200],
        'description': parser.description.strip()[:300],
        'brandInTitle': bool(brand_skel) and brand_skel in skeleton(parser.title),
        'brandMentions': skeleton(text).count(brand_skel) if len(brand_skel) >= 3 else 0,
        'passwordFields': parser.password_inputs,
        'forms': len(actions),
        'offsiteFormActions': offsite_actions[:5],
        'linksToOfficial': official_links,
        'phishingPhrases': sorted({m.group(0).lower() for m in PHISHING_WORDS.finditer(text)})[:8],
        'parked': bool(PARKED_WORDS.search(text)),
        'iconUrl': urljoin(page_url, parser.icon or '/favicon.ico'),
        'externalScripts': parser.scripts,
        'copiesDescription': _copies(brand.get('description', ''), parser.description),
    }


def _copies(official, page):
    words = {w for w in re.findall(r'[a-z]{4,}', fold(official))}
    found = {w for w in re.findall(r'[a-z]{4,}', fold(page))}
    return len(words) >= 5 and len(words & found) / len(words) >= 0.6


def inspect(url, brand, logo_refs=()):
    """Fetch one page safely and return page facts, or a record of why it was not fetched."""
    checked_at = datetime.now(UTC).isoformat()
    official = {d.lower() for d in [brand.get('domain', '')] + list(brand.get('domains') or []) if d}
    try:
        result = safe_http.fetch(url, timeout=6.0, max_bytes=800_000)
    except safe_http.RobotsDisallowed:
        return {'fetched': False, 'reason': 'robots.txt disallows fetching this page', 'checkedAt': checked_at}
    except safe_http.UnsafeURLError as exc:
        return {'fetched': False, 'reason': f'Blocked by SSRF protection: {exc}', 'checkedAt': checked_at}
    except Exception as exc:  # DNS, TLS, timeouts: the site is unreachable from here
        return {'fetched': False, 'reason': f'Unreachable ({exc.__class__.__name__})', 'checkedAt': checked_at}
    page = {'fetched': True, 'status': result.status, 'finalUrl': result.url, 'checkedAt': checked_at,
            'redirectsToOfficial': _is_official(_host(result.url), official)}
    content_type = result.headers.get('content-type', '')
    if result.status < 400 and 'html' in content_type:
        page.update(analyze_html(result.text(), result.url, brand))
        if logo_refs and page.get('iconUrl'):
            page['faviconSimilarity'] = logo.similarity(list(logo_refs), page['iconUrl'])
    return page


def factors(cand, name_probability):
    """Weighted, named risk factors for a domain or web candidate."""
    out = [('Name resembles the brand (model)', round(name_probability * 55))]
    dns = cand.get('dns') or {}
    if dns.get('a'):
        out.append(('Domain is registered and resolves', 5))
    if dns.get('mx'):
        out.append(('Domain can receive email (MX record), so it can be used for phishing mail', 10))
    cert = cand.get('certificate') or {}
    issued = _parse_date(cert.get('notBefore'))
    if issued and (datetime.now(UTC) - issued).days <= 30:
        out.append(('TLS certificate issued in the last 30 days', 10))
    page = cand.get('page') or {}
    if page.get('fetched'):
        if page.get('redirectsToOfficial'):
            out.append(('Redirects to an official brand domain (likely a defensive registration)', -45))
        if page.get('passwordFields'):
            out.append(('Page asks for a password', 20))
        if page.get('offsiteFormActions'):
            out.append(('Form submits data to another domain', 10))
        if page.get('brandInTitle'):
            out.append(('Page title uses the brand name', 10))
        elif page.get('brandMentions'):
            out.append((f"Page mentions the brand {page['brandMentions']} times", 5))
        if page.get('phishingPhrases'):
            out.append((f"Phishing phrases: {', '.join(page['phishingPhrases'][:3])}", 15))
        if (page.get('faviconSimilarity') or 0) >= 0.85:
            out.append((f"Favicon looks like the official logo ({round(page['faviconSimilarity'] * 100)}%)", 15))
        if page.get('copiesDescription'):
            out.append(('Copies the official brand description', 10))
        if page.get('parked'):
            out.append(('Parked or for-sale page', -15))
    return [(label, points) for label, points in out if points]


def _parse_date(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def score(cand, name_probability):
    items = factors(cand, name_probability)
    total = max(0, min(100, sum(points for _, points in items)))
    return total, [{'factor': label, 'points': points} for label, points in items]


def category(cand):
    page = cand.get('page') or {}
    if page.get('redirectsToOfficial'):
        return 'Defensive registration (redirects to official site)'
    if page.get('passwordFields') or page.get('phishingPhrases'):
        return 'Phishing / credential harvesting site'
    if page.get('parked'):
        return 'Parked look-alike domain'
    if (cand.get('dns') or {}).get('mx'):
        return 'Look-alike domain with email'
    return 'Look-alike domain' if cand.get('type') == 'domain' else 'Brand-referencing web page'
