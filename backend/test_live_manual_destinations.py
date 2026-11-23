import pytest

from live_manual_destinations import ManualLiveError, manual_ingest


INSTAGRAM = 'rtmps://live-upload.instagram.com:443/rtmp/'
TIKTOK = 'rtmps://push-rtmp-test-edge.tiktokcdn.com:443/game/'


@pytest.mark.parametrize(('provider', 'server', 'key'), [
    ('instagram', INSTAGRAM, '17900000000000001?s_sw=0&s_vt=ig&a=demoSignature'),
    ('tiktok', TIKTOK.rstrip('/'), 'stream-123456789?amun=true&rtcToken=fake%2Fvalue%3D&sign=demo'),
])
def test_preserves_the_signed_key(provider, server, key):
    assert manual_ingest(provider, server, key) == server.rstrip('/') + '/' + key


@pytest.mark.parametrize('server', [
    'rtmp://live-upload.instagram.com/rtmp/',
    'rtmps://live-upload.instagram.com:8443/rtmp/',
    'rtmps://live-upload.instagram.com.example.test/rtmp/',
    'rtmps://user@live-upload.instagram.com/rtmp/',
    'rtmps://live-upload.instagram.com/rtmp/other/',
    INSTAGRAM + '?a=credential',
    INSTAGRAM + '#fragment',
    INSTAGRAM + '\n',
    TIKTOK,
])
def test_does_not_route_to_an_unapproved_producer(server):
    with pytest.raises(ManualLiveError, match='secure server URL') as error:
        manual_ingest('instagram', server, 'secretStreamKey')
    assert 'secretStreamKey' not in str(error.value)


@pytest.mark.parametrize('key', [
    '/stream-12345',
    'stream-12345?redirect=https%3A%2F%2Fexample.test',
    'stream-12345?rtcToken=SECRET%0D',
    'stream-12345?rtcToken=SECRET%26sign%3Dbad',
    'stream-12345?sign=SECRET&sign=duplicate',
    'stream-12345?sign=SECRET#fragment',
])
def test_rejects_ambiguous_keys_without_echoing_them(key):
    with pytest.raises(ManualLiveError, match='fresh stream key') as error:
        manual_ingest('tiktok', TIKTOK, key)
    assert 'SECRET' not in str(error.value)
