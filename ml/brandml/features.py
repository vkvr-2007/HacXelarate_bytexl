"""Pairwise (brand, candidate) feature extraction for the impersonation ranker."""
import re
import unicodedata

from rapidfuzz import fuzz
from rapidfuzz.distance import DamerauLevenshtein, JaroWinkler

from .text import (
    BENIGN_CONTEXT_WORDS, IMPERSONATION_WORDS, SCAM_WORDS, compact, extract_urls, fold,
    handle_key, has_homoglyph, skeleton, tokens,
)

STOPWORDS = {
    'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'by', 'your', 'you',
    'our', 'we', 'is', 'are', 'at', 'from', 'this', 'that', 'it', 'all', 'new', 'get', 'more',
}

FEATURE_NAMES = [
    'name_sim', 'name_skeleton_sim', 'name_jaro', 'name_exact_skeleton', 'name_contains_brand',
    'name_partial', 'name_token_best', 'handle_sim', 'handle_contains_brand', 'handle_partial',
    'spacing_variant', 'swap_or_typo', 'homoglyph', 'leet', 'impersonation_words',
    'benign_words', 'other_words', 'len_ratio', 'desc_brand_mention', 'desc_overlap',
    'scam_words', 'offdomain_link', 'is_app', 'publisher_present', 'publisher_sim',
    'publisher_mismatch', 'logo_known', 'logo_sim', 'short_brand',
]


class BrandContext:
    """Pre-computed view of the brand profile used for every candidate."""

    def __init__(self, brand: dict):
        self.brand = brand
        names = [brand.get('name', '')] + list(brand.get('aliases') or [])
        self.names = [n for n in names if n and n.strip()]
        self.compacts = [compact(n) for n in self.names]
        self.skeletons = [skeleton(n) for n in self.names]
        self.name_tokens = set()
        for name in self.names:
            self.name_tokens.update(tokens(name))
        self.keywords = {k.lower() for k in (brand.get('keywords') or [])}
        self.domains = {d.lower().strip() for d in [brand.get('domain', '')] + list(brand.get('domains') or []) if d}
        self.official_publishers = [fold(app.get('publisher', '')) for app in brand.get('officialApps') or [] if app.get('publisher')]
        self.description_terms = content_terms(brand.get('description', ''))
        self.logo_hashes: list = []

    @property
    def min_brand_len(self):
        return min((len(s) for s in self.skeletons if s), default=0)


def content_terms(text: str) -> set:
    return {t for t in tokens(text) if len(t) > 2 and t not in STOPWORDS}


def _best(values):
    return max(values) if values else 0.0


def _pieces(raw):
    """Skeletons of each word and of each adjacent pair of words ("North Star" -> "northstar").

    Working per word avoids false joins across word boundaries, such as
    "lighter northstar" collapsing "rn" into "m".
    """
    words = [skeleton(t) for t in tokens(raw)]
    words = [w for w in words if w]
    return words, [a + b for a, b in zip(words, words[1:], strict=False)]


def _contains(brand_skels, raw):
    words, pairs = _pieces(raw)
    return float(any(len(b) >= 4 and b in piece for b in brand_skels for piece in words + pairs))


def _is_spacing_variant(ctx, raw):
    """Same letters as the brand but different spacing or punctuation."""
    folded = fold(raw).strip()
    for name, comp in zip(ctx.names, ctx.compacts, strict=False):
        if comp and compact(raw) == comp and folded != fold(name).strip():
            return 1.0
    # Brand split across two words inside a longer name, e.g. "North Star Help".
    words, pairs = _pieces(raw)
    lowered = unicodedata.normalize('NFKC', raw or '').lower()
    if any(p in ctx.skeletons for p in pairs) and not any(w in ctx.skeletons for w in words) \
            and not any(n.lower().replace(' ', '') in lowered for n in ctx.names):
        return 1.0
    return 0.0


def _is_leet(ctx, raw):
    """A word with digits or symbols that reads as the brand once they are mapped to letters."""
    for token in re.split(r'[\s_.\-]+', fold(raw)):
        if not re.search(r'[0134579@$|!]', token):
            continue
        token_skel = skeleton(token)
        for brand_skel in ctx.skeletons:
            if len(brand_skel) >= 4 and (brand_skel in token_skel or DamerauLevenshtein.distance(token_skel, brand_skel) <= 1) \
                    and brand_skel not in skeleton(re.sub(r'[0-9@$|!]', '', token)):
                return 1.0
    return 0.0


def _is_swap_or_typo(ctx, raw):
    """One or two edits away from the brand (transposition, insertion, deletion, substitution)."""
    skel = skeleton(raw)
    if not skel:
        return 0.0
    for brand_skel in ctx.skeletons:
        if len(brand_skel) < 4 or skel == brand_skel:
            continue
        distance = DamerauLevenshtein.distance(skel, brand_skel)
        if distance == 1 or (distance == 2 and len(brand_skel) >= 7):
            return 1.0
        for token in tokens(raw):
            token_skel = skeleton(token)
            if token_skel != brand_skel and len(token_skel) >= 4 and DamerauLevenshtein.distance(token_skel, brand_skel) == 1:
                return 1.0
    return 0.0


def _word_counts(ctx, raw):
    """Counts of impersonation, benign and other words left after removing the brand."""
    brand_skels = set(ctx.skeletons)
    impersonation = benign = other = 0
    for token in tokens(raw):
        token_skel = skeleton(token)
        if token in ctx.name_tokens or token_skel in brand_skels:
            continue
        if any(len(b) >= 4 and b in token_skel for b in brand_skels):
            # Joined forms such as "northstarsupport": check the leftover part.
            rest = token_skel
            for b in brand_skels:
                rest = rest.replace(b, '')
            if not rest:
                continue
            if any(rest.startswith(skeleton(w)) or rest.endswith(skeleton(w)) for w in IMPERSONATION_WORDS):
                impersonation += 1
            else:
                other += 1
            continue
        if any(DamerauLevenshtein.distance(token_skel, b) <= 1 for b in brand_skels if len(b) >= 4):
            continue
        if token in IMPERSONATION_WORDS or token in ctx.keywords:
            impersonation += 1
        elif token in BENIGN_CONTEXT_WORDS:
            benign += 1
        else:
            other += 1
    return impersonation, benign, other


def extract(ctx: BrandContext, cand: dict) -> dict:
    name = cand.get('name') or ''
    handle = handle_key(cand.get('handle') or '')
    description = cand.get('description') or ''
    name_skel = skeleton(name)
    name_comp = compact(name)
    handle_skel = skeleton(handle)

    name_sim = _best([fuzz.ratio(name_comp, c) / 100 for c in ctx.compacts if c])
    name_skeleton_sim = _best([fuzz.ratio(name_skel, s) / 100 for s in ctx.skeletons if s])
    name_jaro = _best([JaroWinkler.similarity(name_skel, s) for s in ctx.skeletons if s])
    name_exact = float(bool(name_skel) and name_skel in ctx.skeletons)
    name_partial = _best([fuzz.partial_ratio(s, name_skel) / 100 for s in ctx.skeletons if len(s) >= 4 and name_skel])
    token_best = _best([fuzz.ratio(skeleton(t), s) / 100 for t in tokens(name) for s in ctx.skeletons if s])
    handle_sim = _best([fuzz.ratio(handle_skel, s) / 100 for s in ctx.skeletons if s and handle_skel])
    handle_partial = _best([fuzz.partial_ratio(s, handle_skel) / 100 for s in ctx.skeletons if len(s) >= 4 and handle_skel])

    impersonation, benign, other = _word_counts(ctx, name)
    h_imp, h_ben, h_other = _word_counts(ctx, handle.replace('_', ' ').replace('.', ' ')) if handle else (0, 0, 0)

    desc_terms = content_terms(description)
    overlap = len(desc_terms & ctx.description_terms) / max(1, min(len(desc_terms), len(ctx.description_terms))) if desc_terms and ctx.description_terms else 0.0
    text_for_scam = set(tokens(f'{name} {handle} {description}'))
    scam_hits = len(text_for_scam & SCAM_WORDS)

    offdomain = 0.0
    for url in extract_urls(description) + extract_urls(cand.get('website') or ''):
        host = re.sub(r'^(https?://)?(www\.)?', '', url.lower()).split('/')[0]
        if host and not any(host == d or host.endswith('.' + d) for d in ctx.domains):
            offdomain = 1.0

    is_app = float(cand.get('type') == 'app')
    publisher = fold(cand.get('publisher') or '')
    publisher_sim = _best([fuzz.token_set_ratio(publisher, p) / 100 for p in ctx.official_publishers]) if publisher else 0.0
    publisher_mismatch = float(bool(is_app and publisher and ctx.official_publishers and publisher_sim < 0.9))

    logo_sim = cand.get('logoSimilarity')
    logo_known = float(logo_sim is not None and logo_sim >= 0)

    brand_len = len(ctx.skeletons[0]) if ctx.skeletons else 0
    return {
        'name_sim': name_sim,
        'name_skeleton_sim': name_skeleton_sim,
        'name_jaro': name_jaro,
        'name_exact_skeleton': name_exact,
        'name_contains_brand': _contains(ctx.skeletons, name),
        'name_partial': name_partial,
        'name_token_best': token_best,
        'handle_sim': handle_sim,
        'handle_contains_brand': _contains(ctx.skeletons, handle),
        'handle_partial': handle_partial,
        'spacing_variant': max(_is_spacing_variant(ctx, name), _is_spacing_variant(ctx, handle) if handle else 0.0),
        'swap_or_typo': max(_is_swap_or_typo(ctx, name), _is_swap_or_typo(ctx, handle) if handle else 0.0),
        'homoglyph': float(has_homoglyph(name) or has_homoglyph(cand.get('handle') or '')),
        'leet': max(_is_leet(ctx, name), _is_leet(ctx, handle)),
        'impersonation_words': float(max(impersonation, h_imp)),
        'benign_words': float(max(benign, h_ben)),
        'other_words': float(other),
        'len_ratio': len(name_skel) / brand_len if brand_len else 0.0,
        'desc_brand_mention': _contains(ctx.skeletons, description),
        'desc_overlap': overlap,
        'scam_words': float(min(scam_hits, 6)),
        'offdomain_link': offdomain,
        'is_app': is_app,
        'publisher_present': float(bool(publisher)),
        'publisher_sim': publisher_sim,
        'publisher_mismatch': publisher_mismatch,
        'logo_known': logo_known,
        'logo_sim': float(logo_sim) if logo_known and logo_sim is not None else 0.0,
        'short_brand': float(brand_len < 5),
    }


def vector(features: dict) -> list:
    return [features[name] for name in FEATURE_NAMES]


def explain(ctx: BrandContext, cand: dict, f: dict) -> list:
    """Human-readable reasons, strongest first."""
    brand = ctx.names[0] if ctx.names else 'the brand'
    name = cand.get('name') or cand.get('handle') or 'Candidate'
    reasons = []
    if f['homoglyph']:
        reasons.append(f'"{name}" uses look-alike Unicode characters to imitate "{brand}"')
    if f['leet']:
        reasons.append(f'"{name}" swaps letters for digits or symbols (leetspeak)')
    if f['spacing_variant']:
        reasons.append(f'Spacing or punctuation variation of "{brand}"')
    if f['swap_or_typo']:
        reasons.append(f'Character swap or typo of "{brand}"')
    if f['name_exact_skeleton'] and not (f['spacing_variant'] or f['homoglyph'] or f['leet']):
        reasons.append(f'Uses the exact brand name "{brand}"')
    elif (f['name_contains_brand'] or f['handle_contains_brand']) and f['impersonation_words']:
        reasons.append('Brand name plus impersonation words (support, official, rewards…)')
    elif f['name_contains_brand'] or f['handle_contains_brand']:
        reasons.append(f'Contains the brand name "{brand}"')
    elif f['name_skeleton_sim'] >= 0.75:
        reasons.append(f'Name is {round(f["name_skeleton_sim"] * 100)}% similar to "{brand}"')
    if f['logo_known'] and f['logo_sim'] >= 0.8:
        reasons.append(f'Icon/avatar is {round(f["logo_sim"] * 100)}% similar to the official logo')
    if f['publisher_mismatch']:
        reasons.append(f'Publisher "{cand.get("publisher")}" is not an official publisher')
    if f['desc_brand_mention']:
        reasons.append('Description mentions the brand')
    if f['desc_overlap'] >= 0.3:
        reasons.append(f'Description reuses {round(f["desc_overlap"] * 100)}% of the official wording')
    if f['scam_words'] >= 2:
        reasons.append(f'{int(f["scam_words"])} scam keywords (giveaway, refund, DM, verify…)')
    if f['offdomain_link']:
        reasons.append('Links to a domain that is not an official brand domain')
    if f['benign_words'] and not reasons:
        reasons.append('Looks like commentary or a fan/news page')
    return reasons


def signals(f: dict) -> list:
    """Short tags for table chips."""
    tags = []
    if f['homoglyph']:
        tags.append('Homoglyph characters')
    if f['leet']:
        tags.append('Leetspeak')
    if f['spacing_variant']:
        tags.append('Spacing variation')
    if f['swap_or_typo']:
        tags.append('Character swap / typo')
    if f['name_exact_skeleton'] and not (f['homoglyph'] or f['leet'] or f['spacing_variant']):
        tags.append('Exact brand name')
    if f['impersonation_words'] and (f['name_contains_brand'] or f['handle_contains_brand'] or f['name_partial'] >= 0.85):
        tags.append('Added words')
    if f['logo_known'] and f['logo_sim'] >= 0.8:
        tags.append('Logo match')
    if f['publisher_mismatch']:
        tags.append('Unrecognized publisher')
    if f['desc_brand_mention'] or f['desc_overlap'] >= 0.3:
        tags.append('Brand language in description')
    if f['scam_words'] >= 2:
        tags.append('Scam keywords')
    if f['offdomain_link']:
        tags.append('Off-domain link')
    return tags

