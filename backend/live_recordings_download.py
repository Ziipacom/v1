"""Bounded, DNS-pinned HTTPS downloads from the fixed Livepeer CDN allowlist.

Provider URLs are never taken from clients or webhooks. Call only after the
authenticated asset/session ownership checks. Redirects and proxy env are unused.
"""
import hashlib
import http.client
import ipaddress
from pathlib import Path
import queue
import re
import socket
import ssl
import threading
import time
from urllib.parse import urlsplit

from live_recordings import MAX_BYTES

HOSTS = frozenset({'livepeercdn.com', 'livepeercdn.studio', 'lp-playback.studio', 'playback.livepeer.studio'})
_DNS_SLOT = threading.BoundedSemaphore(1)


class RecordingDownloadError(RuntimeError):
    pass


def validated_url(value):
    try:
        if not isinstance(value, str) or len(value) > 1500 or any(c in value for c in ('\\', '\r', '\n', '\t', '%')):
            raise ValueError()
        parsed = urlsplit(value)
        if (parsed.scheme != 'https' or parsed.hostname not in HOSTS or parsed.username or parsed.password
                or parsed.port not in (None, 443) or parsed.query or parsed.fragment
                or not re.fullmatch(r'/(asset|recordings)/[A-Za-z0-9_./-]+', parsed.path)
                or '..' in parsed.path.split('/') or '//' in parsed.path):
            raise ValueError()
        return parsed.hostname, parsed.path
    except (ValueError, TypeError):
        raise RecordingDownloadError('Provider download URL is outside the supported direct HTTPS recording paths; use manual import.') from None


def resolve_public(host):
    # socket.getaddrinfo has no portable deadline. At most one daemon resolver
    # exists in this process, even when DNS hangs; callers fail after five seconds.
    if not _DNS_SLOT.acquire(blocking=False):
        raise RecordingDownloadError('Recording DNS resolution is busy; retry later.')
    result = queue.Queue(maxsize=1)
    def lookup():
        try:
            result.put(socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM))
        except Exception:
            result.put(None)
        finally:
            _DNS_SLOT.release()
    threading.Thread(target=lookup, daemon=True, name='ziipa-recording-dns').start()
    try:
        answers = result.get(timeout=5)
        if not answers or len(answers) > 32:
            raise ValueError()
        resolved = []
        for family, _, _, _, address in answers:
            ip = ipaddress.ip_address(address[0])
            if not ip.is_global or (getattr(ip, 'ipv4_mapped', None) and not ip.ipv4_mapped.is_global):
                raise ValueError()
            if family not in (socket.AF_INET, socket.AF_INET6):
                raise ValueError()
            if (family, str(ip)) not in resolved:
                resolved.append((family, str(ip)))
        return resolved
    except (queue.Empty, ValueError, TypeError):
        raise RecordingDownloadError('Recording CDN DNS could not be safely verified.') from None


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, resolved):
        super().__init__(host, port=443, timeout=8, context=ssl.create_default_context())
        self.resolved = resolved

    def connect(self):
        family, ip = self.resolved[0]
        raw = socket.socket(family, socket.SOCK_STREAM)
        raw.settimeout(5)
        try:
            raw.connect((ip, 443))
            if ipaddress.ip_address(raw.getpeername()[0]) != ipaddress.ip_address(ip):
                raise RecordingDownloadError('Recording CDN address changed during connection.')
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
            self.sock.settimeout(8)
        except Exception:
            raw.close()
            raise


def download(value, target: Path):
    host, path = validated_url(value)
    resolved = resolve_public(host)
    connection = PinnedHTTPSConnection(host, resolved)
    deadline = time.monotonic() + 60
    try:
        connection.request('GET', path, headers={'Accept': 'video/mp4', 'Accept-Encoding': 'identity', 'User-Agent': 'Ziipa-PrivateRecording/1'})
        response = connection.getresponse()
        if response.status != 200:
            raise RecordingDownloadError('Direct recording download was unavailable; redirects are not followed.')
        length = response.getheader('Content-Length', '')
        if not re.fullmatch(r'[0-9]{1,12}', length) or not 0 < int(length) <= MAX_BYTES:
            raise RecordingDownloadError('Recording size is absent or exceeds the 100 MiB import limit.')
        if response.getheader('Content-Encoding', 'identity') != 'identity' or response.getheader('Transfer-Encoding'):
            raise RecordingDownloadError('Encoded recording downloads are unsupported.')
        media_type = response.getheader('Content-Type', '').split(';')[0].strip().lower()
        if media_type not in ('video/mp4', 'application/octet-stream'):
            raise RecordingDownloadError('Recording download is not an MP4.')
        digest, size, header = hashlib.sha256(), 0, b''
        with target.open('xb') as output:
            while True:
                if time.monotonic() > deadline:
                    raise RecordingDownloadError('Recording download exceeded its deadline.')
                part = response.read(min(64 * 1024, MAX_BYTES + 1 - size))
                if not part:
                    break
                size += len(part)
                if size > MAX_BYTES or size > int(length):
                    raise RecordingDownloadError('Recording download exceeded its verified byte limit.')
                header = (header + part)[:32]
                output.write(part); digest.update(part)
        from creator import valid_signature
        if size != int(length) or not valid_signature('video/mp4', header):
            raise RecordingDownloadError('Recording download was incomplete or not an MP4.')
        return size, digest.hexdigest()
    except RecordingDownloadError:
        target.unlink(missing_ok=True)
        raise
    except Exception:
        target.unlink(missing_ok=True)
        raise RecordingDownloadError('Recording download failed. No media was imported.') from None
    finally:
        connection.close()
