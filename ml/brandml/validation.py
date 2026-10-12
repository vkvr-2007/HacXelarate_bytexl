"""Brand profile validation: format checks plus optional live existence checks."""
import re
from concurrent.futures import ThreadPoolExecutor

from . import logo
from .sources.base import SourceError, api_request
from .text import handle_key, skeleton

PLATFORMS = {'Instagram', 'X', 'Facebook', 'TikTok', 'LinkedIn', 'YouTube', 'Bluesky', 'Mastodon', 'Telegram', 'Threads'}
HANDLE_RE = re.compile(r'^@?[A-Za-z0-9_.\-]{1,64}(@[A-Za-z0-9.\-]+)?$')
PLAY_RE = re.compile(r'^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$')
IOS_RE = re.compile(r'^(id)?\d{6,12}$')
DOMAIN_RE = re.compile(r'^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$')
COMMON_WORDS = {'apple', 'orange', 'target', 'amazon', 'shell', 'gap', 'zoom', 'slack', 'square', 'notion', 'canva', 'gemini', 'jio', 'booking', 'indigo', 'steam'}


def _check_app(app):
    store, app_id = app.get('store'), (app.get('appId') or '').strip()
    try:
        if store == 'App Store':
            data = api_request('GET', 'https://itunes.apple.com/lookup', source='app_store', min_interval=3.0, retries=1, params={'id': app_id.lstrip('id')})
            results = data.get('results') or []
            if not results:
                return 'not_found', 'No App Store listing with this id'
            seller = results[0].get('sellerName', '')
            return 'verified', f"Found \"{results[0].get('trackName')}\" by {seller}"
        from google_play_scraper import app as play_app
        from google_play_scraper.exceptions import NotFoundError
        try:
            details = play_app(app_id)
        except NotFoundError:
            return 'not_found', 'No Google Play listing with this package'
        return 'verified', f"Found \"{details.get('title')}\" by {details.get('developer')}"
    except SourceError as exc:
        return 'unverified', f'Could not reach the store: {exc}'
    except Exception as exc:
        return 'unverified', f'Could not reach the store: {exc.__class__.__name__}'


def validate(brand, live=True):
    errors, warnings, checks = [], [], []
    name = (brand.get('name') or '').strip()
    if len(name) < 2:
        errors.append({'field': 'name', 'message': 'Brand name is required.'})
    elif len(skeleton(name)) < 4:
        warnings.append({'field': 'name', 'message': 'Short brand names produce noisier look-alike matches. Add aliases or keywords.'})
    if skeleton(name) in COMMON_WORDS:
        warnings.append({'field': 'name', 'message': f'"{name}" is a common word. Add brand keywords so ordinary uses are not flagged.'})

    domain = (brand.get('domain') or '').strip().lower()
    if not domain:
        errors.append({'field': 'domain', 'message': 'Official domain is required.'})
    elif not DOMAIN_RE.match(domain):
        errors.append({'field': 'domain', 'message': f'"{domain}" is not a valid domain.'})

    seen = set()
    socials = brand.get('officialSocials') or []
    if not socials:
        warnings.append({'field': 'officialSocials', 'message': 'No official social accounts: real accounts cannot be excluded from social results.'})
    for i, acct in enumerate(socials):
        handle = (acct.get('handle') or '').strip()
        field = f'officialSocials[{i}]'
        if acct.get('platform') not in PLATFORMS:
            errors.append({'field': field, 'message': f"Unknown platform {acct.get('platform')!r}."})
        if not handle:
            errors.append({'field': field, 'message': 'Handle is empty.'})
        elif not HANDLE_RE.match(handle):
            errors.append({'field': field, 'message': f'"{handle}" is not a valid handle.'})
        key = (acct.get('platform'), handle_key(handle))
        if handle and key in seen:
            warnings.append({'field': field, 'message': f'Duplicate account {handle}.'})
        seen.add(key)

    apps = brand.get('officialApps') or []
    if not apps:
        warnings.append({'field': 'officialApps', 'message': 'No official apps: clone apps cannot be compared with a real listing.'})
    to_check = []
    for i, app in enumerate(apps):
        field = f'officialApps[{i}]'
        app_id = (app.get('appId') or '').strip()
        if app.get('store') == 'Google Play' and not PLAY_RE.match(app_id):
            errors.append({'field': field, 'message': f'"{app_id}" is not a valid Android package name (e.g. com.brand.app).'})
        elif app.get('store') == 'App Store' and not IOS_RE.match(app_id):
            errors.append({'field': field, 'message': f'"{app_id}" is not a valid App Store id (e.g. id1234567890).'})
        else:
            to_check.append((i, app))
        if not (app.get('publisher') or '').strip():
            warnings.append({'field': field, 'message': 'Publisher is empty, so publisher mismatch cannot be detected.'})

    if live and to_check:
        with ThreadPoolExecutor(max_workers=4) as pool:
            for (i, app), (status, message) in zip(to_check, pool.map(lambda pair: _check_app(pair[1]), to_check), strict=False):
                checks.append({'field': f'officialApps[{i}]', 'appId': app.get('appId'), 'status': status, 'message': message})
                if status == 'not_found':
                    errors.append({'field': f'officialApps[{i}]', 'message': f"{app.get('appId')}: {message}."})

    logo_status = None
    if brand.get('logoUrl'):
        logo_status = 'ok' if logo.hashes(brand['logoUrl']) else 'unreadable'
        if logo_status == 'unreadable':
            warnings.append({'field': 'logoUrl', 'message': 'Logo could not be loaded, so logo similarity is turned off.'})
    else:
        warnings.append({'field': 'logoUrl', 'message': 'No logo: add one to detect copied icons and avatars.'})

    return {'valid': not errors, 'errors': errors, 'warnings': warnings, 'checks': checks, 'logo': logo_status}
