"""Synthetic labelled data for training the impersonation ranker.

Positives are generated with the techniques impersonators use (character swaps,
typos, homoglyphs, leetspeak, spacing changes, added words, cloned logos,
copied descriptions, a different publisher). Negatives include unrelated
accounts, benign names that share part of the brand, commentary pages, and
legitimate secondary apps from the official publisher, so the model learns
not to over-flag normal names.
"""
import random

from .features import BrandContext, extract, vector

SECTORS = {
    'fintech': ('Send money, pay bills and manage your account with secure mobile banking and instant transfers.', ['wallet', 'pay', 'cash', 'invest']),
    'retail': ('Shop the latest collections, track orders and get member-only offers on clothing and footwear.', ['outlet', 'deals', 'store', 'sale']),
    'streaming': ('Stream music, podcasts and playlists on every device with personalised recommendations.', ['premium', 'plus', 'free', 'unlock']),
    'crypto': ('Buy, sell and trade bitcoin and other digital assets on a secure exchange.', ['airdrop', 'wallet', 'token', 'giveaway']),
    'travel': ('Book flights, manage reservations and check in online with your loyalty account.', ['rewards', 'vip', 'deals', 'support']),
    'telecom': ('Manage your mobile plan, pay your bill and check data usage in one place.', ['recharge', 'support', 'offers', 'care']),
    'food': ('Order food delivery from local restaurants and track your order in real time.', ['coupons', 'deals', 'rewards', 'free']),
    'software': ('Productivity and collaboration tools for teams to plan, build and ship work.', ['pro', 'login', 'update', 'support']),
}

# The fictional demo brand (Northstar) is deliberately absent: the demo benchmark must score a brand the model never saw.
BRANDS = [
    'NovaPay', 'Spotify', 'PayPal', 'Netflix', 'Binance', 'Coinbase', 'Revolut', 'Venmo',
    'Zelle', 'Stripe', 'Klarna', 'Monzo', 'Paytm', 'PhonePe', 'Razorpay', 'Robinhood', 'Wise',
    'Nike', 'Adidas', 'Zara', 'Uniqlo', 'Walmart', 'Amazon', 'Flipkart', 'Myntra', 'Target', 'Ikea',
    'Sephora', 'Gucci', 'Puma', 'Reebok', 'Deezer', 'Tidal', 'Hulu', 'Disney', 'Twitch', 'Roblox',
    'Steam', 'Kraken', 'Bybit', 'Kucoin', 'Gemini', 'Phantom', 'Metamask', 'Ledger', 'Trezor',
    'Emirates', 'Lufthansa', 'Airbnb', 'Booking', 'Expedia', 'Uber', 'Lyft', 'Ryanair', 'Indigo',
    'Vodafone', 'Verizon', 'Airtel', 'Jio', 'Tmobile', 'Orange', 'Telstra', 'Swiggy', 'Zomato',
    'Doordash', 'Grubhub', 'Deliveroo', 'Starbucks', 'Dominos', 'Slack', 'Zoom', 'Notion', 'Canva',
    'Dropbox', 'Figma', 'Asana', 'Trello', 'Atlassian', 'Shopify', 'Salesforce', 'Adobe', 'Oracle',
    'Samsung', 'Xiaomi', 'Lenovo', 'Dell', 'Intel', 'Nvidia', 'Tesla', 'Rivian', 'Toyota', 'Honda',
    'Brightwave', 'Lumora', 'Quantis', 'Veridian', 'Corvexa', 'Halcyon', 'Zentrix', 'Orbitly',
    'Kindlepath', 'Marlowe', 'Tessaro', 'Fintrova', 'Skyvault', 'Pinecrest', 'Auralink', 'Cobaltix',
    'Driftly', 'Evergrid', 'Glimmer', 'Hexapay', 'Ironleaf', 'Jadeport', 'Kestrel', 'Loomio',
]

UNRELATED_NAMES = [
    'Morning Brew Coffee', 'Sunset Yoga Studio', 'Pixel Forge Games', 'Green Valley Farms', 'Urban Sketchers',
    'Daily Math Puzzles', 'River City Runners', 'Blue Lagoon Travel', 'Code Academy Kids', 'Harbor Fitness',
    'Photo Filter Studio', 'Recipe Box', 'Habit Tracker Pro', 'Weather Now', 'Calm Breathing',
    'Chess Master', 'Budget Planner', 'Plant Care Guide', 'Language Buddy', 'Sleep Sounds',
    'Garden Journal', 'Retro Arcade', 'Night Sky Map', 'Quick Notes', 'Bus Times Live', 'Meal Prep Ideas',
    'Local News Today', 'Cricket Scores', 'Guitar Tuner', 'Podcast Picks', 'Mindful Moments', 'Pet Vet Help',
]

UNRELATED_DESCRIPTIONS = [
    'Simple tools to plan your day and build better habits.',
    'Fresh recipes and step-by-step cooking videos every week.',
    'Live scores, fixtures and news from your favourite teams.',
    'Relaxing sounds and stories to help you fall asleep.',
    'Learn a new language with short daily lessons.',
    'Photos from our neighbourhood bakery and weekend specials.',
    'Local community updates, events and volunteering.',
    'Indie game studio sharing devlogs and screenshots.',
]

SCAM_BIOS = [
    'Official {b} support. DM us your account number for instant recovery and refunds.',
    '{b} anniversary giveaway! Claim your free gift card now, limited time only. Link below.',
    'Verify your {b} account to avoid suspension. Contact our helpline on WhatsApp.',
    '{b} VIP rewards: double your crypto deposit with our guaranteed investment program.',
    'Hiring now at {b}! Remote jobs, high salary. Send your details via Telegram.',
    'Get {b} premium unlocked for free. Download the mod from our site.',
    '{b} customer care 24x7 toll free helpline. Share OTP to verify.',
]

NEUTRAL_IMPOSTER_BIOS = [
    'Updates and news from the {b} team.',
    'The best place for {b} offers and announcements.',
    '{b} for everyone. Fast, simple and secure.',
    '',
]

BENIGN_FAN_BIOS = [
    'Unofficial fan page. Not affiliated with {b}. Memes and news.',
    'Independent reviews and comparisons, including {b} and competitors.',
    'Tracking {b} stock price and earnings. Not financial advice.',
    'Community forum for {b} users to share tips. Not run by {b}.',
]

IMPERSONATION_SUFFIXES = [
    'Support', 'Help Desk', 'Official', 'Care', 'Customer Service', 'Rewards', 'Giveaway', 'Wallet',
    'Pay', 'Pro', 'Plus', 'Premium', 'Login', 'Verify', 'Refund', 'HQ', 'Team', 'VIP', 'Careers',
    'Deals', 'Outlet', 'Connect', 'Lite', 'Global', 'Recovery', 'Airdrop', 'Investment',
]
# Ordinary sector words impersonators also use. They are not in IMPERSONATION_WORDS,
# so the model must learn that an unknown extra word does not make a name safe.
GENERIC_WORDS = ['Finance', 'Loans', 'Bank', 'Money', 'Investments', 'Trade', 'Exchange', 'Music', 'Shop',
                 'Travel', 'Express', 'Direct', 'Now', 'Hub', 'Point', 'Zone', 'World', 'Club', 'Live', 'Group']
GENERIC_DESCRIPTIONS = [
    'Instant loans approved in minutes. No credit check.',
    'Fast, simple and secure transfers for everyone.',
    'Download now and get started in seconds.',
    'Best prices, daily offers and quick delivery.',
    'Join thousands of happy users today.',
]
IMPERSONATION_PREFIXES = ['Official', 'Real', 'Verified', 'The', 'My', 'Get', 'Free', 'Secure']
BENIGN_SUFFIXES = ['Fan Club', 'Fans', 'News', 'Reviews', 'Memes', 'Tracker', 'Stats', 'Community', 'Forum']
HANDLE_SEPARATORS = ['', '_', '.', '-']

HOMOGLYPH_SWAPS = {'a': ['а', 'ɑ', 'α'], 'e': ['е'], 'o': ['о', 'ο', '0'], 'p': ['р'], 'c': ['с'], 'i': ['і', '1', 'l'],
                   'l': ['1', 'I', 'ӏ'], 's': ['ѕ', '5'], 'x': ['х'], 'y': ['у'], 'm': ['rn'], 'w': ['vv']}


def typo(rng, word):
    w = list(word)
    if len(w) < 3:
        return word
    op = rng.choice(['swap', 'delete', 'insert', 'replace', 'double'])
    i = rng.randrange(1, len(w) - 1)
    if op == 'swap':
        w[i], w[i + 1] = w[i + 1], w[i]
    elif op == 'delete':
        del w[i]
    elif op == 'insert':
        w.insert(i, rng.choice('aeiounrst'))
    elif op == 'replace':
        w[i] = rng.choice('aeiounrstlm')
    else:
        w.insert(i, w[i])
    out = ''.join(w)
    return out if out.lower() != word.lower() else word + 'z'


def homoglyph(rng, word):
    positions = [i for i, ch in enumerate(word.lower()) if ch in HOMOGLYPH_SWAPS]
    if not positions:
        return typo(rng, word)
    out = list(word)
    for i in rng.sample(positions, k=min(len(positions), rng.choice([1, 1, 2]))):
        out[i] = rng.choice(HOMOGLYPH_SWAPS[word[i].lower()])
    return ''.join(out)


def spacing(rng, word):
    if len(word) < 5:
        return word[:2] + rng.choice([' ', '-', '.', '_']) + word[2:]
    cut = rng.randrange(2, len(word) - 2)
    return word[:cut] + rng.choice([' ', '-', '.', '_', ' ']) + word[cut:]


def make_handle(rng, name):
    sep = rng.choice(HANDLE_SEPARATORS)
    parts = [p for p in name.replace('-', ' ').replace('.', ' ').split() if p]
    return '@' + sep.join(p.lower() for p in parts)


def brand_profile(rng, name):
    sector = rng.choice(list(SECTORS))
    description, _ = SECTORS[sector]
    slug = name.lower()
    return sector, {
        'name': name,
        'domain': f'{slug}.com',
        'description': description,
        'officialSocials': [{'platform': 'Instagram', 'handle': f'@{slug}'}, {'platform': 'X', 'handle': f'@{slug}hq'}],
        'officialApps': [{'store': 'Google Play', 'name': name, 'appId': f'com.{slug}.app', 'publisher': f'{name} Technologies Inc.'}],
    }


def positive_name(rng, brand, sector):
    words = SECTORS[sector][1]
    technique = rng.choice(['typo', 'homoglyph', 'spacing', 'suffix', 'prefix', 'suffix_typo', 'exact', 'joined', 'leet_suffix'])
    if technique == 'typo':
        return typo(rng, brand), technique
    if technique == 'homoglyph':
        return homoglyph(rng, brand), technique
    if technique == 'spacing':
        return spacing(rng, brand), technique
    if technique == 'suffix':
        return f'{brand} {rng.choice(IMPERSONATION_SUFFIXES + GENERIC_WORDS + [w.title() for w in words])}', technique
    if technique == 'prefix':
        return f'{rng.choice(IMPERSONATION_PREFIXES)} {brand}', technique
    if technique == 'suffix_typo':
        return f'{typo(rng, brand)} {rng.choice(IMPERSONATION_SUFFIXES + GENERIC_WORDS)}', technique
    if technique == 'joined':
        return f'{brand}{rng.choice(IMPERSONATION_SUFFIXES).replace(" ", "")}', technique
    if technique == 'leet_suffix':
        return f'{homoglyph(rng, brand)} {rng.choice(IMPERSONATION_SUFFIXES + GENERIC_WORDS)}', technique
    return brand, technique


def benign_name(rng, brand, others):
    technique = rng.choice(['unrelated', 'other_brand', 'fan', 'partial', 'context', 'short_overlap'])
    if technique == 'unrelated':
        return rng.choice(UNRELATED_NAMES), technique
    if technique == 'other_brand':
        other = rng.choice(others)
        return rng.choice([other, f'{other} Support', typo(rng, other)]), technique
    if technique == 'fan':
        return f'{brand} {rng.choice(BENIGN_SUFFIXES)}', technique
    if technique == 'partial':
        # Shares a prefix only, e.g. "North Shore Bakery" for Northstar.
        cut = max(3, len(brand) // 2)
        return f'{brand[:cut].title()}{rng.choice(["field", "shore", "gate", "wood", "ville", "berg"])} {rng.choice(["Bakery", "Dental", "Realty", "Motors", "Studio", "Farm"])}', technique
    if technique == 'context':
        word = rng.choice(UNRELATED_NAMES).split()[0]
        return f'{word} {brand[:3].title()}{rng.choice(["ville", "wood", "field", "haven", "ridge"])}', technique
    return f'{brand[:3].title()}{rng.choice(["mo", "ra", "lix", "dan"])} {rng.choice(["Games", "Labs", "Kitchen"])}', technique


def candidate(rng, ctx, name, is_app, label, technique, sector):
    brand = ctx.names[0]
    if label:
        roll = rng.random()
        if roll < 0.45:
            description = rng.choice(SCAM_BIOS).format(b=brand)
        elif roll < 0.6:
            description = rng.choice(GENERIC_DESCRIPTIONS)
        elif roll < 0.85:
            description = rng.choice(NEUTRAL_IMPOSTER_BIOS).format(b=brand)
        else:
            description = ctx.brand['description']
        logo = rng.uniform(0.75, 1.0) if rng.random() < 0.5 else rng.uniform(0.25, 0.8)
        publisher = rng.choice(['Apex Digital Labs', 'Star Mobile Apps', 'Blue Cloud Studios', f'{brand} Apps Ltd', 'Global Dev Team', 'N. Media'])
    else:
        if technique == 'fan':
            description = rng.choice(BENIGN_FAN_BIOS).format(b=brand)
        elif rng.random() < 0.15:
            # Scammy wording about something else: scam words alone must not flag a brand match.
            description = rng.choice(SCAM_BIOS).format(b=rng.choice(UNRELATED_NAMES))
        else:
            description = rng.choice(UNRELATED_DESCRIPTIONS)
        logo = rng.uniform(0.15, 0.82)
        publisher = rng.choice(['Morning Labs', 'Indie Dev Co', 'Harbor Apps', 'Green Valley LLC', 'Pixel Forge'])
    if rng.random() < 0.35:
        logo = None
    cand = {
        'type': 'app' if is_app else 'social',
        'name': name,
        'handle': '' if is_app else make_handle(rng, name),
        'description': description,
        'publisher': publisher if is_app else '',
        'logoSimilarity': logo,
    }
    if label and rng.random() < 0.3:
        cand['description'] += f' Visit {brand.lower()}-secure-login.top'
    return cand


def official_publisher_app(rng, ctx):
    """A secondary app from the real publisher: must not be flagged."""
    brand = ctx.names[0]
    return {
        'type': 'app',
        'name': f'{brand} {rng.choice(["Business", "Merchant", "Lite", "Kids", "Studio", "Go"])}',
        'description': ctx.brand['description'],
        'publisher': ctx.brand['officialApps'][0]['publisher'],
        'logoSimilarity': rng.uniform(0.85, 1.0),
    }


def generate(seed=7, per_brand=48):
    rng = random.Random(seed)
    rows = []
    for brand in BRANDS:
        sector, profile = brand_profile(rng, brand)
        ctx = BrandContext(profile)
        others = [b for b in BRANDS if b != brand]
        for _ in range(per_brand // 2):
            is_app = rng.random() < 0.45
            name, technique = positive_name(rng, brand, sector)
            cand = candidate(rng, ctx, name, is_app, 1, technique, sector)
            if technique == 'exact' and not is_app:
                cand['handle'] = make_handle(rng, f'{brand} {rng.choice(IMPERSONATION_SUFFIXES)}')
            rows.append((brand, extract(ctx, cand), 1, technique))
        for _ in range(per_brand // 2 - 3):
            is_app = rng.random() < 0.45
            name, technique = benign_name(rng, brand, others)
            cand = candidate(rng, ctx, name, is_app, 0, technique, sector)
            rows.append((brand, extract(ctx, cand), 0, technique))
        for _ in range(3):
            rows.append((brand, extract(ctx, official_publisher_app(rng, ctx)), 0, 'official_publisher'))
    # A little label noise so the model does not learn brittle, perfectly separable rules.
    rows = [(b, f, (1 - label) if rng.random() < 0.02 else label, t) for b, f, label, t in rows]
    groups = [r[0] for r in rows]
    X = [vector(r[1]) for r in rows]
    y = [r[2] for r in rows]
    techniques = [r[3] for r in rows]
    return X, y, groups, techniques
