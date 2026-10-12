"""Web search over publicly indexed pages, through a configurable provider."""
from urllib.parse import urlsplit

from .base import Collector, SourceError, api_request, env

PROVIDERS = {
    'brave': ('BRAVE_SEARCH_API_KEY', 'https://api-dashboard.search.brave.com/app/documentation/web-search/get-started'),
    'serpapi': ('SERPAPI_API_KEY', 'https://serpapi.com/search-api'),
}


def provider():
    chosen = env('WEB_SEARCH_PROVIDER').lower()
    if chosen in PROVIDERS:
        return chosen
    for name, (var, _) in PROVIDERS.items():
        if env(var):
            return name
    return ''


def web_queries(brand):
    name = brand.get('name', '').strip()
    exclude = ' '.join(f'-site:{d}' for d in [brand.get('domain', '')] + list(brand.get('domains') or []) if d)
    templates = ['"{n}" login', '"{n}" customer support number', '"{n}" app download apk', '"{n}" giveaway OR airdrop OR refund']
    limit = int(env('WEB_SEARCH_MAX_QUERIES', '4'))
    return [f'{t.format(n=name)} {exclude}'.strip() for t in templates][:limit]


class WebSearchCollector(Collector):
    key = 'web_search'
    label = 'Web search'
    category = 'web'
    optional_env = ('WEB_SEARCH_PROVIDER', 'BRAVE_SEARCH_API_KEY', 'SERPAPI_API_KEY', 'WEB_SEARCH_MAX_QUERIES')
    docs = PROVIDERS['brave'][1]
    access = 'Brave Search API (BRAVE_SEARCH_API_KEY) or SerpApi (SERPAPI_API_KEY). Choose with WEB_SEARCH_PROVIDER.'
    cost = 'Brave: $5 free credit a month (~1,000 searches). SerpApi: 250 free searches a month.'
    per_query = False

    def configured(self):
        name = provider()
        return bool(name and env(PROVIDERS[name][0]))

    def missing(self):
        return [] if self.configured() else ['BRAVE_SEARCH_API_KEY or SERPAPI_API_KEY']

    def search(self, query, brand):
        name = provider()
        if not name:
            raise SourceError('not_configured', 'Set BRAVE_SEARCH_API_KEY or SERPAPI_API_KEY')
        official = {d.lower() for d in [brand.get('domain', '')] + list(brand.get('domains') or []) if d}
        out, seen = [], set()
        for q in web_queries(brand):
            for result in (self._brave(q) if name == 'brave' else self._serpapi(q)):
                url = result['url']
                host = (urlsplit(url).hostname or '').lower()
                if not host or url in seen or any(host == d or host.endswith('.' + d) for d in official):
                    continue
                seen.add(url)
                out.append({
                    'type': 'web', 'platform': 'Web', 'name': result['title'], 'handle': host, 'externalId': url,
                    'description': result['snippet'], 'url': url, 'query': q, 'provider': name,
                    'raw': {'provider': name, 'query': q, 'rank': result['rank'], 'host': host},
                })
        return out

    def _brave(self, q):
        data = api_request('GET', 'https://api.search.brave.com/res/v1/web/search', source=self.key, min_interval=1.1,
                           headers={'X-Subscription-Token': env('BRAVE_SEARCH_API_KEY'), 'Accept': 'application/json'},
                           params={'q': q, 'count': 20, 'safesearch': 'off'})
        return [{'url': r.get('url', ''), 'title': r.get('title', ''), 'snippet': r.get('description', ''), 'rank': i + 1}
                for i, r in enumerate((data.get('web') or {}).get('results', [])) if r.get('url')]

    def _serpapi(self, q):
        data = api_request('GET', 'https://serpapi.com/search.json', source=self.key, min_interval=1.0,
                           params={'engine': 'google', 'q': q, 'num': 20, 'api_key': env('SERPAPI_API_KEY')})
        if data.get('error'):
            raise SourceError('unavailable', f"SerpApi: {data['error']}")
        return [{'url': r.get('link', ''), 'title': r.get('title', ''), 'snippet': r.get('snippet', ''), 'rank': r.get('position', i + 1)}
                for i, r in enumerate(data.get('organic_results', [])) if r.get('link')]
