"""Facebook Page and linked professional Instagram publishing adapters.

Only the orchestration layer owns consent, account binding, encryption and job
locking. Its async checkpoint must durably save provider_data before returning.
Do not expose tokens, Page tokens or signed source URLs in API responses/logs.
Official contracts and operational limits are documented in META_PUBLISHING.md.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import inspect
import ipaddress
import json
import re
import time
from urllib.parse import urlencode, urlsplit

import httpx


MAX_JSON_BYTES = 1024 * 1024
MAX_MEDIA_BYTES = 25 * 1024 * 1024
MAX_TARGETS = 100
MAX_PAGES = 5
PERMALINK_TIMEOUT_SECONDS = 2
ID_PATTERN = re.compile(r"[1-9][0-9]{0,49}\Z")
VERSION_PATTERN = re.compile(r"v[1-9][0-9]{0,2}\.0\Z")
BASE_SCOPES = frozenset(("pages_show_list", "pages_read_engagement"))


class MetaError(Exception):
    """Safe public error text; provider bodies and URLs are never included."""
    def __init__(self, detail: str, *, reconnect: bool = False, uncertain: bool = False):
        super().__init__(detail)
        self.reconnect = reconnect
        self.uncertain = uncertain


def required_scopes(provider: str) -> frozenset[str]:
    if provider == "facebook":
        return BASE_SCOPES | {"pages_manage_posts"}
    if provider == "instagram":
        return BASE_SCOPES | {"instagram_basic", "instagram_content_publish"}
    raise MetaError("Unsupported Meta destination.")


def validate_settings(settings) -> None:
    if not str(getattr(settings, "meta_client_id", "")) or not getattr(settings, "meta_client_secret", ""):
        raise MetaError("A Meta developer app ID and secret must be configured.")
    if not VERSION_PATTERN.fullmatch(str(getattr(settings, "meta_graph_version", ""))):
        raise MetaError("Configure an explicitly supported Meta Graph version, such as v25.0.")


def _identifier(value) -> str:
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        raise MetaError("Meta did not return a verifiable object identifier.")
    return value


def _written_identifier(value) -> str:
    try:
        return _identifier(value)
    except MetaError as exc:
        raise MetaError("Meta accepted a request without returning a verifiable receipt. Check the destination before retrying.", uncertain=True) from exc


def _token(value) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 16384 or any(ord(c) < 33 or ord(c) > 126 for c in value):
        raise MetaError("Meta did not return a valid authorization token.", reconnect=True)
    return value


def _callback_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise MetaError("Meta OAuth requires the configured HTTPS callback URL.")
    return value


def authorization_url(provider: str, settings, redirect_uri: str, state: str) -> str:
    validate_settings(settings)
    if not isinstance(state, str) or not 32 <= len(state) <= 200:
        raise MetaError("The authorization state is invalid.")
    return f"https://www.facebook.com/{settings.meta_graph_version}/dialog/oauth?" + urlencode({
        "client_id": settings.meta_client_id, "redirect_uri": _callback_url(redirect_uri),
        "response_type": "code", "scope": ",".join(sorted(required_scopes(provider))),
        "state": state, "auth_type": "rerequest",
    })


async def _json(client, method: str, url: str, *, write=False, **kwargs) -> dict:
    """Only module-generated fixed hosts/paths enter here; redirects never run."""
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname not in ("graph.facebook.com", "rupload.facebook.com")
            or parsed.netloc != parsed.hostname or parsed.query or parsed.fragment):
        raise MetaError("The Meta endpoint is not permitted.")
    if parsed.hostname == "graph.facebook.com":
        if not re.fullmatch(r"/v[1-9][0-9]{0,2}\.0/(?:oauth/access_token|me(?:/accounts|/permissions)?|[1-9][0-9]{0,49}(?:/media|/media_publish|/video_reels)?)", parsed.path):
            raise MetaError("The Meta endpoint path is not permitted.")
    elif not re.fullmatch(r"/video-upload/v[1-9][0-9]{0,2}\.0/[1-9][0-9]{0,49}", parsed.path):
        raise MetaError("The Meta upload path is not permitted.")
    try:
        async with asyncio.timeout(25):
            async with client.stream(method, url, follow_redirects=False, **kwargs) as response:
                raw = bytearray()
                async for part in response.aiter_bytes():
                    if len(raw) + len(part) > MAX_JSON_BYTES:
                        raise MetaError("Meta returned an oversized response.", uncertain=write)
                    raw.extend(part)
                try:
                    body = json.loads(raw) if raw else {}
                except (ValueError, UnicodeError) as exc:
                    raise MetaError("Meta returned an unverifiable response.", uncertain=write) from exc
                if not isinstance(body, dict):
                    raise MetaError("Meta returned an unverifiable response.", uncertain=write)
                error = body.get("error")
                if not 200 <= response.status_code < 300 or error:
                    reconnect = isinstance(error, dict) and error.get("code") in (102, 190)
                    raise MetaError(
                        "Meta authorization expired. Reconnect this account." if reconnect else
                        "Meta could not complete this request. Check app approval, destination permissions and media requirements.",
                        reconnect=reconnect,
                        uncertain=write and not 400 <= response.status_code < 500,
                    )
                return body
    except (httpx.HTTPError, TimeoutError) as exc:
        raise MetaError("The Meta request could not be verified. No automatic repost will run.", uncertain=write) from exc


def _graph(settings, path: str) -> str:
    validate_settings(settings)
    return f"https://graph.facebook.com/{settings.meta_graph_version}/{path}"


def _authorized(token: str, settings, params=None) -> dict:
    token = _token(token)
    proof = hmac.new(settings.meta_client_secret.encode(), token.encode(), hashlib.sha256).hexdigest()
    return {"headers": {"Authorization": "Bearer " + token}, "params": {**(params or {}), "appsecret_proof": proof}}


def _name(value) -> str:
    return "".join(c for c in str(value) if c.isprintable())[:150]


async def _targets(client, provider: str, user_token: str, settings) -> tuple[list[dict], dict]:
    targets, page_tokens = [], {}
    seen, after = set(), None
    for _ in range(MAX_PAGES):
        fields = "id,name,access_token,tasks"
        if provider == "instagram":
            fields += ",instagram_business_account{id,username}"
        params = {"fields": fields, "limit": 100}
        if after:
            params["after"] = after
        body = await _json(client, "GET", _graph(settings, "me/accounts"), **_authorized(user_token, settings, params))
        rows = body.get("data")
        if not isinstance(rows, list):
            raise MetaError("Meta did not return the Pages available to this account.")
        for row in rows[:100]:
            if not isinstance(row, dict) or not isinstance(row.get("tasks"), list):
                continue
            if not ({"CREATE_CONTENT", "MANAGE", "PROFILE_PLUS_CREATE_CONTENT", "PROFILE_PLUS_FULL_CONTROL"} & set(t for t in row["tasks"] if isinstance(t, str))):
                continue
            try:
                page_id, page_token = _identifier(row.get("id")), _token(row.get("access_token"))
                if provider == "instagram":
                    instagram = row.get("instagram_business_account")
                    target_id = _identifier(instagram.get("id") if isinstance(instagram, dict) else None)
                    username = instagram.get("username")
                    valid_username = isinstance(username, str) and re.fullmatch(r"[A-Za-z0-9_.]{1,30}", username)
                    name = _name(username if valid_username else row.get("name", "Instagram professional account"))
                    url = f"https://www.instagram.com/{username}/" if valid_username else ""
                    kind = "instagram_professional"
                else:
                    target_id, name = page_id, _name(row.get("name", "Facebook Page"))
                    kind, url = "facebook_page", "https://www.facebook.com/" + page_id
            except MetaError:
                continue
            if target_id in page_tokens:
                continue
            targets.append({"id": target_id, "name": name, "kind": kind, "url": url})
            page_tokens[target_id] = {"access_token": page_token, "page_id": page_id}
            if len(targets) >= MAX_TARGETS:
                return targets, page_tokens
        paging = body.get("paging")
        cursor = paging.get("cursors", {}).get("after") if isinstance(paging, dict) and isinstance(paging.get("cursors"), dict) else None
        # Never follow an arbitrary paging.next URL containing provider tokens.
        if not isinstance(paging, dict) or not paging.get("next") or not isinstance(cursor, str) or not 1 <= len(cursor) <= 2048 or cursor in seen:
            break
        seen.add(cursor)
        after = cursor
    if not targets:
        raise MetaError("No eligible managed Page or linked professional Instagram account was returned. Grant content creation access and reconnect.")
    return targets, page_tokens


async def exchange(code: str, redirect_uri: str, client, provider: str, settings) -> dict:
    validate_settings(settings)
    scopes = required_scopes(provider)
    if not isinstance(code, str) or not 1 <= len(code) <= 4096:
        raise MetaError("The Meta authorization code is invalid.")
    body = await _json(client, "POST", _graph(settings, "oauth/access_token"), data={
        "client_id": settings.meta_client_id, "client_secret": settings.meta_client_secret,
        "redirect_uri": _callback_url(redirect_uri), "code": code,
    })
    token = _token(body.get("access_token"))
    # Facebook uses a long-lived token exchange, not an OAuth refresh_token.
    body = await _json(client, "POST", _graph(settings, "oauth/access_token"), data={
        "grant_type": "fb_exchange_token", "client_id": settings.meta_client_id,
        "client_secret": settings.meta_client_secret, "fb_exchange_token": token,
    })
    token = _token(body.get("access_token"))
    try:
        expires = int(body.get("expires_in", 0))
    except (TypeError, ValueError, OverflowError) as exc:
        raise MetaError("Meta did not return a valid token lifetime.") from exc
    if not 0 < expires <= 366 * 86400:
        raise MetaError("Meta did not return a valid token lifetime.")
    permission_body = await _json(client, "GET", _graph(settings, "me/permissions"), **_authorized(token, settings))
    permissions = permission_body.get("data")
    granted = {row.get("permission") for row in permissions if isinstance(row, dict) and row.get("status") == "granted" and isinstance(row.get("permission"), str)} if isinstance(permissions, list) else set()
    if not scopes.issubset(granted):
        raise MetaError("The required Meta Page and publishing permissions were not approved. Reconnect and approve all requested permissions.", reconnect=True)
    account = await _json(client, "GET", _graph(settings, "me"), **_authorized(token, settings, {"fields": "id"}))
    subject = _identifier(account.get("id"))
    targets, page_tokens = await _targets(client, provider, token, settings)
    return {"tokens": {"provider": provider, "access_token": token, "expires_at": time.time() + expires,
                       "scope": sorted(scopes), "subject": subject, "page_tokens": page_tokens}, "targets": targets}


def _credentials(tokens: dict, target_id: str) -> tuple[str, str, str]:
    provider = tokens.get("provider")
    required_scopes(provider)
    _identifier(target_id)
    try:
        expiry = float(tokens.get("expires_at", 0))
    except (ValueError, TypeError, OverflowError):
        expiry = 0
    if expiry <= time.time() + 60:
        raise MetaError("Meta authorization expired. Reconnect this account.", reconnect=True)
    choices = tokens.get("page_tokens")
    selected = choices.get(target_id) if isinstance(choices, dict) else None
    if not isinstance(selected, dict):
        raise MetaError("Choose one of the destinations authorized by this Meta account.")
    return provider, _token(selected.get("access_token")), _identifier(selected.get("page_id"))


def _media_url(value, settings) -> str:
    if not isinstance(value, str) or len(value) > 8192:
        raise MetaError("Instagram requires an expiring public media URL from Ziipa storage.")
    try:
        parsed = urlsplit(value)
        approved = {url.strip().rstrip("/") for url in getattr(settings, "meta_media_origins", "").split(",") if url.strip()}
        origin = f"{parsed.scheme}://{parsed.netloc}"
        host = parsed.hostname
        if (parsed.scheme != "https" or not host or parsed.username or parsed.password or parsed.fragment
                or parsed.port not in (None, 443) or origin not in approved or not parsed.path or parsed.path == "/"
                or host == "localhost" or host.endswith((".localhost", ".local"))):
            raise ValueError("Unapproved media origin")
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address is not None and not address.is_global:
            raise ValueError("Private media host")
    except ValueError as exc:
        raise MetaError("Instagram media must use an approved public HTTPS storage origin.") from exc
    return value


async def _checkpoint(checkpoint, data: dict) -> dict:
    # Data is built exclusively here from strict IDs and phase constants. Never
    # include source URLs, returned upload URLs, OAuth or Page access tokens.
    if not callable(checkpoint):
        raise MetaError("Durable provider job checkpointing is required.")
    result = checkpoint(dict(data))
    if inspect.isawaitable(result):
        await result
    return data


def _outcome(status: str, detail: str, state: dict, external_id="", external_url="") -> dict:
    return {"status": status, "detail": detail, "external_id": external_id,
            "external_url": external_url, "provider_data": dict(state)}


def _instagram_permalink(value) -> str:
    if not isinstance(value, str) or len(value) > 500:
        return ""
    try:
        parsed = urlsplit(value)
    except ValueError:
        return ""
    return value if (parsed.scheme == "https" and parsed.netloc in ("www.instagram.com", "instagram.com")
                     and re.fullmatch(r"/(?:reel|p|tv)/[A-Za-z0-9_-]+/?", parsed.path)
                     and not parsed.query and not parsed.fragment) else ""


async def _try_instagram_permalink(client, media_id, page_token, settings) -> str:
    # Publication already has a confirmed, durably checkpointed ID. An optional
    # link lookup must not downgrade it or trigger another media_publish call.
    try:
        async with asyncio.timeout(PERMALINK_TIMEOUT_SECONDS):
            result = await _json(client, "GET", _graph(settings, media_id),
                                 **_authorized(page_token, settings, {"fields": "id,permalink"}))
        if result.get("id") == media_id:
            return _instagram_permalink(result.get("permalink"))
    except (MetaError, TimeoutError):
        pass
    return ""


async def _check_target(client, provider, page_id, target_id, page_token, settings):
    fields = "id,instagram_business_account" if provider == "instagram" else "id"
    page = await _json(client, "GET", _graph(settings, page_id), **_authorized(page_token, settings, {"fields": fields}))
    if page.get("id") != page_id:
        raise MetaError("The authorized Facebook Page no longer matches this destination.", reconnect=True)
    if provider == "instagram":
        instagram = page.get("instagram_business_account")
        if not isinstance(instagram, dict) or instagram.get("id") != target_id:
            raise MetaError("The linked Instagram account changed. Reconnect and choose it again.", reconnect=True)


async def publish_prepare(tokens: dict, target_id: str, source: dict, client, settings, checkpoint) -> dict:
    provider, page_token, page_id = _credentials(tokens, target_id)
    if source.get("content_type") not in ("video/mp4", "video/quicktime"):
        raise MetaError("Meta publishing accepts original MP4 or MOV videos in this adapter.")
    size = source.get("size")
    if not isinstance(size, int) or isinstance(size, bool) or not 1 <= size <= MAX_MEDIA_BYTES:
        raise MetaError("This Meta adapter accepts videos up to 25 MB.")
    title = str(source.get("title", "")).strip()
    description = str(source.get("description", "")).strip()
    caption = description or title
    if len(caption) > 2200 or len(title) > 100:
        raise MetaError("Use a title up to 100 characters and a Meta caption up to 2,200 characters.")
    media_url = _media_url(source.get("url"), settings) if provider == "instagram" else None
    data = source.get("bytes")
    if provider == "facebook" and (not isinstance(data, bytes) or len(data) != size):
        raise MetaError("The owned original video bytes do not match the upload record.")
    await _check_target(client, provider, page_id, target_id, page_token, settings)
    state = {"provider": provider, "target_id": target_id, "phase": "create_started"}
    await _checkpoint(checkpoint, state)
    try:
        if provider == "instagram":
            result = await _json(client, "POST", _graph(settings, target_id + "/media"), write=True,
                                 **_authorized(page_token, settings), data={"media_type": "REELS", "video_url": media_url,
                                                                        "caption": caption, "share_to_feed": "true"})
            container = _written_identifier(result.get("id"))
            state.update(phase="container_created", container_id=container)
            await _checkpoint(checkpoint, state)
            return _outcome("processing", "Instagram is preparing the video. Refresh this receipt to publish once processing is ready.", state)
        result = await _json(client, "POST", _graph(settings, page_id + "/video_reels"), write=True,
                             **_authorized(page_token, settings), data={"upload_phase": "start"})
        video_id = _written_identifier(result.get("video_id"))
        # Generate the sole allowed upload endpoint ourselves. An arbitrary
        # upload_url returned by Meta can never receive the Page credential.
        upload_url = f"https://rupload.facebook.com/video-upload/{settings.meta_graph_version}/{video_id}"
        if result.get("upload_url") != upload_url:
            state.update(phase="upload_unverified", video_id=video_id)
            await _checkpoint(checkpoint, state)
            return _outcome("uncertain", "Meta returned an upload address outside the supported contract. No video was transferred.", state, video_id)
        state.update(phase="upload_started", video_id=video_id)
        await _checkpoint(checkpoint, state)
        result = await _json(client, "POST", upload_url, write=True, headers={"Authorization": "OAuth " + page_token,
                             "offset": "0", "file_size": str(size), "Content-Type": "application/octet-stream"}, content=data)
        if result.get("success") is not True:
            return _outcome("uncertain", "Facebook did not confirm the binary upload. Inspect the Page before trying again.", state, video_id)
        state["phase"] = "publish_started"
        await _checkpoint(checkpoint, state)
        result = await _json(client, "POST", _graph(settings, page_id + "/video_reels"), write=True,
                             **_authorized(page_token, settings), data={"video_id": video_id, "upload_phase": "finish",
                              "video_state": "PUBLISHED", "description": caption, "title": title})
        if result.get("success") is not True:
            return _outcome("uncertain", "Facebook did not confirm the publish request. Inspect the Page before trying again.", state, video_id)
        state["phase"] = "submitted"
        await _checkpoint(checkpoint, state)
        return _outcome("processing", "Facebook accepted the Reel. Processing and publication still require verification.", state, video_id)
    except MetaError as exc:
        return _outcome("uncertain" if exc.uncertain or state["phase"] != "create_started" else "rejected",
                        str(exc), state, state.get("video_id", ""))


def _job_state(tokens, target_id, job_data) -> dict:
    state = job_data.get("provider_data") if isinstance(job_data, dict) else None
    if not isinstance(state, dict) or state.get("provider") != tokens.get("provider") or state.get("target_id") != target_id:
        raise MetaError("The stored provider receipt does not match this destination.")
    allowed = {"provider", "target_id", "phase", "video_id", "container_id", "media_id"}
    if set(state) - allowed:
        raise MetaError("The stored provider receipt has unsupported fields.")
    for key in ("video_id", "container_id", "media_id"):
        if key in state:
            _identifier(state[key])
    return dict(state)


async def poll(tokens: dict, target_id: str, job_data: dict, client, settings, checkpoint) -> dict:
    provider, page_token, page_id = _credentials(tokens, target_id)
    state = _job_state(tokens, target_id, job_data)
    await _check_target(client, provider, page_id, target_id, page_token, settings)
    if provider == "facebook":
        video_id = state.get("video_id")
        if not video_id:
            return _outcome("uncertain", "The first Facebook request has no verified video ID. Check the Page; Ziipa will not repost.", state)
        result = await _json(client, "GET", _graph(settings, video_id), **_authorized(page_token, settings, {"fields": "id,status"}))
        if result.get("id") != video_id:
            raise MetaError("Facebook returned a different video receipt.")
        status = result.get("status")
        if not isinstance(status, dict):
            raise MetaError("Facebook did not return a verifiable processing status.")
        publishing = status.get("publishing_phase")
        phases = [status.get(name) for name in ("uploading_phase", "processing_phase", "publishing_phase")]
        if status.get("video_status") == "error" or any(isinstance(phase, dict) and phase.get("status") == "error" for phase in phases):
            return _outcome("rejected", "Facebook reported an upload, processing or publishing failure.", state, video_id)
        if isinstance(publishing, dict) and publishing.get("status") == "complete":
            state["phase"] = "delivered"
            return _outcome("delivered", "Facebook confirmed that the Reel was published to the selected Page.", state, video_id,
                            f"https://www.facebook.com/reel/{video_id}")
        if state.get("phase") not in ("publish_started", "submitted", "delivered"):
            return _outcome("uncertain", "The Facebook transfer was interrupted before publication was confirmed. Inspect the Page; no automatic retry will run.", state, video_id)
        return _outcome("processing", "Facebook has not confirmed publication yet. No repeat upload was started.", state, video_id)
    container = state.get("container_id")
    if not container:
        return _outcome("uncertain", "The Instagram preparation request has no verified container ID. Check Instagram; Ziipa will not repost.", state)
    if state.get("media_id"):
        media_id = state["media_id"]
        result = await _json(client, "GET", _graph(settings, media_id), **_authorized(page_token, settings, {"fields": "id,permalink"}))
        if result.get("id") != media_id:
            raise MetaError("Instagram returned an inconsistent published media receipt.")
        url = _instagram_permalink(result.get("permalink"))
        return _outcome("delivered", "Instagram confirmed the published Reel.", state, media_id, url)
    result = await _json(client, "GET", _graph(settings, container), **_authorized(page_token, settings, {"fields": "id,status_code"}))
    if result.get("id") != container:
        raise MetaError("Instagram returned an inconsistent container receipt.")
    status = result.get("status_code")
    if status in ("ERROR", "EXPIRED"):
        return _outcome("rejected", "Instagram reported that the media container failed or expired.", state)
    # A lost media_publish response cannot be safely repeated, even if the
    # provider still reports FINISHED. Only an explicit verified ID is delivered.
    if state.get("phase") != "container_created" or status == "PUBLISHED":
        return _outcome("uncertain", "Instagram publication was attempted but its media ID was not saved. Check Instagram directly; Ziipa will not repeat media_publish.", state)
    if status != "FINISHED":
        return _outcome("processing", "Instagram is still processing the video. Publication will wait until it is ready.", state)
    state["phase"] = "publish_started"
    await _checkpoint(checkpoint, state)
    try:
        result = await _json(client, "POST", _graph(settings, target_id + "/media_publish"), write=True,
                             **_authorized(page_token, settings), data={"creation_id": container})
        media_id = _identifier(result.get("id"))
    except MetaError as exc:
        return _outcome("uncertain", "Instagram publication could not be confirmed. Check Instagram before any further attempt.", state)
    state.update(phase="delivered", media_id=media_id)
    await _checkpoint(checkpoint, state)
    link = await _try_instagram_permalink(client, media_id, page_token, settings)
    return _outcome("delivered", "Instagram confirmed the published Reel." if link else
                    "Instagram confirmed the published Reel. Its public link is not available yet; view it in Instagram.",
                    state, media_id, link)


async def revoke(tokens: dict, client, settings) -> bool:
    """Revokes this Meta app authorization, which may cover FB and IG together."""
    try:
        result = await _json(client, "DELETE", _graph(settings, "me/permissions"),
                             **_authorized(tokens.get("access_token"), settings))
        return result.get("success") is True
    except MetaError:
        return False
