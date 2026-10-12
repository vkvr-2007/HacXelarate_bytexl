"""The demo collector. It serves the hand-labelled seed corpus and runs only for demo brands.

Demo results are never mixed into live scans: the registry runs this collector
for brands whose mode is 'demo' and no other collector for those brands.
"""
import json
from pathlib import Path

from ..text import compact
from .base import Collector, SourceError

DATA_DIR = Path(__file__).resolve().parents[2] / 'data'
PROFILE_URLS = {
    'Instagram': 'https://instagram.com/', 'X': 'https://x.com/', 'Facebook': 'https://facebook.com/',
    'TikTok': 'https://tiktok.com/@', 'LinkedIn': 'https://linkedin.com/company/', 'YouTube': 'https://youtube.com/@',
    'Telegram': 'https://t.me/',
}


def corpus():
    path = DATA_DIR / 'seed_corpus.json'
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}


def demo_brands():
    return [key for key in corpus() if not key.startswith('_')]


class DemoCollector(Collector):
    key = 'demo'
    label = 'Demo dataset (fictional)'
    category = 'demo'
    mode = 'demo'
    access = 'Hand-labelled fictional data for the Northstar demo brand. Never used for live brands.'
    per_query = False

    def search(self, query, brand):
        rows = corpus().get(compact(brand.get('name', '')))
        if rows is None:
            raise SourceError('not_configured', f"No demo dataset for {brand.get('name')!r}. Available: {', '.join(demo_brands())}")
        out = []
        for i, row in enumerate(rows):
            ext = row.get('appId') or row.get('handle') or row.get('url') or f'demo-{i}'
            out.append({**row, 'externalId': ext, 'demo': True, 'url': row.get('url') or demo_url(row)})
        return out


def demo_url(row):
    if row.get('type') == 'app':
        if row.get('platform') == 'Google Play':
            return f"https://play.google.com/store/apps/details?id={row.get('appId')}"
        return f"https://apps.apple.com/app/{row.get('appId')}"
    if row.get('type') in ('domain', 'web'):
        return f"https://{row.get('handle') or row.get('name')}"
    return PROFILE_URLS.get(row.get('platform'), 'https://example.invalid/') + (row.get('handle') or '').lstrip('@')
