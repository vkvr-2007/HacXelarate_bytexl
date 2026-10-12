"""Look-alike handle and domain candidates generated from the brand name.

Used by sources that can only look up exact names (X user lookup, Instagram
business discovery, DNS). The lists are capped so lookups stay cheap.
"""
import re

HANDLE_WORDS = ['support', 'help', 'official', 'care', 'hq', 'app', 'team', 'rewards', 'giveaway', 'login', 'verify', 'service']
DOMAIN_WORDS = ['login', 'support', 'secure', 'verify', 'account', 'app', 'help', 'online', 'pay', 'official', 'rewards']
TLDS = ['com', 'net', 'org', 'co', 'io', 'app', 'xyz', 'online', 'site', 'shop', 'info', 'top', 'live', 'support']
ASCII_LOOKALIKES = {'o': ['0'], 'l': ['1', 'i'], 'i': ['1', 'l'], 'e': ['3'], 'a': ['4'], 's': ['5'], 'm': ['rn'], 'w': ['vv']}


def slug(value):
    return re.sub(r'[^a-z0-9]', '', (value or '').lower())


def typo_variants(word):
    out = set()
    for i in range(len(word)):
        out.add(word[:i] + word[i + 1:])                       # omission
        out.add(word[:i] + word[i] + word[i:])                 # repetition
        if i < len(word) - 1:
            out.add(word[:i] + word[i + 1] + word[i] + word[i + 2:])  # transposition
        for rep in ASCII_LOOKALIKES.get(word[i], []):
            out.add(word[:i] + rep + word[i + 1:])             # look-alike characters
    for i in range(1, len(word)):
        out.add(word[:i] + '-' + word[i:])                     # hyphenation
    out.discard(word)
    return sorted(v for v in out if len(v) >= 3)


def handle_variants(brand, limit=40):
    base = slug(brand.get('name'))
    if len(base) < 3:
        return []
    out = [base]
    for word in HANDLE_WORDS:
        out += [f'{base}{word}', f'{base}_{word}']
    out += [f'{base}_', f'_{base}', f'{base}official', f'real{base}', f'the{base}']
    out += [v.replace('-', '_') for v in typo_variants(base)]
    official = {s.get('handle', '').lower().lstrip('@') for s in brand.get('officialSocials') or []}
    seen, result = set(), []
    for handle in out:
        handle = re.sub(r'[^a-z0-9_.]', '', handle)[:30]
        if handle and handle not in seen and handle not in official:
            seen.add(handle)
            result.append(handle)
    return result[:limit]


def domain_variants(brand, limit=150):
    """Look-alike domains for the brand's primary domain (and name, if different)."""
    domain = (brand.get('domain') or '').lower().strip()
    official = {domain} | {d.lower() for d in brand.get('domains') or []}
    label = domain.split('.')[0] if domain else slug(brand.get('name'))
    tld = domain.split('.', 1)[1] if '.' in domain else 'com'
    labels = {label, slug(brand.get('name'))} - {''}
    out = []
    for base in labels:
        for variant in typo_variants(base):
            out.append(f'{variant}.{tld}')
        for t in TLDS:
            out.append(f'{base}.{t}')
        for word in DOMAIN_WORDS:
            out += [f'{base}-{word}.{tld}', f'{word}-{base}.{tld}', f'{base}{word}.{tld}']
    seen, result = set(), []
    for candidate in out:
        if candidate not in seen and candidate not in official and len(candidate.split('.')[0]) >= 3:
            seen.add(candidate)
            result.append(candidate)
    return result[:limit]
