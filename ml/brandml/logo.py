"""Perceptual-hash logo similarity between candidate icons and official logos."""
import io
import threading
from pathlib import Path

import imagehash
from PIL import Image

from . import safe_http

PUBLIC_DIR = Path(__file__).resolve().parents[2] / 'public'
MAX_BYTES = 2_000_000
MAX_CACHE = 2000
_cache: dict[str, tuple | None] = {}
_lock = threading.Lock()


def _load(ref: str):
    if not ref:
        return None
    if ref.startswith('/'):
        path = (PUBLIC_DIR / ref.lstrip('/')).resolve()
        if PUBLIC_DIR not in path.parents or not path.exists():
            return None
        return Image.open(path)
    if ref.startswith('http://') or ref.startswith('https://'):
        result = safe_http.fetch(ref, timeout=5.0, max_bytes=MAX_BYTES, check_robots=False, accept='image/*')
        if result.status >= 400 or len(result.body) >= MAX_BYTES:
            return None
        Image.MAX_IMAGE_PIXELS = 25_000_000  # refuse decompression bombs
        return Image.open(io.BytesIO(result.body))
    return None


def hashes(ref: str):
    """(phash, dhash) for an image path or URL, or None if it cannot be read."""
    with _lock:
        if ref in _cache:
            return _cache[ref]
    try:
        image = _load(ref)
        value = None
        if image is not None:
            image = image.convert('RGB')
            value = (imagehash.phash(image), imagehash.dhash(image))
    except Exception:
        value = None
    with _lock:
        if len(_cache) >= MAX_CACHE:
            _cache.clear()
        _cache[ref] = value
    return value


def similarity(official_refs, candidate_ref):
    """Best similarity in [0, 1] against any official logo, or None when unknown."""
    cand = hashes(candidate_ref)
    if cand is None:
        return None
    best = None
    for ref in official_refs:
        off = hashes(ref)
        if off is None:
            continue
        p = 1 - (cand[0] - off[0]) / 64
        d = 1 - (cand[1] - off[1]) / 64
        score = round(0.6 * p + 0.4 * d, 3)
        best = score if best is None else max(best, score)
    return best
