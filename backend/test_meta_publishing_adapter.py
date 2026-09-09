"""Isolated provider contract/security checks. No database or real HTTP calls."""
import asyncio
import json
import time
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

import meta_publishing_adapter as meta


@pytest.fixture
def settings():
    return SimpleNamespace(meta_client_id="12345", meta_client_secret="TEST_APP_SECRET",
                           meta_graph_version="v25.0", meta_media_origins="https://media.example.test")


def tokens(provider="facebook"):
    target = "123" if provider == "facebook" else "456"
    return {"provider": provider, "access_token": "TEST_USER_TOKEN", "expires_at": time.time() + 3600,
            "page_tokens": {target: {"page_id": "123", "access_token": "TEST_PAGE_TOKEN"}}}


def source():
    return {"content_type": "video/mp4", "size": 32, "bytes": bytes(32), "title": "My original Reel",
            "description": "Approved caption", "url": "https://media.example.test/private/file?signature=TEST_SIGNED_SECRET"}


def run(operation, handler):
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True) as client:
            return await operation(client)
    return asyncio.run(scenario())


def checkpoint_recorder():
    saved = []
    async def checkpoint(data):
        text = json.dumps(data)
        assert "TOKEN" not in text and "signature" not in text and "https://" not in text
        saved.append(dict(data))
    return saved, checkpoint


def test_authorization_scopes_and_secret_free_url(settings):
    url = meta.authorization_url("instagram", settings, "https://ziipa.example.test/api/callback", "s" * 40)
    query = parse_qs(urlsplit(url).query)
    assert query["state"] == ["s" * 40]
    assert set(query["scope"][0].split(",")) == meta.required_scopes("instagram")
    assert "instagram_business_basic" not in query["scope"][0]
    assert "TEST_APP_SECRET" not in url
    with pytest.raises(meta.MetaError):
        meta.authorization_url("instagram", settings, "https://trusted@evil.test/callback?token=x", "s" * 40)
    settings.meta_graph_version = "v25.0/../../evil"
    with pytest.raises(meta.MetaError):
        meta.validate_settings(settings)


@pytest.mark.parametrize("provider,target", [("facebook", "123"), ("instagram", "456")])
def test_exchange_keeps_page_tokens_out_of_public_targets(settings, provider, target):
    def handler(request):
        path = request.url.path
        assert request.url.host == "graph.facebook.com"
        assert "access_token=" not in str(request.url) and "TEST_APP_SECRET" not in str(request.url)
        if path.endswith("oauth/access_token"):
            assert request.method == "POST"
            return httpx.Response(200, json={"access_token": "TEST_USER_TOKEN", "expires_in": 5184000})
        assert request.headers["authorization"] == "Bearer TEST_USER_TOKEN"
        assert "appsecret_proof" in request.url.params
        if path.endswith("/me/permissions"):
            return httpx.Response(200, json={"data": [{"permission": scope, "status": "granted"} for scope in meta.required_scopes(provider)]})
        if path.endswith("/me"):
            return httpx.Response(200, json={"id": "987"})
        if path.endswith("/me/accounts"):
            assert ("instagram_business_account" in request.url.params["fields"]) == (provider == "instagram")
            return httpx.Response(200, json={"data": [
                {"id": "123", "name": "My Page", "access_token": "TEST_PAGE_TOKEN", "tasks": ["CREATE_CONTENT"],
                 "instagram_business_account": {"id": "456", "username": "my_account"}},
                {"id": "321", "name": "Read only", "access_token": "ANOTHER_TOKEN", "tasks": ["ANALYZE"]},
            ]})
        raise AssertionError(path)
    result = run(lambda client: meta.exchange("TEST_CODE", "https://ziipa.example.test/callback", client, provider, settings), handler)
    assert [row["id"] for row in result["targets"]] == [target]
    assert "TOKEN" not in json.dumps(result["targets"])
    assert result["tokens"]["page_tokens"][target]["access_token"] == "TEST_PAGE_TOKEN"
    assert result["tokens"]["subject"] == "987"
    assert "refresh_token" not in result["tokens"]


def test_exchange_requires_granted_scope(settings):
    calls = []
    def handler(request):
        calls.append(request)
        if request.url.path.endswith("oauth/access_token"):
            return httpx.Response(200, json={"access_token": "TEST_USER_TOKEN", "expires_in": 3600})
        return httpx.Response(200, json={"data": [{"permission": "pages_show_list", "status": "granted"}]})
    with pytest.raises(meta.MetaError) as error:
        run(lambda client: meta.exchange("code", "https://ziipa.example.test/callback", client, "facebook", settings), handler)
    assert error.value.reconnect
    assert all(not r.url.path.endswith("/me/accounts") for r in calls)


def test_page_pagination_uses_fixed_endpoint_not_provider_next_url(settings):
    calls = []
    def handler(request):
        calls.append(request)
        assert request.url.host == "graph.facebook.com" and request.url.path.endswith("/me/accounts")
        if "after" not in request.url.params:
            return httpx.Response(200, json={"data": [], "paging": {"next": "https://evil.test/steal?access_token=PRIVATE",
                "cursors": {"after": "cursor_only"}}})
        assert request.url.params["after"] == "cursor_only"
        return httpx.Response(200, json={"data": [{"id": "123", "name": "Page", "tasks": ["CREATE_CONTENT"], "access_token": "TEST_PAGE_TOKEN"}]})
    result, private = run(lambda client: meta._targets(client, "facebook", "TEST_USER_TOKEN", settings), handler)
    assert len(calls) == 2 and result[0]["id"] == "123" and "TOKEN" not in json.dumps(result)
    assert private["123"]["access_token"] == "TEST_PAGE_TOKEN"


def test_facebook_checkpoints_and_processing_not_fake_delivered(settings):
    saved, checkpoint = checkpoint_recorder()
    calls = []
    def handler(request):
        calls.append(request)
        if request.url.path == "/v25.0/123":
            return httpx.Response(200, json={"id": "123"})
        if request.url.host == "rupload.facebook.com":
            assert saved[-1]["phase"] == "upload_started"
            assert saved[-1]["video_id"] == "789"
            assert request.headers["authorization"] == "OAuth TEST_PAGE_TOKEN"
            assert request.headers["file_size"] == "32"
            assert request.content == bytes(32)
            return httpx.Response(200, json={"success": True})
        if request.url.path == "/v25.0/123/video_reels":
            form = parse_qs(request.content.decode())
            if form["upload_phase"] == ["start"]:
                assert saved[-1]["phase"] == "create_started"
                return httpx.Response(200, json={"video_id": "789", "upload_url": "https://rupload.facebook.com/video-upload/v25.0/789"})
            assert form["video_state"] == ["PUBLISHED"] and saved[-1]["phase"] == "publish_started"
            return httpx.Response(200, json={"success": True})
        if request.url.path == "/v25.0/789":
            return httpx.Response(200, json={"id": "789", "status": {"video_status": "ready", "publishing_phase": {"status": "complete"}}})
        raise AssertionError(request.url)
    result = run(lambda client: meta.publish_prepare(tokens(), "123", source(), client, settings, checkpoint), handler)
    assert result["status"] == "processing" and result["external_id"] == "789"
    result = run(lambda client: meta.poll(tokens(), "123", result, client, settings, checkpoint), handler)
    assert result["status"] == "delivered"
    assert result["external_url"] == "https://www.facebook.com/reel/789"
    assert len([r for r in calls if r.method == "POST"]) == 3


@pytest.mark.parametrize("returned_url", ["https://evil.test/upload", "https://rupload.facebook.com.evil.test/video-upload/v25.0/789",
                                         "https://user:password@rupload.facebook.com/video-upload/v25.0/789",
                                         "https://rupload.facebook.com:444/video-upload/v25.0/789"])
def test_facebook_never_sends_page_token_to_unverified_upload_url(settings, returned_url):
    saved, checkpoint = checkpoint_recorder()
    calls = []
    def handler(request):
        calls.append(request)
        if request.url.path == "/v25.0/123":
            return httpx.Response(200, json={"id": "123"})
        assert request.url.path == "/v25.0/123/video_reels"
        return httpx.Response(200, json={"video_id": "789", "upload_url": returned_url})
    result = run(lambda client: meta.publish_prepare(tokens(), "123", source(), client, settings, checkpoint), handler)
    assert result["status"] == "uncertain"
    assert len(calls) == 2
    assert saved[-1]["phase"] == "upload_unverified"


def test_facebook_unknown_finish_is_not_sent_again_on_poll(settings):
    saved, checkpoint = checkpoint_recorder()
    posts = []
    def handler(request):
        if request.method == "POST":
            posts.append(request)
        if request.url.path == "/v25.0/123":
            return httpx.Response(200, json={"id": "123"})
        if request.url.host == "rupload.facebook.com":
            return httpx.Response(200, json={"success": True})
        if request.url.path.endswith("video_reels"):
            if b"upload_phase=start" in request.content:
                return httpx.Response(200, json={"video_id": "789", "upload_url": "https://rupload.facebook.com/video-upload/v25.0/789"})
            raise httpx.ReadTimeout("Provider lost result", request=request)
        return httpx.Response(200, json={"id": "789", "status": {"video_status": "processing", "publishing_phase": {"status": "not_started"}}})
    result = run(lambda client: meta.publish_prepare(tokens(), "123", source(), client, settings, checkpoint), handler)
    assert result["status"] == "uncertain"
    result = run(lambda client: meta.poll(tokens(), "123", result, client, settings, checkpoint), handler)
    assert result["status"] == "processing"
    assert len(posts) == 3


def test_instagram_only_publishes_ready_container_once_and_sanitizes_permalink(settings):
    saved, checkpoint = checkpoint_recorder()
    calls = []
    ready = False
    def handler(request):
        calls.append(request)
        if request.url.path == "/v25.0/123":
            return httpx.Response(200, json={"id": "123", "instagram_business_account": {"id": "456"}})
        if request.url.path == "/v25.0/456/media":
            assert saved[-1]["phase"] == "create_started"
            assert parse_qs(request.content.decode())["video_url"] == [source()["url"]]
            return httpx.Response(200, json={"id": "789"})
        if request.url.path == "/v25.0/789":
            return httpx.Response(200, json={"id": "789", "status_code": "FINISHED" if ready else "IN_PROGRESS"})
        if request.url.path == "/v25.0/456/media_publish":
            assert saved[-1]["phase"] == "publish_started" and ready
            assert parse_qs(request.content.decode())["creation_id"] == ["789"]
            return httpx.Response(200, json={"id": "654"})
        if request.url.path == "/v25.0/654":
            return httpx.Response(200, json={"id": "654", "permalink": "https://instagram.com.evil.test/reel/steal/"})
        raise AssertionError(request.url)
    result = run(lambda client: meta.publish_prepare(tokens("instagram"), "456", source(), client, settings, checkpoint), handler)
    assert result["status"] == "processing" and not result["external_id"]
    result = run(lambda client: meta.poll(tokens("instagram"), "456", result, client, settings, checkpoint), handler)
    assert result["status"] == "processing"
    assert not any(r.url.path.endswith("media_publish") for r in calls)
    ready = True
    result = run(lambda client: meta.poll(tokens("instagram"), "456", result, client, settings, checkpoint), handler)
    assert result["status"] == "delivered" and result["external_id"] == "654"
    result = run(lambda client: meta.poll(tokens("instagram"), "456", result, client, settings, checkpoint), handler)
    assert result["status"] == "delivered" and result["external_url"] == ""
    assert len([r for r in calls if r.url.path.endswith("media_publish")]) == 1


def test_instagram_unknown_publish_receipt_never_repeats_final_post(settings):
    saved, checkpoint = checkpoint_recorder()
    job = {"provider_data": {"provider": "instagram", "target_id": "456", "container_id": "789", "phase": "container_created"}}
    post_count = 0
    def handler(request):
        nonlocal post_count
        if request.url.path == "/v25.0/123":
            return httpx.Response(200, json={"id": "123", "instagram_business_account": {"id": "456"}})
        if request.url.path == "/v25.0/789":
            return httpx.Response(200, json={"id": "789", "status_code": "FINISHED"})
        assert request.url.path.endswith("media_publish")
        post_count += 1
        raise httpx.ReadTimeout("Unknown outcome", request=request)
    result = run(lambda client: meta.poll(tokens("instagram"), "456", job, client, settings, checkpoint), handler)
    assert result["status"] == "uncertain"
    for _ in range(2):
        result = run(lambda client: meta.poll(tokens("instagram"), "456", result, client, settings, checkpoint), handler)
        assert result["status"] == "uncertain"
    assert post_count == 1


@pytest.mark.parametrize("link_result,expected_link", [
    ("valid", "https://www.instagram.com/reel/Confirmed_123/"),
    ("missing", ""), ("hostile", ""), ("wrong_id", ""), ("failure", ""), ("timeout", ""),
])
def test_confirmed_instagram_publish_gets_link_once_without_losing_delivery(settings, link_result, expected_link):
    saved, checkpoint = checkpoint_recorder()
    job = {"provider_data": {"provider": "instagram", "target_id": "456", "container_id": "789", "phase": "container_created"}}
    writes, link_reads = [], []
    def handler(request):
        if request.url.path == "/v25.0/123":
            return httpx.Response(200, json={"id": "123", "instagram_business_account": {"id": "456"}})
        if request.url.path == "/v25.0/789":
            return httpx.Response(200, json={"id": "789", "status_code": "FINISHED"})
        if request.url.path.endswith("media_publish"):
            writes.append(request)
            return httpx.Response(200, json={"id": "654"})
        assert request.url.path == "/v25.0/654" and request.method == "GET"
        assert saved[-1]["phase"] == "delivered" and saved[-1]["media_id"] == "654"
        link_reads.append(request)
        if link_result == "failure":
            return httpx.Response(503, json={})
        if link_result == "timeout":
            raise httpx.ReadTimeout("Optional link lookup timed out", request=request)
        result = {"id": "999" if link_result == "wrong_id" else "654"}
        if link_result != "missing":
            result["permalink"] = "https://evil.test/reel/private/" if link_result == "hostile" else "https://www.instagram.com/reel/Confirmed_123/"
        return httpx.Response(200, json=result)
    result = run(lambda client: meta.poll(tokens("instagram"), "456", job, client, settings, checkpoint), handler)
    assert result["status"] == "delivered" and result["external_id"] == "654"
    assert result["external_url"] == expected_link
    assert len(writes) == 1 and len(link_reads) == 1


def test_optional_instagram_link_has_total_deadline_and_keeps_confirmed_id(settings, monkeypatch):
    monkeypatch.setattr(meta, "PERMALINK_TIMEOUT_SECONDS", 0.01)
    saved, checkpoint = checkpoint_recorder()
    job = {"provider_data": {"provider": "instagram", "target_id": "456", "container_id": "789", "phase": "container_created"}}
    writes = []
    async def handler(request):
        if request.url.path == "/v25.0/123":
            return httpx.Response(200, json={"id": "123", "instagram_business_account": {"id": "456"}})
        if request.url.path == "/v25.0/789":
            return httpx.Response(200, json={"id": "789", "status_code": "FINISHED"})
        if request.url.path.endswith("media_publish"):
            writes.append(request)
            return httpx.Response(200, json={"id": "654"})
        assert saved[-1]["phase"] == "delivered"
        await asyncio.sleep(0.05)
        raise AssertionError("The optional lookup must have been cancelled by its deadline")
    result = run(lambda client: meta.poll(tokens("instagram"), "456", job, client, settings, checkpoint), handler)
    assert result["status"] == "delivered" and result["external_id"] == "654" and result["external_url"] == ""
    assert len(writes) == 1


@pytest.mark.parametrize("media_url", ["http://media.example.test/file", "https://evil.test/file", "https://media.example.test.evil.test/file",
                                     "https://user:password@media.example.test/file", "https://media.example.test:444/file",
                                     "https://media.example.test/file#fragment"])
def test_instagram_rejects_non_storage_urls_before_provider_write(settings, media_url):
    _, checkpoint = checkpoint_recorder()
    def forbidden(request):
        raise AssertionError("No provider request was authorized")
    with pytest.raises(meta.MetaError):
        run(lambda client: meta.publish_prepare(tokens("instagram"), "456", {**source(), "url": media_url}, client, settings, checkpoint), forbidden)


def test_changed_instagram_page_link_is_rejected_before_upload(settings):
    _, checkpoint = checkpoint_recorder()
    def handler(request):
        assert request.method == "GET"
        return httpx.Response(200, json={"id": "123", "instagram_business_account": {"id": "999"}})
    with pytest.raises(meta.MetaError) as error:
        run(lambda client: meta.publish_prepare(tokens("instagram"), "456", source(), client, settings, checkpoint), handler)
    assert error.value.reconnect


def test_expired_credentials_and_cross_target_receipts_fail_without_http(settings):
    _, checkpoint = checkpoint_recorder()
    def forbidden(request):
        raise AssertionError("Provider access must not occur")
    expired = {**tokens(), "expires_at": time.time() - 1}
    with pytest.raises(meta.MetaError) as error:
        run(lambda client: meta.publish_prepare(expired, "123", source(), client, settings, checkpoint), forbidden)
    assert error.value.reconnect
    job = {"provider_data": {"provider": "facebook", "target_id": "999", "phase": "submitted", "video_id": "789"}}
    with pytest.raises(meta.MetaError):
        run(lambda client: meta.poll(tokens(), "123", job, client, settings, checkpoint), forbidden)


def test_transport_disables_redirects_bounds_json_and_sanitizes_errors(settings):
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(302, headers={"Location": "https://evil.test/secret"}, json={})
    with pytest.raises(meta.MetaError):
        run(lambda client: meta._json(client, "GET", meta._graph(settings, "me")), handler)
    assert len(requests) == 1
    with pytest.raises(meta.MetaError):
        run(lambda client: meta._json(client, "GET", meta._graph(settings, "me")), lambda request: httpx.Response(200, content=b"x" * (meta.MAX_JSON_BYTES + 1)))
    with pytest.raises(meta.MetaError) as error:
        run(lambda client: meta._json(client, "POST", meta._graph(settings, "123/media"), write=True),
            lambda request: httpx.Response(500, json={"error": {"message": "TEST_PAGE_TOKEN"}}))
    assert error.value.uncertain and "TEST_PAGE_TOKEN" not in str(error.value)


def test_bad_write_receipt_stays_uncertain_and_checkpoint_failure_stops_write(settings):
    _, checkpoint = checkpoint_recorder()
    def handler(request):
        if request.url.path == "/v25.0/123":
            return httpx.Response(200, json={"id": "123"})
        return httpx.Response(200, json={"video_id": "../evil"})
    result = run(lambda client: meta.publish_prepare(tokens(), "123", source(), client, settings, checkpoint), handler)
    assert result["status"] == "uncertain"
    async def broken_checkpoint(data):
        raise RuntimeError("Persistence unavailable")
    def read_only(request):
        assert request.method == "GET"
        return httpx.Response(200, json={"id": "123"})
    with pytest.raises(RuntimeError):
        run(lambda client: meta.publish_prepare(tokens(), "123", source(), client, settings, broken_checkpoint), read_only)


def test_revoke_returns_truthful_status_and_uses_user_token(settings):
    def handler(request):
        assert request.method == "DELETE" and request.url.path.endswith("/me/permissions")
        assert request.headers["authorization"] == "Bearer TEST_USER_TOKEN"
        return httpx.Response(200, json={"success": True})
    assert run(lambda client: meta.revoke(tokens(), client, settings), handler) is True
    assert run(lambda client: meta.revoke(tokens(), client, settings), lambda request: httpx.Response(503, json={})) is False
