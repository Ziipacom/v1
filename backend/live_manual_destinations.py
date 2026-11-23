"""Build a relay URL from encoder credentials issued to an eligible creator.

The URL is secret and must only be sent to the relay provider. A valid shape
doesn't establish account eligibility, successful ingest, or public playback.
"""

import re
from urllib.parse import unquote


class ManualLiveError(RuntimeError):
    """A sanitized error that never includes encoder credentials."""


# Instagram Live Producer and BytePlus's documented TikTok Live relay shape.
# Regional TikTok hosts stay within a single provider-owned DNS label.
_SERVERS = {
    'instagram': re.compile(r'rtmps://live-upload\.instagram\.com(?::443)?/rtmp/?', re.ASCII),
    'tiktok': re.compile(
        r'rtmps://push-rtmp-[a-z0-9](?:[a-z0-9-]{0,51}[a-z0-9])?\.tiktokcdn\.com(?::443)?/game/?',
        re.ASCII,
    ),
}
_KEYS = {
    'instagram': re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{7,255}', re.ASCII),
    'tiktok': re.compile(r'stream-[A-Za-z0-9][A-Za-z0-9_-]{3,248}', re.ASCII),
}
_INSTAGRAM_PARAMETER = re.compile(r'a|s_[a-z0-9_]{1,36}', re.ASCII)
_TIKTOK_PARAMETERS = frozenset({
    'amun', 'c', 'dsnp', 'expire', 'l_region', 'rtcRoomId', 'rtcStreamId',
    'rtcStreamToken', 'rtcToken', 'rtcUserId', 'sign', 'th_region',
})
_SIGNED_VALUE = re.compile(r'(?:[A-Za-z0-9_.~+=-]|%[0-9A-Fa-f]{2}){1,1024}', re.ASCII)
_DECODED_VALUE = re.compile(r'[A-Za-z0-9_./~+=-]+', re.ASCII)


def _valid_query(provider: str, query: str) -> bool:
    parts = query.split('&')
    if len(parts) > 32:
        return False
    names = set()
    for part in parts:
        name, equals, value = part.partition('=')
        allowed = (
            _INSTAGRAM_PARAMETER.fullmatch(name) is not None
            if provider == 'instagram' else name in _TIKTOK_PARAMETERS
        )
        if (
            not equals or not allowed or name in names
            or not _SIGNED_VALUE.fullmatch(value)
            or not _DECODED_VALUE.fullmatch(unquote(value))
        ):
            return False
        names.add(name)
    return True


def manual_ingest(provider: str, ingest_url: str, stream_key: str) -> str:
    """Accept only a secure producer URL and its separate, session-specific key."""
    server = _SERVERS.get(provider)
    if not server:
        raise ManualLiveError('This destination does not accept manual live credentials.')
    if (
        not isinstance(ingest_url, str) or len(ingest_url) > 180
        or not server.fullmatch(ingest_url)
    ):
        raise ManualLiveError('Enter the secure server URL shown in this network’s live producer.')
    if not isinstance(stream_key, str) or not stream_key or len(stream_key) > 4096:
        raise ManualLiveError('Enter the fresh stream key shown in this network’s live producer.')
    key, separator, query = stream_key.partition('?')
    if not _KEYS[provider].fullmatch(key) or (separator and not _valid_query(provider, query)):
        raise ManualLiveError('Enter the fresh stream key shown in this network’s live producer.')
    # Preserve the signed key exactly. Parsing is only for validation.
    return ingest_url.rstrip('/') + '/' + stream_key
