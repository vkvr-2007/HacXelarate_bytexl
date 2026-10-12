"""Scan pipeline: collect → exclude official assets → retrieve → logo match → rank → explain.

Social accounts and apps are ranked by the trained model. Domains and web pages
get the model's name-similarity probability plus weighted phishing indicators
from web_risk. Every score is a risk estimate for a reviewer, not proof.
"""
import re
import os
import time
from datetime import datetime, UTC
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import joblib

from . import logo, web_risk
from .sources.registry import run_collectors
from .features import BrandContext, explain, extract, signals, vector
from .retriever import Retriever, expand_queries
from .text import fold, handle_key

MODEL_PATH = Path(__file__).resolve().parents[1] / 'models' / 'brandml.joblib'
REPORT_THRESHOLD = 40
EVIDENCE_KEYS = ('source', 'url', 'query', 'collectedAt', 'cached', 'raw', 'dns', 'certificate', 'page', 'discovery', 'provider', 'declaredAsset')


class Engine:
    def __init__(self, path=MODEL_PATH):
        self.load(path)

    def load(self, path=MODEL_PATH):
        bundle = joblib.load(path)
        self.model = bundle['model']
        self.version = bundle['version']
        self.metrics = bundle['metrics']
        self.retriever = Retriever(bundle['vectorizer'])

    # ---------- allowlist ----------
    @staticmethod
    def confirmed(items):
        """Only assets a person has confirmed can hide results. Suggested and unverified ones never do."""
        return [x for x in items or [] if x.get('trust') == 'confirmed']

    @classmethod
    def official_match(cls, brand, cand):
        """Return why a candidate is a confirmed official asset, or None."""
        ext = (cand.get('externalId') or '').strip().lower()
        if cand.get('type') in ('domain', 'web'):
            host = web_risk._host(cand.get('url') or '') or (cand.get('handle') or '').lower()
            official = {d.lower() for d in brand.get('confirmedDomains') or [] if d}
            if host and web_risk._is_official(host, official):
                return f'Official domain {host} (ownership proven)'
        elif cand.get('type') == 'social':
            key = handle_key(cand.get('handle') or ext)
            for acct in cls.confirmed(brand.get('officialSocials')):
                same_platform = not acct.get('platform') or not cand.get('platform') or acct['platform'].lower() == cand['platform'].lower()
                if same_platform and key and handle_key(acct.get('handle', '')) == key:
                    return f"Official {acct.get('platform', 'social')} account {acct.get('handle')}"
        else:
            ids = {ext, (cand.get('appId') or '').lower(), (cand.get('bundleId') or '').lower()} - {''}
            apps = cls.confirmed(brand.get('officialApps'))
            for app in apps:
                if (app.get('appId') or '').strip().lower() in ids:
                    return f"Official app {app.get('appId')}"
            publisher = fold(cand.get('publisher') or '').strip()
            for app in apps:
                if publisher and publisher == fold(app.get('publisher') or '').strip():
                    return f"Published by official publisher {app.get('publisher')}"
        for item in brand.get('allowlist') or []:
            if (item.get('externalId') or '').strip().lower() == ext and ext:
                return 'Marked official by a reviewer'
        return None

    @staticmethod
    def declared_match(brand, cand):
        """Describe a match with a declared official asset that is not confirmed, so the analyst sees why it is still listed."""
        ext = (cand.get('externalId') or '').strip().lower()
        if cand.get('type') in ('domain', 'web'):
            host = web_risk._host(cand.get('url') or '') or (cand.get('handle') or '').lower()
            declared = {d.lower() for d in [brand.get('domain', '')] + list(brand.get('domains') or []) if d} - {d.lower() for d in brand.get('confirmedDomains') or []}
            if host and web_risk._is_official(host, declared):
                return f'Matches declared domain {host}, but ownership is not proven yet'
        elif cand.get('type') == 'social':
            key = handle_key(cand.get('handle') or ext)
            for acct in brand.get('officialSocials') or []:
                if acct.get('trust') != 'confirmed' and key and handle_key(acct.get('handle', '')) == key:
                    return f"Matches declared account {acct.get('handle')}, which is {acct.get('trust') or 'unverified'}"
        else:
            ids = {ext, (cand.get('appId') or '').lower()} - {''}
            for app in brand.get('officialApps') or []:
                if app.get('trust') != 'confirmed' and (app.get('appId') or '').strip().lower() in ids:
                    return f"Matches declared app {app.get('appId')}, which is {app.get('trust') or 'unverified'}"
        return None

    # ---------- scoring ----------
    def probability(self, ctx, cand):
        f = extract(ctx, cand)
        return float(self.model.predict_proba([vector(f)])[0][1]), f

    def score(self, brand, cand, ctx=None, logo_refs=None):
        ctx = ctx or BrandContext(brand)
        if cand.get('type') in ('domain', 'web'):
            return self.score_site(brand, cand, ctx)
        if logo_refs and cand.get('iconUrl') and cand.get('logoSimilarity') is None:
            cand['logoSimilarity'] = logo.similarity(logo_refs, cand['iconUrl'])
        proba, f = self.probability(ctx, cand)
        risk = round(proba * 100)
        return {
            **cand,
            'probability': round(proba, 4),
            'score': risk,
            'severity': severity(risk),
            'reasons': explain(ctx, cand, f),
            'signals': signals(f),
            'features': {k: round(v, 3) for k, v in f.items()},
            'factors': [],
            'category': category(cand, f),
            'scoring': 'model',
        }

    def score_site(self, brand, cand, ctx):
        host = cand.get('handle') or web_risk._host(cand.get('url') or '')
        label = host.split('.')[0] if cand.get('type') == 'domain' else (cand.get('name') or host)
        name_cand = {'type': 'social', 'name': label.replace('-', ' '), 'handle': host.split('.')[0], 'description': ''}
        proba, f = self.probability(ctx, name_cand)
        risk, factors = web_risk.score(cand, proba)
        reasons = [x['factor'] for x in factors if x['points'] > 0][:6]
        return {
            **cand,
            'probability': round(proba, 4),
            'score': risk,
            'severity': severity(risk),
            'reasons': reasons,
            'signals': signals(f),
            'features': {k: round(v, 3) for k, v in f.items()},
            'factors': factors,
            'category': web_risk.category(cand),
            'scoring': 'model+rules',
        }

    def inspect_sites(self, brand, candidates, logo_refs):
        """Fetch pages for the most name-similar domains and web results (bounded)."""
        limit = int(os.getenv('MAX_PAGE_CHECKS', '25'))
        if os.getenv('PAGE_CHECKS', 'on').lower() in ('0', 'off', 'false') or limit <= 0:
            return
        ctx = BrandContext(brand)
        ranked = sorted(candidates, key=lambda c: -self.score_site(brand, c, ctx)['probability'])[:limit]
        with ThreadPoolExecutor(max_workers=6) as executor:
            pages = list(executor.map(lambda c: web_risk.inspect(c.get('url') or f"https://{c['handle']}", brand, logo_refs), ranked))
        for cand, page in zip(ranked, pages, strict=False):
            cand['page'] = page

    def scan(self, brand, mode='live', enabled=None, cache=None):
        started = time.time()
        queries = expand_queries(brand)
        raw, sources = run_collectors(brand, queries, mode=mode, enabled=enabled, cache=cache)

        seen, unique = set(), []
        for cand in raw:
            key = (cand.get('platform', '').lower(), (cand.get('externalId') or cand.get('name', '')).lower())
            if key not in seen:
                seen.add(key)
                unique.append(cand)

        excluded, pool = [], []
        for cand in unique:
            why = self.official_match(brand, cand)
            if why:
                excluded.append({k: cand.get(k) for k in ('type', 'platform', 'name', 'handle', 'appId', 'publisher', 'url', 'iconUrl')} | {'reason': why})
            else:
                note = self.declared_match(brand, cand)
                if note:
                    cand['declaredAsset'] = note
                pool.append(cand)

        profiles = [c for c in pool if c.get('type') not in ('domain', 'web')]
        sites = [c for c in pool if c.get('type') in ('domain', 'web')]
        retrieved = self.retriever.retrieve(brand, profiles) + [(c, None) for c in sites]
        ctx = BrandContext(brand)
        logo_refs = [ref for ref in [brand.get('logoUrl')] + list(brand.get('logoUrls') or []) if ref]
        if mode == 'live':
            self.inspect_sites(brand, sites, logo_refs)
        scored_at = datetime.now(UTC).isoformat()

        def run(pair):
            result = self.score(brand, pair[0], ctx, logo_refs)
            result['retrievalScore'] = None if pair[1] is None else round(pair[1], 3)
            result['evidence'] = {k: result.get(k) for k in EVIDENCE_KEYS if result.get(k) is not None} | {
                'scoredAt': scored_at, 'modelVersion': self.version, 'mode': mode}
            return result

        with ThreadPoolExecutor(max_workers=8) as executor:
            scored = list(executor.map(run, retrieved))

        detections = sorted([c for c in scored if c['score'] >= REPORT_THRESHOLD], key=lambda c: -c['score'])
        return {
            'brand': brand.get('name'),
            'mode': mode,
            'queries': queries,
            'sources': sources,
            'detections': detections,
            'excluded': excluded,
            'stats': {
                'collected': len(raw),
                'unique': len(unique),
                'excludedOfficial': len(excluded),
                'retrieved': len(retrieved),
                'droppedByRetriever': len(profiles) - (len(retrieved) - len(sites)),
                'belowThreshold': len(scored) - len(detections),
                'detections': len(detections),
                'durationMs': int((time.time() - started) * 1000),
            },
            'evaluation': evaluate(unique, detections, excluded) if mode == 'demo' else None,
            'model': {'version': self.version, 'f1': self.metrics.get('f1'), 'precision': self.metrics.get('precision'), 'recall': self.metrics.get('recall')},
        }


def severity(score):
    if score >= 85:
        return 'Critical'
    if score >= 70:
        return 'High'
    if score >= 55:
        return 'Medium'
    return 'Low'


def category(cand, f):
    text = fold(f"{cand.get('name', '')} {cand.get('handle', '')} {cand.get('description', '')}")
    rules = [
        (r'giveaway|airdrop|prize|gift card|claim', 'Giveaway / prize scam'),
        (r'invest|double|crypto|bitcoin|usdt|returns|seed phrase', 'Investment / crypto scam'),
        (r'hiring|careers|jobs|salary|recruit', 'Recruitment scam'),
        (r'support|help|care|recovery|refund|helpline|otp|verify|verification', 'Customer support scam'),
        (r'loan|cash', 'Predatory finance app'),
        (r'unlock|premium.*free|mod\b|pro unlocked', 'Cracked / modded app'),
    ]
    for pattern, label in rules:
        if re.search(pattern, text):
            return label
    if cand.get('type') == 'app':
        return 'Impersonating app' if f['publisher_mismatch'] else 'Look-alike app'
    return 'Impersonation profile'


def evaluate(unique, detections, excluded):
    """Precision/recall against seeded labels, when the scan included labelled data."""
    labelled = [c for c in unique if c.get('expected')]
    if not labelled:
        return None
    flagged = {(c.get('platform'), c.get('externalId')) for c in detections}
    threats = [c for c in labelled if c['expected'] == 'threat']
    tp = sum((c.get('platform'), c.get('externalId')) in flagged for c in threats)
    fp = sum((c.get('platform'), c.get('externalId')) in flagged for c in labelled if c['expected'] != 'threat')
    officials = [c for c in labelled if c['expected'] == 'official']
    official_flagged = sum((c.get('platform'), c.get('externalId')) in flagged for c in officials)
    return {
        'labelled': len(labelled),
        'plantedThreats': len(threats),
        'caught': tp,
        'falsePositives': fp,
        'officialFlagged': official_flagged,
        'officialExcluded': len(excluded),
        'precision': round(tp / (tp + fp), 3) if tp + fp else None,
        'recall': round(tp / len(threats), 3) if threats else None,
    }
