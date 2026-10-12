"""Social platform sources. Each uses the platform's own API with the access it requires."""
import re
import threading
import time

from ..variants import handle_variants
from .base import Collector, SourceError, UnsupportedCollector, api_request, env


def _strip_html(value):
    return re.sub(r'<[^>]+>', ' ', value or '').strip()


class BlueskyCollector(Collector):
    key = 'bluesky'
    label = 'Bluesky'
    docs = 'https://docs.bsky.app/docs/api/app-bsky-actor-search-actors'
    access = 'Public AppView API, no key.'

    def search(self, query, brand):
        data = api_request('GET', 'https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors', source=self.key,
                           min_interval=0.5, params={'q': query, 'limit': 25})
        out = []
        for actor in data.get('actors', []):
            handle = actor.get('handle', '')
            out.append({
                'type': 'social', 'platform': 'Bluesky', 'name': actor.get('displayName') or handle,
                'handle': f'@{handle}', 'externalId': actor.get('did') or f'@{handle}', 'description': actor.get('description', ''),
                'iconUrl': actor.get('avatar', ''), 'url': f'https://bsky.app/profile/{handle}', 'createdAt': actor.get('createdAt', ''),
                'raw': {k: actor.get(k) for k in ('did', 'handle', 'displayName', 'createdAt', 'indexedAt')},
            })
        return out


class MastodonCollector(Collector):
    key = 'mastodon'
    label = 'Mastodon'
    optional_env = ('MASTODON_INSTANCE', 'MASTODON_TOKEN')
    docs = 'https://docs.joinmastodon.org/methods/search/'
    access = 'Account search on one instance. Some instances require a token (MASTODON_TOKEN) for search.'

    def search(self, query, brand):
        instance = env('MASTODON_INSTANCE', 'https://mastodon.social').rstrip('/')
        headers = {'Authorization': f"Bearer {env('MASTODON_TOKEN')}"} if env('MASTODON_TOKEN') else None
        data = api_request('GET', f'{instance}/api/v2/search', source=self.key, min_interval=1.0, headers=headers,
                           params={'q': query, 'type': 'accounts', 'limit': 20, 'resolve': 'false'})
        out = []
        for acct in data.get('accounts', []):
            out.append({
                'type': 'social', 'platform': 'Mastodon', 'name': acct.get('display_name') or acct.get('username', ''),
                'handle': f"@{acct.get('acct', '')}", 'externalId': acct.get('url') or f"@{acct.get('acct', '')}",
                'description': _strip_html(acct.get('note', '')), 'iconUrl': acct.get('avatar_static', ''),
                'url': acct.get('url', ''), 'followers': f"{acct.get('followers_count', 0):,} followers",
                'createdAt': acct.get('created_at', ''), 'raw': {k: acct.get(k) for k in ('id', 'acct', 'url', 'created_at', 'followers_count', 'bot')},
            })
        return out


class YouTubeCollector(Collector):
    key = 'youtube'
    label = 'YouTube'
    env_vars = ('YOUTUBE_API_KEY',)
    docs = 'https://developers.google.com/youtube/v3/docs/search/list'
    access = 'YouTube Data API v3 key. Free quota of 10,000 units a day; each search costs 100 units.'

    def search(self, query, brand):
        data = api_request('GET', 'https://www.googleapis.com/youtube/v3/search', source=self.key, min_interval=0.2, params={
            'part': 'snippet', 'type': 'channel', 'q': query, 'maxResults': 15, 'key': env('YOUTUBE_API_KEY'),
        })
        out = []
        for item in data.get('items', []):
            snippet = item.get('snippet', {})
            channel = item.get('id', {}).get('channelId', '')
            if not channel:
                continue
            out.append({
                'type': 'social', 'platform': 'YouTube', 'name': snippet.get('channelTitle') or snippet.get('title', ''),
                'handle': channel, 'externalId': channel, 'description': snippet.get('description', ''),
                'iconUrl': snippet.get('thumbnails', {}).get('default', {}).get('url', ''),
                'url': f'https://www.youtube.com/channel/{channel}', 'createdAt': snippet.get('publishedAt', ''),
                'raw': {'channelId': channel, 'publishedAt': snippet.get('publishedAt')},
            })
        return out


class RedditCollector(Collector):
    key = 'reddit'
    label = 'Reddit'
    env_vars = ('REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET')
    docs = 'https://www.reddit.com/dev/api/'
    access = 'Reddit "script" app (client credentials). Free for non-commercial use; commercial use needs Reddit approval.'
    _token = (None, 0.0)
    _lock = threading.Lock()

    def token(self):
        with self._lock:
            value, expires = RedditCollector._token
            if value and time.time() < expires - 60:
                return value
            data = api_request('POST', 'https://www.reddit.com/api/v1/access_token', source=self.key, retries=1,
                               data={'grant_type': 'client_credentials'}, auth=(env('REDDIT_CLIENT_ID'), env('REDDIT_CLIENT_SECRET')))
            if 'access_token' not in data:
                raise SourceError('auth_failed', 'Reddit did not return a token. Check REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.')
            RedditCollector._token = (data['access_token'], time.time() + float(data.get('expires_in', 3600)))
            return data['access_token']

    def search(self, query, brand):
        headers = {'Authorization': f'Bearer {self.token()}'}
        out = []
        for kind, path in (('subreddit', '/subreddits/search'), ('user', '/users/search')):
            data = api_request('GET', f'https://oauth.reddit.com{path}', source=self.key, min_interval=1.0, headers=headers,
                               params={'q': query, 'limit': 15, 'raw_json': 1})
            for child in data.get('data', {}).get('children', []):
                d = child.get('data', {})
                if kind == 'subreddit':
                    name, handle = d.get('title') or d.get('display_name', ''), f"r/{d.get('display_name', '')}"
                    description, url = d.get('public_description', ''), f"https://www.reddit.com{d.get('url', '')}"
                    icon = d.get('icon_img') or d.get('community_icon', '')
                else:
                    sub = d.get('subreddit') or {}
                    name, handle = sub.get('title') or d.get('name', ''), f"u/{d.get('name', '')}"
                    description, url = sub.get('public_description', ''), f"https://www.reddit.com/user/{d.get('name', '')}"
                    icon = d.get('icon_img', '')
                out.append({
                    'type': 'social', 'platform': 'Reddit', 'name': name, 'handle': handle, 'externalId': handle.lower(),
                    'description': description, 'iconUrl': (icon or '').split('?')[0], 'url': url,
                    'createdAt': d.get('created_utc'), 'raw': {'kind': kind, 'id': d.get('id'), 'created_utc': d.get('created_utc')},
                })
        return out


class XCollector(Collector):
    key = 'x'
    label = 'X (Twitter)'
    env_vars = ('X_BEARER_TOKEN',)
    optional_env = ('X_MAX_LOOKUPS',)
    docs = 'https://docs.x.com/x-api/users/user-lookup-by-usernames'
    access = 'X API bearer token. Pay-per-use: about $0.01 per user returned. Looks up look-alike usernames generated from the brand.'
    cost = 'Paid (pay-per-use)'
    support = 'paid'
    per_query = False

    def search(self, query, brand):
        names = [h for h in handle_variants(brand) if re.fullmatch(r'[A-Za-z0-9_]{1,15}', h)]
        names = names[: int(env('X_MAX_LOOKUPS', '25'))]
        if not names:
            return []
        data = api_request('GET', 'https://api.x.com/2/users/by', source=self.key, min_interval=1.0,
                           headers={'Authorization': f"Bearer {env('X_BEARER_TOKEN')}"},
                           params={'usernames': ','.join(names), 'user.fields': 'description,profile_image_url,public_metrics,created_at,verified,url'})
        out = []
        for user in data.get('data', []):
            followers = (user.get('public_metrics') or {}).get('followers_count', 0)
            out.append({
                'type': 'social', 'platform': 'X', 'name': user.get('name', ''), 'handle': f"@{user.get('username', '')}",
                'externalId': user.get('id') or user.get('username'), 'description': user.get('description', ''),
                'iconUrl': user.get('profile_image_url', ''), 'url': f"https://x.com/{user.get('username', '')}",
                'followers': f'{followers:,} followers', 'createdAt': user.get('created_at', ''), 'website': user.get('url', ''),
                'raw': {k: user.get(k) for k in ('id', 'username', 'created_at', 'verified', 'public_metrics')},
            })
        return out


def _graph_version():
    return env('META_GRAPH_VERSION', 'v23.0')


class InstagramCollector(Collector):
    key = 'instagram'
    label = 'Instagram'
    env_vars = ('INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_BUSINESS_ACCOUNT_ID')
    optional_env = ('INSTAGRAM_MAX_LOOKUPS', 'META_GRAPH_VERSION')
    docs = 'https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery'
    access = ('Instagram Graph API business discovery: an Instagram professional account linked to a Facebook Page, and a token '
              'with instagram_basic and instagram_manage_insights. It can only look up exact usernames of business or creator accounts; '
              'personal accounts are not visible.')
    support = 'approval_required'
    per_query = False

    def search(self, query, brand):
        account = env('INSTAGRAM_BUSINESS_ACCOUNT_ID')
        fields = 'username,name,biography,followers_count,profile_picture_url,website,id'
        out, errors = [], 0
        for handle in handle_variants(brand)[: int(env('INSTAGRAM_MAX_LOOKUPS', '15'))]:
            if not re.fullmatch(r'[a-z0-9_.]{1,30}', handle):
                continue
            try:
                data = api_request('GET', f'https://graph.facebook.com/{_graph_version()}/{account}', source=self.key, min_interval=0.5, retries=1,
                                   params={'fields': f'business_discovery.username({handle}){{{fields}}}', 'access_token': env('INSTAGRAM_ACCESS_TOKEN')})
            except SourceError as exc:
                if exc.status in ('auth_failed', 'rate_limited'):
                    raise
                errors += 1  # 400 = no business account with that username
                continue
            user = data.get('business_discovery') or {}
            if user.get('username'):
                out.append({
                    'type': 'social', 'platform': 'Instagram', 'name': user.get('name') or user['username'], 'handle': f"@{user['username']}",
                    'externalId': user.get('id') or user['username'], 'description': user.get('biography', ''),
                    'iconUrl': user.get('profile_picture_url', ''), 'url': f"https://www.instagram.com/{user['username']}/",
                    'followers': f"{user.get('followers_count', 0):,} followers", 'website': user.get('website', ''),
                    'raw': {k: user.get(k) for k in ('id', 'username', 'followers_count')},
                })
        return out


class ThreadsCollector(Collector):
    key = 'threads'
    label = 'Threads'
    env_vars = ('THREADS_ACCESS_TOKEN',)
    docs = 'https://developers.facebook.com/documentation/threads/keyword-search'
    access = ('Threads API token with threads_basic and threads_keyword_search. Until Meta approves threads_keyword_search, '
              'search only returns your own posts. Limit: 2,200 queries per 24 hours.')
    support = 'approval_required'

    def search(self, query, brand):
        data = api_request('GET', 'https://graph.threads.net/v1.0/keyword_search', source=self.key, min_interval=0.5, params={
            'q': query, 'search_type': 'TOP', 'fields': 'id,text,username,permalink,timestamp', 'access_token': env('THREADS_ACCESS_TOKEN'),
        })
        by_user = {}
        for post in data.get('data', []):
            user = post.get('username')
            if not user or user in by_user:
                continue
            by_user[user] = {
                'type': 'social', 'platform': 'Threads', 'name': user, 'handle': f'@{user}', 'externalId': user,
                'description': post.get('text', '')[:600], 'url': f'https://www.threads.net/@{user}',
                'postUrl': post.get('permalink', ''), 'createdAt': post.get('timestamp', ''),
                'raw': {'postId': post.get('id'), 'permalink': post.get('permalink'), 'timestamp': post.get('timestamp')},
            }
        return list(by_user.values())


class FacebookPagesCollector(Collector):
    key = 'facebook'
    label = 'Facebook Pages'
    env_vars = ('FACEBOOK_ACCESS_TOKEN',)
    optional_env = ('META_GRAPH_VERSION',)
    docs = 'https://developers.facebook.com/docs/pages-api/search-pages/'
    access = 'Pages Search API. Needs a Meta app approved for the "Page Public Metadata Access" feature, and a user or system-user token.'
    support = 'approval_required'

    def search(self, query, brand):
        data = api_request('GET', f'https://graph.facebook.com/{_graph_version()}/pages/search', source=self.key, min_interval=0.5, params={
            'q': query, 'fields': 'id,name,link,verification_status,location', 'access_token': env('FACEBOOK_ACCESS_TOKEN'),
        })
        return [{
            'type': 'social', 'platform': 'Facebook', 'name': page.get('name', ''), 'handle': page.get('id', ''),
            'externalId': page.get('id', ''), 'description': '', 'url': page.get('link') or f"https://www.facebook.com/{page.get('id', '')}",
            'raw': {k: page.get(k) for k in ('id', 'verification_status')},
        } for page in data.get('data', []) if page.get('id')]


class TikTokCollector(UnsupportedCollector):
    key = 'tiktok'
    label = 'TikTok'
    docs = 'https://developers.tiktok.com/products/research-api/'
    access = 'TikTok only offers user search through its Research API, which is limited to approved non-commercial academic research.'


class LinkedInCollector(UnsupportedCollector):
    key = 'linkedin'
    label = 'LinkedIn'
    docs = 'https://learn.microsoft.com/en-us/linkedin/'
    access = 'LinkedIn has no public API for searching companies or people; its APIs only manage organisations you administer.'


class TelegramCollector(UnsupportedCollector):
    key = 'telegram'
    label = 'Telegram'
    docs = 'https://core.telegram.org/api'
    access = ('The Bot API cannot search. Public channel search needs the MTProto client API signed in as a user account '
              '(api_id/api_hash from my.telegram.org), which is not automated here.')
