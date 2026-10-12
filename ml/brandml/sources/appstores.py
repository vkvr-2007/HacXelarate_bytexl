"""Apple App Store and Google Play search."""
from .base import Collector, SourceError, api_request, env


class AppStoreCollector(Collector):
    key = 'app_store'
    label = 'Apple App Store'
    category = 'app'
    docs = 'https://performance-partners.apple.com/search-api'
    access = 'iTunes Search API, no key. Apple asks for roughly 20 calls per minute or fewer.'

    def search(self, query, brand):
        data = api_request('GET', 'https://itunes.apple.com/search', source=self.key, min_interval=3.0, params={
            'term': query, 'entity': 'software', 'limit': 25, 'country': env('STORE_COUNTRY', 'us'),
        })
        out = []
        for item in data.get('results', []):
            if not item.get('trackId'):
                continue
            app_id = f"id{item['trackId']}"
            out.append({
                'type': 'app', 'platform': 'App Store', 'name': item.get('trackName', ''), 'appId': app_id,
                'externalId': app_id, 'bundleId': item.get('bundleId', ''),
                'publisher': item.get('sellerName') or item.get('artistName', ''), 'publisherId': str(item.get('artistId', '')),
                'description': (item.get('description') or '')[:1500], 'iconUrl': item.get('artworkUrl512') or item.get('artworkUrl100', ''),
                'url': item.get('trackViewUrl', ''), 'followers': f"{item.get('userRatingCount', 0):,} ratings",
                'website': item.get('sellerUrl') or '', 'releasedAt': item.get('releaseDate', ''),
                'raw': {k: item.get(k) for k in ('trackId', 'bundleId', 'sellerName', 'artistId', 'releaseDate', 'currentVersionReleaseDate', 'averageUserRating', 'userRatingCount', 'primaryGenreName')},
            })
        return out


class GooglePlayCollector(Collector):
    key = 'google_play'
    label = 'Google Play'
    category = 'app'
    docs = 'https://github.com/JoMingyu/google-play-scraper'
    access = 'Public Play Store pages via google-play-scraper, no key. Google may throttle heavy use.'

    def search(self, query, brand):
        try:
            from google_play_scraper import search
        except ImportError as exc:
            raise SourceError('not_configured', 'google-play-scraper is not installed') from exc
        try:
            results = search(query, lang='en', country=env('STORE_COUNTRY', 'us'), n_hits=20)
        except Exception as exc:  # the scraper raises many exception types
            raise SourceError('unavailable', f'Play search failed: {exc.__class__.__name__}') from exc
        out = []
        for item in results or []:
            if not item.get('appId'):
                continue
            out.append({
                'type': 'app', 'platform': 'Google Play', 'name': item.get('title', ''), 'appId': item['appId'],
                'externalId': item['appId'], 'publisher': item.get('developer', ''), 'publisherId': item.get('developerId', '') or '',
                'description': (item.get('description') or item.get('summary') or '')[:1500],
                'iconUrl': item.get('icon', ''), 'url': f"https://play.google.com/store/apps/details?id={item['appId']}",
                'followers': item.get('installs') or (f"{item.get('score'):.1f} rating" if item.get('score') else ''),
                'raw': {k: item.get(k) for k in ('appId', 'developer', 'developerId', 'installs', 'score', 'genre')},
            })
        return out
