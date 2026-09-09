#!/usr/bin/env python3
"""Read-only Ziipa deployment smoke check; Python standard library only.

Run: python scripts/check-production-readiness.py
Exit 0: public deployment checks passed; 1: missing/unready routes; 2: CLI error.
Only fixed HTTPS GETs are sent. No credentials, cookies, OAuth authorization,
account creation, uploads or broadcasts are performed. A 401 on protected
configuration routes proves the authentication boundary, not provider/worker
readiness. Response bodies, cookies, redirects and public key values are never
printed. The final result is not release approval or a user-flow acceptance test.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import re
import socket
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


WEBSITE = "https://ziipa.com"
API = "https://api.ziipa.com"
MAX_RESPONSE_BYTES = 1024 * 1024
METADATA_PATH = "/api/publishing/oauth/bluesky/client-metadata.json"
JWKS_PATH = "/api/publishing/oauth/bluesky/jwks.json"


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def cases():
    result = [(WEBSITE + "/", "html"), (WEBSITE + "/portal", "html"),
              (WEBSITE + "/studio/index.html", "studio")]
    for origin in (API, WEBSITE):
        result.extend((origin + path, kind) for path, kind in (
            ("/api/health", "health"), ("/api/live/config", "live"),
            ("/api/publishing/config", "authenticated"),
            ("/api/render/config", "authenticated"),
            (METADATA_PATH, "metadata"), (JWKS_PATH, "jwks")))
    return result


def validate(kind, status, content_type, body):
    """Return only fixed messages and a bounded allowlisted facts dictionary."""
    if kind in ("html", "studio"):
        if status != 200 or content_type != "text/html":
            return False, "Expected HTTP 200 HTML page", {}
        lower = body.lower()
        if b"<html" not in lower and b"<!doctype html" not in lower:
            return False, "Response is not an HTML document", {}
        if kind == "studio" and b"/studio/_expo/" not in body:
            return False, "Shared Studio asset prefix missing; possible fallback page", {}
        return True, "HTML route available", {}

    expected = 401 if kind == "authenticated" else 200
    if status != expected or content_type != "application/json":
        return False, f"Expected HTTP {expected} JSON response", {}
    try:
        value = json.loads(body)
    except (ValueError, UnicodeError):
        return False, "Invalid JSON response", {}
    if not isinstance(value, dict):
        return False, "Expected JSON object", {}

    if kind == "authenticated":
        ok = isinstance(value.get("detail"), str)
        return ok, "Unauthenticated request rejected; internal readiness not tested", {}
    if kind == "health":
        fields = {
            "database": {"connected", "unavailable"},
            "redis": {"connected", "unavailable"},
            "media_storage": {"r2", "local"},
            "email": {"configured", "demo"},
            "environment": {"production", "demo", "development", "test"},
        }
        facts = {key: value.get(key) if isinstance(value.get(key), str) and value[key] in allowed else "unrecognized"
                 for key, allowed in fields.items()}
        ok = (facts["database"] == facts["redis"] == "connected"
              and facts["media_storage"] == "r2" and facts["email"] == "configured")
        return ok, "Database, session storage, media and email configuration checked", facts
    if kind == "live":
        facts = {
            "configured": value.get("configured") is True,
            "native_whip": value.get("native_ingest") == "whip",
            "browser_whip": value.get("browser_ingest") == "whip",
            "twitch_relay_implemented": value.get("twitch_simulcast") is True,
        }
        ok = all(facts.values()) and value.get("provider") == "livepeer"
        return ok, "Live configuration checked; no broadcast or Twitch authorization tested", facts
    if kind == "metadata":
        ok = (value.get("client_id") == WEBSITE + METADATA_PATH
              and value.get("client_uri") == WEBSITE
              and value.get("jwks_uri") == WEBSITE + JWKS_PATH
              and value.get("redirect_uris") == [WEBSITE + "/api/publishing/oauth/bluesky/callback"]
              and value.get("token_endpoint_auth_method") == "private_key_jwt"
              and value.get("token_endpoint_auth_signing_alg") == "ES256"
              and value.get("dpop_bound_access_tokens") is True)
        return ok, "Canonical Bluesky public OAuth metadata checked; no authorization initiated", {}
    if kind == "jwks":
        keys = value.get("keys")
        private_fields = {"d", "p", "q", "dp", "dq", "qi", "oth", "k"}
        ok = isinstance(keys, list) and 0 < len(keys) <= 10 and all(
            isinstance(key, dict) and not private_fields.intersection(key)
            and key.get("kty") == "EC" and key.get("crv") == "P-256"
            and isinstance(key.get("kid"), str) and 0 < len(key["kid"]) <= 100
            and all(isinstance(key.get(part), str)
                    and re.fullmatch(r"[A-Za-z0-9_-]{43}", key[part]) for part in ("x", "y"))
            for key in keys)
        return bool(ok), "Public JWK shape checked; private fields must be absent", {}
    return False, "Unknown check", {}


def check(case, timeout, retries):
    url, kind = case
    # No cookie jar, environment proxy credentials, redirect following or auth.
    opener = build_opener(ProxyHandler({}), NoRedirects())
    result = {"url": url, "check": kind, "passed": False}
    for attempt in range(retries + 1):
        result["attempts"] = attempt + 1
        started = time.monotonic()
        try:
            request = Request(url, method="GET", headers={
                "Accept": "text/html" if kind in ("html", "studio") else "application/json",
                "User-Agent": "Ziipa-readonly-deployment-check/1.0",
            })
            try:
                response = opener.open(request, timeout=timeout)
            except HTTPError as error:
                response = error  # Inspect status, never print upstream error content.
            with response:
                status = response.status
                raw_type = response.headers.get_content_type().lower()
                content_type = raw_type if raw_type in ("application/json", "text/html") else "other"
                chunks, size = [], 0
                while size <= MAX_RESPONSE_BYTES:
                    if time.monotonic() - started >= timeout:
                        raise TimeoutError("Response deadline exceeded")
                    chunk = response.read1(min(65536, MAX_RESPONSE_BYTES + 1 - size))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    size += len(chunk)
                body = b"".join(chunks)
            result.update(status=status, content_type=content_type,
                          elapsed_seconds=round(time.monotonic() - started, 2))
            if len(body) > MAX_RESPONSE_BYTES:
                result["detail"] = "Response exceeded the size limit"
                return result
            passed, detail, facts = validate(kind, status, content_type, body)
            result.update(passed=passed, detail=detail)
            if facts:
                result["facts"] = facts
            # One bounded GET retry permits a sleeping API to finish waking.
            if status in (502, 503, 504) and attempt < retries:
                continue
            return result
        except (URLError, TimeoutError, socket.timeout, OSError, ValueError):
            result["detail"] = "Connection, TLS, timeout or response error; sensitive details omitted"
            result["elapsed_seconds"] = round(time.monotonic() - started, 2)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=int, default=30, choices=range(5, 61), metavar="5..60")
    parser.add_argument("--retries", type=int, default=1, choices=(0, 1), help="bounded GET retries for cold starts")
    args = parser.parse_args()
    checks = cases()
    print(json.dumps({"checked_at_utc": datetime.now(timezone.utc).isoformat(),
                      "mode": "unauthenticated fixed-origin GET only", "checks": len(checks)}), flush=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda case: check(case, args.timeout, args.retries), checks))
    for result in results:
        print(json.dumps(result, sort_keys=True), flush=True)
    failed = sum(not result["passed"] for result in results)
    print(json.dumps({"passed": len(results) - failed, "failed": failed,
                      "acceptance_not_tested": ["registration", "email delivery", "user OAuth",
                                                "publishing", "broadcasting", "render worker execution",
                                                "physical devices", "provider approval"]}), flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
