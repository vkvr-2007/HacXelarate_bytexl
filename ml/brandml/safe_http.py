"""SSRF-safe HTTP fetching for user-supplied or discovered URLs.

Every request to a URL that did not come from a fixed, trusted API host goes
through `fetch`. It only allows http(s) on ports 80/443, resolves the host and
refuses private, loopback, link-local, multicast and reserved addresses, checks
the address actually connected to (DNS rebinding), follows at most three
redirects (each re-validated), caps the body size and honours robots.txt when
asked to.
"""
import ipaddress
import socket
import time
import urllib.robotparser
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

import httpx

USER_AGENT = 'SignalGuardBot/2.0 (+brand-protection; respects robots.txt)'
ALLOWED_PORTS = {80, 443}
MAX_REDIRECTS = 3


class UnsafeURLError(ValueError):
    pass


class RobotsDisallowed(PermissionError):
    pass


@dataclass
class FetchResult:
    url: str
    status: int
    headers: dict
    body: bytes
    fetched_at: float

    def text(self, limit=None):
        data = self.body if limit is None else self.body[:limit]
        return data.decode('utf-8', errors='replace')


def _is_public(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return addr.is_global and not addr.is_multicast


def resolve_public(host: str):
    """Resolve host and return its addresses, or raise if any is not public."""
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise UnsafeURLError(f'Cannot resolve {host}') from exc
    ips = sorted({str(info[4][0]) for info in infos})
    if not ips:
        raise UnsafeURLError(f'Cannot resolve {host}')
    bad = [ip for ip in ips if not _is_public(ip)]
    if bad:
        raise UnsafeURLError(f'{host} resolves to a non-public address')
    return ips


def validate_url(url: str):
    parts = urlsplit(url)
    if parts.scheme not in ('http', 'https'):
        raise UnsafeURLError('Only http and https URLs are allowed')
    if not parts.hostname:
        raise UnsafeURLError('URL has no host')
    if parts.username or parts.password:
        raise UnsafeURLError('Credentials in URLs are not allowed')
    port = parts.port or (443 if parts.scheme == 'https' else 80)
    if port not in ALLOWED_PORTS:
        raise UnsafeURLError('Only ports 80 and 443 are allowed')
    host = parts.hostname
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if host.endswith(('.local', '.internal', '.localhost')) or host == 'localhost':
            raise UnsafeURLError('Internal host names are not allowed') from None
        return parts, resolve_public(host)
    if not _is_public(host):
        raise UnsafeURLError('Private or reserved IP addresses are not allowed')
    return parts, [host]


def pinned_request_target(url: str):
    """Validate a URL and return (ip_url, host_header, sni_host).

    The request is sent to the address that was validated, so a DNS answer that
    changes between the check and the connection cannot redirect it to a private
    address. Host and TLS server name keep the original host name.
    """
    parts, ips = validate_url(url)
    host = parts.hostname
    ip = ips[0]
    netloc_ip = f'[{ip}]' if ':' in ip else ip
    port = f':{parts.port}' if parts.port else ''
    ip_url = parts._replace(netloc=f'{netloc_ip}{port}').geturl()
    host_header = host if not parts.port else f'{host}:{parts.port}'
    return ip_url, host_header, (host if parts.scheme == 'https' and host != ip else None)


_robots: dict[str, tuple[float, urllib.robotparser.RobotFileParser]] = {}


def robots_allowed(url: str, timeout=5.0) -> bool:
    parts = urlsplit(url)
    origin = f'{parts.scheme}://{parts.netloc}'
    entry = _robots.get(origin)
    if entry is None or time.time() - entry[0] > 3600:
        parser = urllib.robotparser.RobotFileParser()
        try:
            result = fetch(origin + '/robots.txt', timeout=timeout, max_bytes=200_000, check_robots=False)
            if result.status >= 400:
                parser.parse([])  # no robots.txt: everything allowed
            else:
                parser.parse(result.text().splitlines())
        except (httpx.HTTPError, UnsafeURLError):
            parser.parse([])
        entry = (time.time(), parser)
        _robots[origin] = entry
    return entry[1].can_fetch(USER_AGENT, url)


def fetch(url: str, timeout=8.0, max_bytes=1_500_000, check_robots=True, accept='text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5', method='GET', json_body=None):
    """GET (or POST JSON to) a URL safely. Raises UnsafeURLError, RobotsDisallowed or httpx.HTTPError."""
    current = url
    with httpx.Client(timeout=timeout, follow_redirects=False, trust_env=False, headers={'User-Agent': USER_AGENT, 'Accept': accept}) as client:
        for _ in range(MAX_REDIRECTS + 1):
            ip_url, host_header, sni = pinned_request_target(current)
            if check_robots and not robots_allowed(current):
                raise RobotsDisallowed(f'robots.txt disallows {current}')
            extensions = {'sni_hostname': sni} if sni else {}
            with client.stream(method, ip_url, headers={'Host': host_header}, extensions=extensions, json=json_body) as response:
                stream = response.extensions.get('network_stream')
                peer = stream.get_extra_info('server_addr') if stream else None
                if peer and not _is_public(peer[0]):
                    raise UnsafeURLError('Connected to a non-public address')
                if response.is_redirect and method == 'GET':
                    location = response.headers.get('location')
                    if not location:
                        raise UnsafeURLError('Redirect without a location')
                    current = urljoin(current, location)
                    continue
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > max_bytes:
                        break
                return FetchResult(current, response.status_code, dict(response.headers), bytes(body[:max_bytes]), time.time())
    raise UnsafeURLError('Too many redirects')
