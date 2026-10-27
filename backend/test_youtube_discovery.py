"""No live accounts, keys, database, media downloads or provider requests."""
import asyncio
from copy import deepcopy
import json

import httpx
import pytest

import youtube_discovery as youtube

CHANNEL = 'UC' + 'a' * 22
OTHER_CHANNEL = 'UC' + 'b' * 22
PLAYLIST = 'UU' + 'a' * 22
VIDEO = 'aBcD_12-xyz'
SECOND = 'bBcD_12-xyz'
KEY = 'LOCAL_FIXTURE_KEY_NOT_A_REAL_KEY'


def responses():
    return {
        'channels': {'items': [{'id': CHANNEL, 'snippet': {'title': 'Local YouTube creator'},
                              'contentDetails': {'relatedPlaylists': {'uploads': PLAYLIST}}}]},
        'playlistItems': {'items': [{'contentDetails': {'videoId': VIDEO},
                                   'snippet': {'resourceId': {'kind': 'youtube#video', 'videoId': VIDEO}}}]},
        'videos': {'items': [{'id': VIDEO, 'snippet': {'channelId': CHANNEL, 'title': 'Public test video',
                                'description': 'Public description', 'publishedAt': '2026-10-27T12:00:00Z',
                                'thumbnails': {'high': {'url': f'https://i.ytimg.com/vi/{VIDEO}/hqdefault.jpg'}}},
                             'status': {'privacyStatus': 'public', 'uploadStatus': 'processed'}}]},
    }


def fetch(data=None, handler=None, identity='@TestChannel', **client_options):
    calls = []
    values = data or responses()

    def respond(request):
        calls.append(request)
        return handler(request) if handler else httpx.Response(200, json=values[request.url.path.rsplit('/', 1)[-1]])

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond), **client_options) as client:
            return await youtube.fetch_youtube_snapshot(client, identity, KEY)

    return asyncio.run(run()), calls


def test_import_resolves_handle_and_uses_three_bounded_official_calls_without_user_credentials():
    result, calls = fetch(headers={'Authorization': 'Bearer DO_NOT_SEND', 'Cookie': 'secret=DO_NOT_SEND'},
                          cookies={'account': 'DO_NOT_SEND'}, auth=('DO_NOT_SEND', 'DO_NOT_SEND'), follow_redirects=True)
    assert [request.url.path.rsplit('/', 1)[-1] for request in calls] == ['channels', 'playlistItems', 'videos']
    assert calls[0].url.params['forHandle'] == 'TestChannel'
    assert calls[1].url.params['playlistId'] == PLAYLIST and calls[1].url.params['maxResults'] == '30'
    assert calls[2].url.params['id'] == VIDEO
    for request in calls:
        assert request.method == 'GET' and request.url.host == 'www.googleapis.com'
        assert request.headers['x-goog-api-key'] == KEY and KEY not in str(request.url)
        assert 'authorization' not in request.headers and 'cookie' not in request.headers
    assert result['channel_id'] == CHANNEL and result['snapshot']['people'] == []
    assert result['profile_url'] == 'https://www.youtube.com/channel/' + CHANNEL
    media = result['snapshot']['media']
    assert len(media) == 1 and media[0]['provider'] == 'youtube' and media[0]['id'] == VIDEO
    assert media[0]['url'] == 'https://www.youtube.com/watch?v=' + VIDEO
    assert media[0]['thumbnail_url'] == f'https://i.ytimg.com/vi/{VIDEO}/hqdefault.jpg'
    assert KEY not in json.dumps(result) and 'DO_NOT_SEND' not in json.dumps(result)


def test_channel_id_preserves_case_and_mismatched_returned_identity_is_rejected():
    _, calls = fetch(identity=CHANNEL)
    assert calls[0].url.params['id'] == CHANNEL and 'forHandle' not in calls[0].url.params
    data = responses()
    data['channels']['items'][0]['id'] = OTHER_CHANNEL
    with pytest.raises(youtube.YouTubeSyncFailure, match='different channel identity'):
        fetch(data, identity=CHANNEL)


@pytest.mark.parametrize('identity', ['https://youtube.com/@artist', '../token', '@@artist', 'ab', 'a' * 31, None])
def test_invalid_identity_is_rejected_without_a_request(identity):
    with pytest.raises(youtube.YouTubeSyncFailure, match='Re-link'):
        fetch(identity=identity, handler=lambda _: pytest.fail('Invalid identity made a network request'))


def test_missing_key_is_not_a_fake_ready_state():
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: pytest.fail('Missing key requested'))) as client:
            await youtube.fetch_youtube_snapshot(client, '@artist', '')
    with pytest.raises(youtube.YouTubeSyncFailure, match='configured server API key'):
        asyncio.run(run())


@pytest.mark.parametrize('changes', [
    {'privacyStatus': 'private'}, {'privacyStatus': 'unlisted'}, {'privacyStatus': None},
    {'uploadStatus': 'deleted'}, {'uploadStatus': 'uploaded'}, {'uploadStatus': 'rejected'}, {},
])
def test_private_unlisted_unprocessed_or_missing_status_videos_are_tombstoned(changes):
    data = responses()
    data['videos']['items'][0]['status'] = {**data['videos']['items'][0]['status'], **changes} if changes else {}
    result, _ = fetch(data)
    assert result['snapshot']['media'] == []


def test_success_replaces_deleted_missing_and_other_channel_video_snapshots_instead_of_merging_old_records():
    data = responses()
    data['videos']['items'] = []
    result, _ = fetch(data)
    assert result['snapshot'] == {'media': [], 'people': []}
    data = responses()
    data['videos']['items'][0]['snippet']['channelId'] = OTHER_CHANNEL
    assert fetch(data)[0]['snapshot']['media'] == []


def test_empty_public_uploads_cost_only_two_calls_and_do_not_request_the_video_endpoint():
    data = responses()
    data['playlistItems'] = {'items': [], 'nextPageToken': 'MUST_NOT_FETCH'}
    result, calls = fetch(data)
    assert result['snapshot']['media'] == [] and len(calls) == 2


def test_snapshot_deduplicates_and_preserves_upload_order_without_following_pagination():
    data = responses()
    entry = data['playlistItems']['items'][0]
    second = {'contentDetails': {'videoId': SECOND}}
    data['playlistItems'] = {'items': [entry, second, entry], 'nextPageToken': 'DO_NOT_FETCH'}
    extra = deepcopy(data['videos']['items'][0])
    extra['id'] = SECOND
    data['videos']['items'] = [extra, data['videos']['items'][0], extra]
    result, calls = fetch(data)
    assert [item['id'] for item in result['snapshot']['media']] == [VIDEO, SECOND]
    assert len(calls) == 3 and all('pageToken' not in request.url.params for request in calls)


def test_thirty_video_limit_uses_one_batched_request_and_oversized_lists_fail_closed():
    data = responses()
    template = data['videos']['items'][0]
    identifiers = [f'{index:011}' for index in range(youtube.POST_LIMIT)]
    data['playlistItems']['items'] = [{'contentDetails': {'videoId': identifier}} for identifier in identifiers]
    data['videos']['items'] = [{**deepcopy(template), 'id': identifier} for identifier in identifiers]
    result, calls = fetch(data)
    assert len(result['snapshot']['media']) == 30 and len(calls) == 3
    assert calls[-1].url.params['id'] == ','.join(identifiers)
    data['playlistItems']['items'].append({'contentDetails': {'videoId': SECOND}})
    with pytest.raises(youtube.YouTubeSyncFailure, match='too many public playlist'):
        fetch(data)
    data['playlistItems']['items'].pop()
    data['videos']['items'].append(deepcopy(template))
    with pytest.raises(youtube.YouTubeSyncFailure, match='too many video records'):
        fetch(data)


def test_public_nonembeddable_video_remains_a_link_out_without_an_embedded_or_downloadable_source():
    data = responses()
    data['videos']['items'][0]['status']['embeddable'] = False
    result, _ = fetch(data)
    assert result['snapshot']['media'][0]['url'] == 'https://www.youtube.com/watch?v=' + VIDEO
    assert set(result['snapshot']['media'][0]) == {'id', 'provider', 'title', 'text', 'url', 'thumbnail_url',
                                                 'author', 'handle', 'published_at', 'kind'}


@pytest.mark.parametrize('url', [
    'http://i.ytimg.com/vi/{id}/hqdefault.jpg', 'https://evil.test/vi/{id}/hqdefault.jpg',
    'https://i.ytimg.com.evil.test/vi/{id}/hqdefault.jpg', 'https://u:p@i.ytimg.com/vi/{id}/hqdefault.jpg',
    'https://i.ytimg.com:443/vi/{id}/hqdefault.jpg', 'https://i.ytimg.com/vi/{id}/hqdefault.jpg?token=secret',
    'https://i.ytimg.com/vi/{id}/hqdefault.jpg#fragment', 'https://i.ytimg.com/vi/{id}/../secret.jpg',
    'https://i.ytimg.com/vi/another0000/hqdefault.jpg',
])
def test_only_canonical_current_video_thumbnail_urls_can_leave_the_adapter(url):
    data = responses()
    data['videos']['items'][0]['snippet']['thumbnails']['high']['url'] = url.format(id=VIDEO)
    assert fetch(data)[0]['snapshot']['media'][0]['thumbnail_url'] is None


def test_unavailable_channel_explicitly_requests_snapshot_discard():
    data = responses()
    data['channels']['items'] = []
    with pytest.raises(youtube.YouTubeSyncFailure) as error:
        fetch(data)
    assert error.value.discard_snapshot


@pytest.mark.parametrize('status', [302, 401, 403, 429, 500])
def test_failures_do_not_follow_redirects_or_expose_provider_error_bodies(status):
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(status, headers={'Location': 'http://127.0.0.1/secrets'},
                              json={'error': {'message': 'UPSTREAM_SECRET ' + KEY}})
    with pytest.raises(youtube.YouTubeSyncFailure) as error:
        fetch(handler=respond, follow_redirects=True)
    assert len(calls) == 1 and KEY not in str(error.value) and 'UPSTREAM_SECRET' not in str(error.value)


@pytest.mark.parametrize('body', [b'not json', b'[]', b'{"items":{}}', b'x' * (youtube.MAX_RESPONSE_BYTES + 1)],
                         ids=['invalid-json', 'non-object', 'invalid-items', 'oversize-response'])
def test_response_bytes_and_json_shape_are_bounded(body):
    with pytest.raises(youtube.YouTubeSyncFailure):
        fetch(handler=lambda _: httpx.Response(200, headers={'Content-Type': 'application/json'}, content=body))


def test_whole_operation_deadline_cancels_a_trickling_provider(monkeypatch):
    monkeypatch.setattr(youtube, 'TOTAL_TIMEOUT_SECONDS', 0.01)
    cancelled = []
    async def slow_send(self, *args, **kwargs):
        try:
            await asyncio.sleep(1)
        finally:
            cancelled.append(True)
    monkeypatch.setattr(httpx.AsyncClient, 'send', slow_send)
    with pytest.raises(youtube.YouTubeSyncFailure, match='time limit'):
        fetch()
    assert cancelled
