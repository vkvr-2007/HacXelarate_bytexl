import socket
import sys
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from brandml.pipeline import MODEL_PATH, Engine  # noqa: E402
from brandml.sources import base  # noqa: E402

NORTHSTAR = {
    'name': 'Northstar', 'domain': 'northstar.com', 'confirmedDomains': ['northstar.com'], 'logoUrl': '/seed-icons/northstar-official.png',
    'description': 'A modern financial platform helping people move money with confidence. Send money, pay bills and track spending.',
    'officialSocials': [{'platform': 'Instagram', 'handle': '@northstar', 'trust': 'confirmed'}, {'platform': 'X', 'handle': '@northstarhq', 'trust': 'confirmed'}, {'platform': 'LinkedIn', 'handle': 'northstar-inc', 'trust': 'confirmed'}],
    'officialApps': [
        {'store': 'App Store', 'name': 'Northstar: Money, made clear', 'appId': 'id6478214501', 'publisher': 'Northstar Financial, Inc.', 'trust': 'confirmed'},
        {'store': 'Google Play', 'name': 'Northstar', 'appId': 'com.northstar.mobile', 'publisher': 'Northstar Financial, Inc.', 'trust': 'confirmed'},
    ],
}


@pytest.fixture(scope='session')
def engine():
    if not MODEL_PATH.exists():
        import train
        train.main()
    return Engine()


@pytest.fixture(autouse=True)
def no_real_network(monkeypatch):
    """Tests never reach the internet. A test that needs HTTP installs a fake with `fake_http`."""
    def refuse(*args, **kwargs):
        raise httpx.ConnectError('network disabled in tests')
    monkeypatch.setattr(httpx, 'request', refuse)
    monkeypatch.setattr(base.time, 'sleep', lambda seconds: None)
    monkeypatch.setattr(base.limiter, 'wait', lambda key, interval: None)


@pytest.fixture
def fake_http(monkeypatch):
    """Route httpx.request(method, url, ...) to handler(method, url, kwargs) -> httpx.Response."""
    calls = []

    def install(handler):
        def request(method, url, **kwargs):
            calls.append((method, url, kwargs))
            response = handler(method, url, kwargs)
            response.request = httpx.Request(method, url)
            return response
        monkeypatch.setattr(httpx, 'request', request)
        return calls
    return install


LOCAL_HOSTS = {'127.0.0.1', '::1', 'localhost'}


@pytest.fixture(autouse=True)
def no_outbound_network(monkeypatch):
    """Tests may talk to local Postgres only. Any other connection or datagram is a bug in the test, not a flaky network."""
    def guarded(name):
        real = getattr(socket.socket, name)

        def wrapper(self, *args, **kwargs):
            address = args[-1] if name == 'sendto' else args[0]
            if isinstance(address, tuple) and address[0] not in LOCAL_HOSTS:
                raise RuntimeError(f'Test tried to reach {address[0]} over the network')
            return real(self, *args, **kwargs)
        monkeypatch.setattr(socket.socket, name, wrapper)
    for call in ('connect', 'connect_ex', 'sendto'):
        guarded(call)
