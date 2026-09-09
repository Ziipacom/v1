# Meta publishing adapter

`meta_publishing_adapter.py` implements Facebook Page Reels and Instagram
professional Reels through **Facebook Login**. Personal Facebook timelines and
consumer Instagram accounts are not destinations. The Instagram account must be
linked to a managed Facebook Page. The adapter deliberately does not mix
Instagram Login's `instagram_business_*` permissions with Facebook Login scopes.
See [Meta's Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api).

Operator configuration, managed by the publishing orchestration service:

- `PUBLISHING_META_CLIENT_ID` and `PUBLISHING_META_CLIENT_SECRET`: a Meta developer
  app with the required products and permissions. Store the secret only on the API.
- `PUBLISHING_META_GRAPH_VERSION`: an explicit version supported by that developer
  app. No version is silently selected; test fixtures' version is not a production
  approval or compatibility claim.
- `PUBLISHING_META_MEDIA_ORIGINS`: comma-separated HTTPS origins allowed to serve
  Ziipa-owned, expiring signed originals to Instagram. Use the actual R2 media
  origin. A public source URL must remain valid while Meta retrieves the video.
- The shared stable publishing encryption key and approved same-origin OAuth
  callbacks must also be configured. Register both Facebook and Instagram callback
  URLs exactly. Never use a broad cookie Domain to solve callback origin mismatch.

Facebook requests `pages_show_list`, `pages_read_engagement`, and
`pages_manage_posts`; Instagram requests `pages_show_list`,
`pages_read_engagement`, `instagram_basic`, and `instagram_content_publish`.
The exchange verifies granted permissions, then discovers eligible Page targets.
The UI must show those targets and require an explicit choice. Meta app review,
Advanced Access where required, and eligible account roles remain external
prerequisites; local mocked tests do not grant them.

The transport follows [Meta's Facebook Reels contract](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api):
start a Page Reel, transfer the original to the fixed `rupload.facebook.com`
endpoint, finish publication, and query processing status. A successful transfer
or finish request is reported as processing; a completed publishing phase is
required for delivered status. Only MP4/MOV originals up to 25 MB are accepted by
this bounded adapter. Meta may additionally reject unsupported duration, shape,
codecs, or content. Ziipa overlays and music are not rendered into these originals.

Instagram first creates a Reel container from an approved storage URL. A later
receipt refresh checks readiness and performs `media_publish` once. The service
does not automatically spin in a polling loop. A verified published media ID is
required before reporting delivery. A short best-effort permalink lookup follows
the durable delivery checkpoint in the same operation; missing, malformed or
timed-out links leave the confirmed delivery intact. An interrupted final publish
cannot be repeated blindly.

Integration contract:

```python
authorization_url(provider, settings, redirect_uri, state)
await exchange(code, redirect_uri, client, provider, settings)
await publish_prepare(tokens, target_id, source, client, settings, checkpoint)
await poll(tokens, target_id, job_data, client, settings, checkpoint)
await revoke(tokens, client, settings)
```

`exchange` returns `tokens` and public `targets`. **All of `tokens`, including
`page_tokens`, must be encrypted together**; never merge it into targets, account
exports, logs, browser messages, or responses. `source` contains verified owned
`bytes`, `size`, `content_type`, `title`, `description`, and, for Instagram, `url`.
The adapter never fetches a caller-provided media URL itself.

The async `checkpoint(provider_data)` must commit the stage to the owned job
before returning, under the orchestration layer's exclusive job/grant lease.
Receipt refresh passes `{provider_data, external_id, status}`. A processing
Instagram job may have a container ID in provider_data and no external ID yet.
Checkpoints contain only validated IDs, the provider, target, and stage—not
signed URLs, credentials, or media bytes. Missing or failed checkpointing stops
the next provider write.

`MetaError` contains safe error text plus `reconnect` and `uncertain` flags.
Reconnect is required on expiry; Facebook uses a long-lived token exchange,
not a standard refresh-token grant. Provider failures never contain raw response
bodies or tokens in public errors. Unknown writes must stay blocked from automatic
reposting in the shared job orchestration.

Disconnect uses `DELETE /me/permissions`. This revokes the app's Meta access and
can also invalidate the user's other Meta connection. Tell the user and mark a
sibling Facebook/Instagram grant as requiring reconnection. Existing provider
posts remain on their network.

Run isolated checks with `python -m pytest test_meta_publishing_adapter.py -q`.
They use `httpx.MockTransport` only and do not read a real database or post to any
account. Before enabling a live integration, test with designated app-role
accounts, representative videos, real registered callbacks, and permission
revocation. No real provider approval or live publication has been verified here.
