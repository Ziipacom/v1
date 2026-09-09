import { NodeOAuthClient } from '@atproto/oauth-client-node';
import { JoseKey } from '@atproto/jwk-jose';
import { Agent } from '@atproto/api';
import { allowedUrl, safeFetch } from './network.mjs';

export const SCOPE = 'atproto repo:app.bsky.feed.post?action=create blob:video/mp4';
const DID = /^did:plc:[a-z2-7]{24}$/;
const HANDLE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const clone = value => JSON.parse(JSON.stringify(value));
const store = values => ({ async get(k) { return values[k]; }, async set(k, v) { values[k] = clone(v); }, async del(k) { delete values[k]; } });

export async function execute(input, fetchOverride, onTestError) {
  const states = clone(input.states || {}), sessions = clone(input.sessions || {});
  const output = (result, ok = true) => ({ ok, result, states, sessions });
  try {
    const origin = new URL(input.origin);
    if (origin.protocol !== 'https:' || origin.origin !== input.origin) throw new Error('Invalid client origin');
    const extras = (input.extra_origins || []).map(value => {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.port) throw new Error('Invalid approved PDS');
      return value;
    });
    const privateJwk = input.private_jwk;
    if (!privateJwk || privateJwk.kty !== 'EC' || privateJwk.crv !== 'P-256' || !privateJwk.d || !privateJwk.kid) throw new Error('Invalid client signing key');
    const key = await JoseKey.fromJWK(privateJwk);
    const fetch = fetchOverride || safeFetch(extras);
    const locks = new Map();
    const client = new NodeOAuthClient({
      clientMetadata: { client_id: input.origin + '/api/publishing/oauth/bluesky/client-metadata.json',
        client_name: 'Ziipa Studio', client_uri: input.origin,
        redirect_uris: [input.origin + '/api/publishing/oauth/bluesky/callback'],
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], application_type: 'web',
        scope: SCOPE, token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_signing_alg: 'ES256',
        dpop_bound_access_tokens: true, jwks_uri: input.origin + '/api/publishing/oauth/bluesky/jwks.json' },
      keyset: [key], stateStore: store(states), sessionStore: store(sessions), fetch,
      requestLock: async (key, fn) => { const previous = locks.get(key) || Promise.resolve(); const next = previous.catch(() => {}).then(fn); locks.set(key, next); try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); } },
      handleResolver: { async resolve(handle) {
        if (!HANDLE.test(handle)) throw new Error('Invalid handle');
        const response = await fetch('https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=' + encodeURIComponent(handle));
        const body = await response.json();
        if (!response.ok || !DID.test(body.did)) throw new Error('Only verified PLC identities are supported');
        return body.did;
      } },
      didResolver: { async resolve(did) {
        if (!DID.test(did)) throw new Error('Unsupported DID method');
        const response = await fetch('https://plc.directory/' + did);
        const document = await response.json();
        if (!response.ok || document.id !== did) throw new Error('DID document mismatch');
        for (const service of document.service || []) if (service.type === 'AtprotoPersonalDataServer') allowedUrl(service.serviceEndpoint, extras);
        return document;
      } },
    });
    if (input.operation === 'metadata') return output({ metadata: client.clientMetadata, jwks: client.jwks });
    if (input.operation === 'authorize') {
      if (!HANDLE.test(input.handle)) throw new Error('Invalid handle');
      const url = await client.authorize(input.handle, { state: input.app_state, scope: SCOPE });
      allowedUrl(url.href, extras);
      const savedStates = Object.keys(states);
      if (savedStates.length !== 1) throw new Error('Unexpected OAuth state count');
      return output({ auth_url: url.href, state: savedStates[0] });
    }
    let session;
    if (input.operation === 'callback') {
      const result = await client.callback(new URLSearchParams(input.params));
      if (result.state !== input.app_state) throw new Error('App state mismatch');
      session = result.session;
    } else {
      if (!DID.test(input.did) || !sessions[input.did]) throw new Error('Invalid stored identity');
      session = await client.restore(input.did, input.operation === 'refresh' ? true : 'auto');
    }
    if (!DID.test(session.did)) throw new Error('Unsupported account DID');
    const info = await session.getTokenInfo();
    if (!info.scope.split(' ').includes('repo:app.bsky.feed.post?action=create') || !info.scope.split(' ').includes('blob:video/mp4')) throw new Error('Required publishing permissions not granted');
    allowedUrl(info.aud, extras); allowedUrl(info.iss, extras);
    if (['plc.directory', 'public.api.bsky.app'].includes(new URL(info.aud).hostname)) throw new Error('Invalid credential audience');
    if (input.operation === 'callback' || input.operation === 'refresh') {
      return output({ did: session.did, token_info: { expires_at: info.expiresAt?.getTime() / 1000 || 0 },
        targets: [{ id: session.did, name: input.handle || session.did, kind: 'bluesky_account', url: 'https://bsky.app/profile/' + session.did }] });
    }
    if (input.operation === 'revoke') { await session.signOut(); return output({ revoked: true }); }
    const agent = new Agent(session);
    if (input.operation === 'upload') {
      const bytes = Buffer.from(input.media_base64, 'base64');
      if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error('Invalid video size');
      const response = await agent.uploadBlob(bytes, { encoding: 'video/mp4' });
      const blob = clone(response.data.blob);
      if (blob.mimeType !== 'video/mp4' || blob.size !== bytes.length || !blob.ref?.$link) throw new Error('Invalid video blob receipt');
      return output({ did: session.did, blob });
    }
    if (!/^[a-z0-9]{32}$/.test(input.rkey)) throw new Error('Invalid record key');
    const uri = `at://${session.did}/app.bsky.feed.post/${input.rkey}`;
    if (input.operation === 'create') {
      const response = await agent.com.atproto.repo.createRecord({ repo: session.did, collection: 'app.bsky.feed.post', rkey: input.rkey, record: input.record, validate: true });
      if (response.data.uri !== uri || !response.data.cid) throw new Error('Invalid creation receipt');
      return output({ uri, cid: response.data.cid });
    }
    if (input.operation === 'status') {
      const response = await agent.com.atproto.repo.getRecord({ repo: session.did, collection: 'app.bsky.feed.post', rkey: input.rkey });
      const value = response.data.value;
      if (response.data.uri !== uri || !response.data.cid || value.text !== input.record.text || value.createdAt !== input.record.createdAt
          || value.embed?.video?.ref?.toString() !== input.record.embed.video.ref.$link && value.embed?.video?.ref?.$link !== input.record.embed.video.ref.$link) throw new Error('Stored record does not match approved content');
      const publicResponse = await fetch('https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=' + encodeURIComponent(uri));
      const posts = (await publicResponse.json()).posts;
      const view = Array.isArray(posts) && posts.find(post => post.uri === uri && post.cid === response.data.cid);
      return output({ uri, cid: response.data.cid, video_ready: !!(view?.embed?.$type === 'app.bsky.embed.video#view' && typeof view.embed.playlist === 'string' && view.embed.playlist.startsWith('https://')) });
    }
    throw new Error('Unsupported operation');
  } catch (error) { onTestError?.(error); return output({ error: 'AT Protocol operation could not be verified.' }, false); }
}

if (process.argv[1] && import.meta.url === new URL('file:///' + process.argv[1].replaceAll('\\', '/').replace(/^\//, '')).href) {
  // Only structured stdin/stdout. Never print provider errors, tokens or keys.
  console.log = console.warn = console.error = () => {};
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 37 * 1024 * 1024) process.exit(1); }
  try { process.stdout.write(JSON.stringify(await execute(JSON.parse(input)))); }
  catch { process.stdout.write(JSON.stringify({ ok: false, result: { error: 'Invalid bridge request.' } })); }
}
