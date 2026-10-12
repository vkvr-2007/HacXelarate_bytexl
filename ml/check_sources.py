"""Probe every configured source once and print what really happened.

    python ml/check_sources.py                  # query "Revolut" on every source that has its keys
    python ml/check_sources.py "Acme Pay" bluesky app_store

Run it on a machine with normal internet access after adding keys to .env. It makes real requests, so keep the
brand name ordinary. Exit status is 1 when any source that should have worked did not, which makes it usable in CI.
This is the only way to verify live sources: the automated tests use fakes and never reach the network.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from brandml.envfile import load_env  # noqa: E402

load_env(Path(__file__).resolve().parents[1] / '.env')
from brandml.sources import registry  # noqa: E402

PROBLEMS = {'rate_limited', 'unavailable', 'auth_failed'}


def check(name='Revolut', enabled=None):
    """Return one row per source: key, label, status, count, latency, message."""
    _, statuses = registry.run_collectors({'name': name}, [name], mode='live', enabled=set(enabled) if enabled else None)
    return [{k: s.get(k) for k in ('key', 'label', 'status', 'count', 'latencyMs', 'message')} for s in statuses if s['mode'] == 'live']


def main(argv):
    name = argv[1] if len(argv) > 1 else 'Revolut'
    rows = check(name, argv[2:] or None)
    width = max(len(r['label']) for r in rows)
    for r in rows:
        ms = f"{r['latencyMs']} ms" if r['latencyMs'] is not None else ''
        print(f"{r['label']:<{width}}  {r['status']:<14} {r['count'] or 0:>3} results  {ms:>8}  {r['message'] or ''}")
    bad = [r['label'] for r in rows if r['status'] in PROBLEMS]
    print(f"\n{len(rows) - len(bad)} of {len(rows)} sources OK or intentionally off." + (f" Problems: {', '.join(bad)}" if bad else ''))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
