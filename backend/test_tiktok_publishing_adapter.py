import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

import tiktok_publishing_adapter as adapter


def settings(**values):
    return SimpleNamespace(api_origin='https://ziipa.example.test', approved_origins='https://ziipa.example.test',
                           tiktok_verified_media_origins='https://ziipa.example.test',
                           tiktok_public_approved=values.get('public', False))


URL = 'https://ziipa.example.test/api/publishing/tiktok/media/' + 'n' * 43 + '.' + 's' * 43


def choices(**updates):
    return {'privacy_level': 'SELF_ONLY', 'disable_comment': True, 'disable_duet': True, 'disable_stitch': True,
            'brand_content_toggle': False, 'brand_organic_toggle': False, 'is_aigc': False,
            'music_usage_confirmed': True, 'content_disclosure_enabled': False,
            'branded_content_policy_confirmed': False, 'duration_seconds': 1, **updates}


@pytest.mark.parametrize('value', [
    URL.replace('https:', 'http:'), URL.replace('ziipa.example.test', 'ziipa.example.test.evil.test'),
    URL.replace('ziipa.example.test', 'ziipa.example.test@localhost'), URL.replace('ziipa.example.test', '127.0.0.1'),
    URL + '?anything=1', URL + '#fragment', URL.replace('/tiktok/media/', '/creator/media/'),
    URL.replace('/tiktok/media/', '/tiktok/media/../'), None,
])
def test_rejects_unowned_or_arbitrary_pull_targets(value):
    with pytest.raises(adapter.TikTokError):
        adapter.pull_url(value, settings())


def test_domain_verification_is_explicit_and_independent_of_public_post_approval():
    config = settings(public=True)
    config.tiktok_verified_media_origins = ''
    with pytest.raises(adapter.TikTokError, match='Verify'):
        adapter.pull_url(URL, config)


def test_json_error_envelope_and_no_redirects():
    async def run(response):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: response), follow_redirects=False) as client:
            await adapter.request(client, 'POST', adapter.CREATOR_URL, json={})
    for response in (httpx.Response(200, json={'error': {'code': 'scope_not_authorized'}}),
                     httpx.Response(302, headers={'Location': 'https://evil.test'}, json={}),
                     httpx.Response(200, content=b'x' * (adapter.MAX_JSON_BYTES + 1))):
        with pytest.raises(adapter.TikTokError):
            asyncio.run(run(response))


def execute(choice, *, duration=10, maximum=180, public=False, title='Title', description='', init_timeout=False):
    calls, checkpoints = [], []
    def mock(request):
        calls.append(request)
        if str(request.url) == adapter.CREATOR_URL:
            return httpx.Response(200, json={'error': {'code': 'ok'}, 'data': {
                'privacy_level_options': ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'], 'max_video_post_duration_sec': maximum}})
        assert str(request.url) == adapter.INIT_URL
        assert checkpoints == [{'provider': 'tiktok', 'stage': 'init_started'}]
        assert json.loads(request.content)['source_info'] == {'source': 'PULL_FROM_URL', 'video_url': URL}
        if init_timeout:
            raise httpx.ReadTimeout('Mock uncertain write', request=request)
        return httpx.Response(200, json={'error': {'code': 'ok'}, 'data': {'publish_id': 'v_pub_url~v2-1.123'}})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(mock), follow_redirects=False) as client:
            async def checkpoint(value):
                checkpoints.append(value)
            result = await adapter.publish_prepare({'open_id': 'owner', 'access_token': 'private'}, 'owner',
                {'tiktok': choice, 'duration_seconds': duration, 'size': 100, 'bytes': bytes(100),
                 'title': title, 'description': description, 'url': URL}, client, settings(public=public), checkpoint)
            return result, calls, checkpoints
    return asyncio.run(run())


def test_server_media_uses_only_pull_init_and_durable_processing_receipt():
    result, calls, checkpoints = execute(choices())
    assert result['status'] == 'processing' and result['external_id'] == 'v_pub_url~v2-1.123'
    assert len(calls) == 2 and all(request.method == 'POST' for request in calls)
    assert checkpoints[-1]['stage'] == 'processing'
    assert URL not in json.dumps(result) and URL not in json.dumps(checkpoints)


@pytest.mark.parametrize('choice,parameters', [
    (choices(music_usage_confirmed=False), {}),
    (choices(privacy_level=''), {}),
    (choices(privacy_level='PUBLIC_TO_EVERYONE'), {}),
    (choices(duration_seconds=1), {'duration': 181}),
    (choices(content_disclosure_enabled=True), {}),
    (choices(brand_organic_toggle=True), {}),
    (choices(content_disclosure_enabled=True, brand_content_toggle=True), {}),
    (choices(content_disclosure_enabled=True, brand_content_toggle=True, privacy_level='PUBLIC_TO_EVERYONE'), {'public': True}),
])
def test_missing_or_invalid_consent_actual_duration_and_disclosures_never_initialize(choice, parameters):
    with pytest.raises(adapter.TikTokError):
        execute(choice, **parameters)


def test_branded_public_requires_both_disclosure_and_policy_confirmation():
    result, _, _ = execute(choices(privacy_level='PUBLIC_TO_EVERYONE', content_disclosure_enabled=True,
                                  brand_content_toggle=True, branded_content_policy_confirmed=True), public=True)
    assert result['privacy'] == 'public'


def test_caption_limit_counts_utf16_units():
    with pytest.raises(adapter.TikTokError, match='2,200'):
        execute(choices(), description='😀' * 1100)


def test_unknown_init_outcome_is_uncertain_without_any_second_transport():
    with pytest.raises(adapter.TikTokError) as error:
        execute(choices(), init_timeout=True)
    assert error.value.uncertain
