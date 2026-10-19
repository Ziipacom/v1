"""No network: verify fixed-host URL grammar, DNS pinning and bounded bodies."""
import io
import socket
from types import SimpleNamespace

import pytest

import app  # shared app/router import convention
import live_recordings_download as download

VALID = 'https://livepeercdn.com/asset/known/video/download.mp4'
DATA = b'\x00\x00\x00\x18ftypmp42' + b'x' * 100


@pytest.mark.parametrize('url', [
    'http://livepeercdn.com/asset/id/video', 'https://127.0.0.1/asset/id/video',
    'https://livepeercdn.com.evil.example/asset/id/video', 'https://evil.livepeercdn.com/asset/id/video',
    'https://user:pass@livepeercdn.com/asset/id/video', 'https://livepeercdn.com:444/asset/id/video',
    'https://livepeercdn.com/asset/../admin', 'https://livepeercdn.com/asset/%2e%2e/admin',
    'https://livepeercdn.com/asset//id/video', 'https://livepeercdn.com/private/admin',
    VALID + '?token=private', VALID + '#fragment', VALID + '\r\nHost: evil', None,
])
def test_reject_unsafe_urls(url):
    with pytest.raises(download.RecordingDownloadError):
        download.validated_url(url)


@pytest.mark.parametrize('ip', ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fd00::1', '::ffff:127.0.0.1'])
def test_reject_private_dns_and_mixed_public_private(monkeypatch, ip):
    family = socket.AF_INET6 if ':' in ip else socket.AF_INET
    monkeypatch.setattr(download.socket, 'getaddrinfo', lambda *args, **kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('1.1.1.1', 443)),
        (family, socket.SOCK_STREAM, 6, '', (ip, 443))])
    with pytest.raises(download.RecordingDownloadError):
        download.resolve_public('livepeercdn.com')


def test_pinned_socket_connects_numeric_address_and_tls_uses_original_host(monkeypatch):
    calls = []
    class Socket:
        def settimeout(self, value): pass
        def connect(self, address): calls.append(('connect', address))
        def getpeername(self): return ('1.1.1.1', 443)
        def close(self): pass
    class Context:
        check_hostname = True
        def wrap_socket(self, raw, server_hostname):
            calls.append(('tls', server_hostname)); return raw
    monkeypatch.setattr(download.socket, 'socket', lambda *args: Socket())
    monkeypatch.setattr(download.ssl, 'create_default_context', lambda: Context())
    connection = download.PinnedHTTPSConnection('livepeercdn.com', [(socket.AF_INET, '1.1.1.1')])
    connection.connect()
    assert calls == [('connect', ('1.1.1.1', 443)), ('tls', 'livepeercdn.com')]


@pytest.fixture
def transport(monkeypatch):
    state = SimpleNamespace(status=200, data=DATA,
        headers={'Content-Length': str(len(DATA)), 'Content-Type': 'video/mp4'}, requests=[])
    monkeypatch.setattr(download, 'resolve_public', lambda host: [(socket.AF_INET, '1.1.1.1')])
    class Connection:
        def __init__(self, host, addresses):
            assert host == 'livepeercdn.com' and addresses == [(socket.AF_INET, '1.1.1.1')]
        def request(self, method, path, headers): state.requests.append((method, path, headers))
        def getresponse(self):
            body = io.BytesIO(state.data)
            return SimpleNamespace(status=state.status, getheader=lambda key, default=None: state.headers.get(key, default), read=body.read)
        def close(self): pass
    monkeypatch.setattr(download, 'PinnedHTTPSConnection', Connection)
    return state


@pytest.mark.parametrize('failure', ['redirect', 'oversized', 'no-length', 'encoded', 'chunked', 'wrong-type', 'truncated', 'wrong-magic'])
def test_download_rejects_unsupported_response_and_cleans_partial_file(tmp_path, transport, failure):
    if failure == 'redirect': transport.status = 302
    if failure == 'oversized': transport.headers['Content-Length'] = str(download.MAX_BYTES + 1)
    if failure == 'no-length': transport.headers.pop('Content-Length')
    if failure == 'encoded': transport.headers['Content-Encoding'] = 'gzip'
    if failure == 'chunked': transport.headers['Transfer-Encoding'] = 'chunked'
    if failure == 'wrong-type': transport.headers['Content-Type'] = 'text/html'
    if failure == 'truncated': transport.data = DATA[:-5]
    if failure == 'wrong-magic': transport.data = b'z' * len(DATA)
    target = tmp_path / 'download.mp4'
    with pytest.raises(download.RecordingDownloadError):
        download.download(VALID, target)
    assert not target.exists()
    assert len(transport.requests) == 1


def test_download_is_streamed_exact_length_and_never_sends_provider_credentials(tmp_path, transport):
    target = tmp_path / 'download.mp4'
    size, digest = download.download(VALID, target)
    assert size == len(DATA) and len(digest) == 64 and target.read_bytes() == DATA
    headers = transport.requests[0][2]
    assert 'Authorization' not in headers and 'Cookie' not in headers
