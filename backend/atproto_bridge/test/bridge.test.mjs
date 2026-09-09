import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { JoseKey } from '@atproto/jwk-jose';
import { execute, SCOPE } from '../bridge.mjs';
import { allowedUrl, isPublicAddress, safeFetch } from '../network.mjs';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const PDS = 'https://shiitake.us-east.host.bsky.network';
const CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
const freshInput = async () => ({ origin: 'https://ziipa.example.test', private_jwk: (await JoseKey.generate(['ES256'], 'ziipa-test')).privateJwk });

test('metadata exposes public key only and narrow create/video permissions', async () => {
  const input = await freshInput();
  const output = await execute({ ...input, operation: 'metadata' }, () => { throw new Error('Metadata must not perform network requests'); });
  assert.equal(output.ok, true);
  assert.equal(output.result.metadata.scope, SCOPE);
  assert.equal(output.result.metadata.token_endpoint_auth_method, 'private_key_jwt');
  assert.equal(output.result.metadata.dpop_bound_access_tokens, true);
  assert.equal(output.result.jwks.keys[0].d, undefined);
  assert.equal(output.result.jwks.keys[0].x, input.private_jwk.x);
});

test('official SDK performs identity binding, PKCE, DPoP and PAR with encrypted-store-compatible state', async () => {
  const input = await freshInput();
  const requests = [];
  let savedRecord;
  const fetch = async (value, init) => {
    const request = new Request(value, init); const url = new URL(request.url); requests.push(request);
    let result;
    if (url.hostname === 'public.api.bsky.app') result = url.pathname.endsWith('resolveHandle') ? { did: DID } : { posts: [{ uri: `at://${DID}/app.bsky.feed.post/${'a'.repeat(32)}`, cid: CID,
      embed: { $type: 'app.bsky.embed.video#view', playlist: 'https://video.bsky.app/watch/test/playlist.m3u8' } }] };
    else if (url.hostname === 'plc.directory') result = { '@context': ['https://www.w3.org/ns/did/v1'], id: DID,
      alsoKnownAs: ['at://creator.bsky.social'], service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] };
    else if (url.origin === PDS && url.pathname.includes('.well-known')) result = { resource: PDS, authorization_servers: ['https://bsky.social'] };
    else if (url.pathname.includes('.well-known')) result = { issuer: 'https://bsky.social', authorization_endpoint: 'https://bsky.social/oauth/authorize',
      token_endpoint: 'https://bsky.social/oauth/token', pushed_authorization_request_endpoint: 'https://bsky.social/oauth/par',
      revocation_endpoint: 'https://bsky.social/oauth/revoke', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['ES256'],
      dpop_signing_alg_values_supported: ['ES256'], code_challenge_methods_supported: ['S256'], require_pushed_authorization_requests: true,
      authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: true };
    else if (url.pathname === '/oauth/par') {
      const form = new URLSearchParams(await request.text());
      assert.equal(form.get('scope'), SCOPE); assert.equal(form.get('code_challenge_method'), 'S256');
      assert.ok(form.get('client_assertion')); assert.ok(request.headers.get('dpop'));
      result = { request_uri: 'urn:ietf:params:oauth:request_uri:test', expires_in: 60 };
    } else if (url.pathname === '/oauth/token') {
      const form = new URLSearchParams(await request.text());
      assert.ok(form.get('code_verifier')); assert.ok(request.headers.get('dpop'));
      result = { token_type: 'DPoP', access_token: 'TEST_DPOP_ACCESS', refresh_token: 'TEST_DPOP_REFRESH', sub: DID, scope: SCOPE, expires_in: 3600 };
    } else if (url.origin === PDS && url.pathname.endsWith('uploadBlob')) {
      assert.equal(request.headers.get('authorization'), 'DPoP TEST_DPOP_ACCESS'); assert.ok(request.headers.get('dpop'));
      result = { blob: { $type: 'blob', ref: { $link: CID }, mimeType: 'video/mp4', size: (await request.arrayBuffer()).byteLength } };
    } else if (url.origin === PDS && url.pathname.endsWith('createRecord')) {
      assert.equal(request.headers.get('authorization'), 'DPoP TEST_DPOP_ACCESS'); assert.ok(request.headers.get('dpop'));
      const data = await request.json(); savedRecord = data.record;
      assert.equal(data.repo, DID); assert.equal(data.collection, 'app.bsky.feed.post'); assert.equal(data.rkey, 'a'.repeat(32));
      result = { uri: `at://${DID}/app.bsky.feed.post/${data.rkey}`, cid: CID };
    } else if (url.origin === PDS && url.pathname.endsWith('getRecord')) {
      result = { uri: `at://${DID}/app.bsky.feed.post/${'a'.repeat(32)}`, cid: CID, value: savedRecord };
    } else throw new Error('Unexpected test provider operation');
    const response = new Response(JSON.stringify(result), { status: url.pathname === '/oauth/par' ? 201 : 200, headers: { 'Content-Type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: request.url });
    return response;
  };
  let issue;
  const output = await execute({ ...input, operation: 'authorize', handle: 'creator.bsky.social', app_state: 'ziipa-bound-state' }, fetch, error => { issue = error; });
  assert.equal(output.ok, true, issue?.message + ': ' + issue?.cause?.message);
  const state = output.states[output.result.state];
  assert.equal(state.appState, 'ziipa-bound-state'); assert.ok(state.verifier); assert.ok(state.dpopJwk.d);
  assert.match(output.result.auth_url, /^https:\/\/bsky.social\/oauth\/authorize\?/);
  assert.equal(new URL(output.result.auth_url).searchParams.get('state'), null); // State belongs to PAR, not the browser URL.
  assert.equal(requests.filter(r => new URL(r.url).pathname === '/oauth/par').length, 1);
  const callback = await execute({ ...input, operation: 'callback', app_state: 'ziipa-bound-state', states: output.states,
    params: { state: output.result.state, code: 'TEST_CALLBACK_CODE', iss: 'https://bsky.social' } }, fetch, error => { issue = error; });
  assert.equal(callback.ok, true, issue?.message + ': ' + issue?.cause?.message);
  assert.equal(callback.result.did, DID); assert.ok(callback.sessions[DID].dpopJwk.d);
  assert.equal(Object.keys(callback.states).length, 0);
  const uploaded = await execute({ ...input, operation: 'upload', did: DID, sessions: callback.sessions, media_base64: Buffer.alloc(100).toString('base64') }, fetch);
  assert.equal(uploaded.ok, true);
  const record = { $type: 'app.bsky.feed.post', text: 'My approved film', createdAt: '2026-09-09T12:00:00.000Z', embed: { $type: 'app.bsky.embed.video', video: uploaded.result.blob } };
  const created = await execute({ ...input, operation: 'create', did: DID, sessions: uploaded.sessions, rkey: 'a'.repeat(32), record }, fetch);
  assert.equal(created.ok, true);
  const checked = await execute({ ...input, operation: 'status', did: DID, sessions: created.sessions, rkey: 'a'.repeat(32), record }, fetch);
  assert.equal(checked.ok, true); assert.equal(checked.result.video_ready, true);
  const badCallback = await execute({ ...input, operation: 'callback', app_state: 'other-owner', states: output.states,
    params: { state: output.result.state, code: 'TEST_CODE', iss: 'https://evil.example.test' } }, fetch);
  assert.equal(badCallback.ok, false);
});

test('SSRF guard rejects private addresses, userinfo, redirects and unapproved origins before transport', async () => {
  for (const url of ['http://bsky.social/oauth/token', 'https://bsky.social@localhost/', 'https://bsky.social.evil.test/', 'https://127.0.0.1/', 'https://bsky.social:8443/', 'https://bsky.social/#x']) assert.throws(() => allowedUrl(url));
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fc00::1', '::ffff:127.0.0.1', '0.0.0.0', '192.168.1.1']) assert.equal(isPublicAddress(ip), false);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  const fetch = safeFetch([], async () => [{ address: '127.0.0.1', family: 4 }], () => { throw new Error('Transport must not be invoked'); });
  await assert.rejects(fetch('https://bsky.social/.well-known/oauth-authorization-server'), /Non-public/);
  await assert.rejects(fetch('https://public.api.bsky.app/xrpc/a', { headers: { Authorization: 'DPoP test-secret' } }), /forbidden/);
});

test('malicious DID service never starts OAuth requests against an arbitrary resource', async () => {
  const output = await execute({ ...(await freshInput()), operation: 'authorize', handle: 'creator.bsky.social', app_state: 'state' }, async value => {
    const url = String(value.url || value);
    if (url.startsWith('https://public.api.bsky.app/')) return Response.json({ did: DID });
    if (url.startsWith('https://plc.directory/')) return Response.json({ id: DID, alsoKnownAs: ['at://creator.bsky.social'], service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://localhost/private' }] });
    throw new Error('Unexpected request beyond identity validation');
  });
  assert.equal(output.ok, false); assert.deepEqual(output.sessions, {});
});

test('provider transport pins validated DNS and rejects redirects and oversized responses', async () => {
  for (const scenario of ['success', 'redirect', 'oversized']) {
    let dnsCalls = 0; let pinned;
    const fetch = safeFetch([], async () => { dnsCalls++; return [{ address: '8.8.8.8', family: 4 }]; }, (url, options, callback) => {
      assert.equal(url.hostname, 'bsky.social'); assert.equal(options.agent, false);
      options.lookup('bsky.social', {}, (error, address) => { assert.equal(error, null); pinned = address; });
      const req = new EventEmitter(); req.destroy = () => {};
      req.end = () => queueMicrotask(() => {
        const response = new EventEmitter(); response.statusCode = scenario === 'redirect' ? 302 : 200;
        response.headers = scenario === 'redirect' ? { location: 'https://localhost/private' } : { 'content-type': 'application/json' };
        callback(response);
        response.emit('data', scenario === 'oversized' ? Buffer.alloc(1024 * 1024 + 1) : Buffer.from('{}'));
        response.emit('end');
      });
      return req;
    });
    const operation = fetch('https://bsky.social/oauth/token');
    if (scenario === 'success') assert.equal((await operation).status, 200);
    else await assert.rejects(operation, scenario === 'redirect' ? /redirect forbidden/ : /response too large/);
    assert.equal(dnsCalls, 1); assert.equal(pinned, '8.8.8.8');
  }
});
