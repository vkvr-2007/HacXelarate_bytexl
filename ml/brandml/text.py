"""Text normalisation and look-alike helpers shared by training and inference."""
import re
import unicodedata

# Visually confusable characters mapped to the ASCII letter they imitate.
HOMOGLYPHS = {
    # Cyrillic
    'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p',
    'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ѕ': 's', 'і': 'i', 'ј': 'j', 'ӏ': 'l', 'ԁ': 'd',
    'ԛ': 'q', 'ԝ': 'w', 'ү': 'y',
    # Greek
    'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p',
    'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w',
    # Latin look-alikes
    'ɑ': 'a', 'ɡ': 'g', 'ı': 'i', 'ł': 'l', 'ø': 'o', 'ß': 'ss', 'đ': 'd', 'ħ': 'h', 'ŀ': 'l',
}

# Leetspeak and confusable sequences, applied after folding. Ambiguous glyphs
# (1, i, l, |) collapse to one class so "paypa1" and "paypai" both match "paypal".
SKELETON_RULES = [
    ('rn', 'm'), ('vv', 'w'), ('0', 'o'), ('1', 'l'), ('|', 'l'), ('i', 'l'), ('!', 'l'),
    ('3', 'e'), ('4', 'a'), ('@', 'a'), ('5', 's'), ('$', 's'), ('7', 't'), ('8', 'b'), ('9', 'g'),
]

# Words impersonators bolt onto a brand name.
IMPERSONATION_WORDS = {
    'support', 'help', 'helpdesk', 'desk', 'care', 'customer', 'service', 'services', 'official',
    'offical', 'team', 'hq', 'real', 'verified', 'verify', 'secure', 'security', 'login', 'signin',
    'account', 'accounts', 'recovery', 'refund', 'refunds', 'rewards', 'reward', 'giveaway',
    'giveaways', 'promo', 'promos', 'bonus', 'gift', 'gifts', 'prize', 'vip', 'wallet', 'pay',
    'cash', 'invest', 'investment', 'crypto', 'airdrop', 'token', 'claim', 'app', 'apps', 'mobile',
    'pro', 'plus', 'premium', 'lite', 'online', 'global', 'inc', 'ltd', 'llc', 'careers', 'hiring',
    'jobs', 'recruit', 'recruitment', 'deals', 'outlet', 'sale', 'store', 'shop', 'connect', 'fast',
    'update', 'center', 'centre', 'assist', 'agent', 'unlock', 'free',
}

# Words that usually mark commentary or unrelated use rather than impersonation.
BENIGN_CONTEXT_WORDS = {
    'fan', 'fans', 'fanpage', 'club', 'news', 'review', 'reviews', 'blog', 'parody', 'memes',
    'tracker', 'watch', 'stats', 'unofficial', 'community', 'forum', 'guide', 'tips', 'history',
    'museum', 'school', 'church', 'farm', 'bakery', 'cafe', 'restaurant', 'hotel', 'motors',
    'realty', 'dental', 'clinic', 'county', 'university', 'college', 'band', 'photography',
}

SCAM_WORDS = {
    'giveaway', 'airdrop', 'claim', 'refund', 'recovery', 'recover', 'dm', 'whatsapp', 'telegram',
    'double', 'doubling', 'investment', 'invest', 'profit', 'guaranteed', 'crypto', 'bitcoin',
    'usdt', 'winner', 'won', 'prize', 'free', 'bonus', 'verify', 'verification', 'suspended',
    'unlock', 'urgent', 'limited', 'hurry', 'gift', 'voucher', 'otp', 'password', 'pin', 'loan',
    'instant', 'helpline', 'hotline', 'tollfree', 'contact', 'cashback', 'earn', 'hiring', 'salary',
}

URL_RE = re.compile(r'(https?://[^\s]+|www\.[^\s]+|\b[a-z0-9-]+\.(?:com|net|org|io|app|xyz|top|site|online|info|link|ly|me)\b[^\s]*)', re.I)
TOKEN_SPLIT_RE = re.compile(r'[^a-z0-9]+')
CAMEL_RE = re.compile(r'(?<=[a-z])(?=[A-Z])')


def fold(value: str) -> str:
    """Lower-case, NFKC-normalise, map homoglyphs and strip accents."""
    if not value:
        return ''
    text = unicodedata.normalize('NFKC', str(value))
    text = CAMEL_RE.sub(' ', text).lower()
    text = ''.join(HOMOGLYPHS.get(ch, ch) for ch in text)
    text = unicodedata.normalize('NFKD', text)
    return ''.join(ch for ch in text if not unicodedata.combining(ch))


def compact(value: str) -> str:
    """Folded text with spaces, dots, underscores and punctuation removed."""
    return re.sub(r'[^a-z0-9|!@$]', '', fold(value))


def skeleton(value: str) -> str:
    """Compact text with leetspeak and confusable sequences collapsed."""
    text = compact(value)
    for source, target in SKELETON_RULES:
        text = text.replace(source, target)
    return re.sub(r'[^a-z]', '', text)


def tokens(value: str) -> list:
    return [token for token in TOKEN_SPLIT_RE.split(fold(value)) if token]


def has_homoglyph(value: str) -> bool:
    """True when the raw string uses non-ASCII letters that fold to ASCII."""
    if not value:
        return False
    for ch in unicodedata.normalize('NFKC', str(value)):
        if ord(ch) > 127 and ch.isalpha():
            folded = fold(ch)
            if folded and folded.isascii():
                return True
    return False


def has_leet(value: str) -> bool:
    raw = fold(value)
    return bool(re.search(r'[a-z][0134579@$|!][a-z]|[a-z][0134579@$|!]$', raw))


def extract_urls(value: str) -> list:
    return URL_RE.findall(value or '')


def handle_key(value: str) -> str:
    """Canonical form of a social handle for exact allowlist matching."""
    text = (value or '').strip().lower()
    text = re.sub(r'^https?://(www\.)?[^/]+/', '', text)
    text = text.lstrip('@').rstrip('/')
    return text
