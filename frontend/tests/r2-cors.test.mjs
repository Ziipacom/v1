/** Private media CORS boundary checks; no network, provider calls or credentials. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const policy = JSON.parse(readFileSync(new URL('../../infrastructure/r2-cors.json', import.meta.url), 'utf8'));
const productionOrigins = ['https://ziipa.com', 'https://www.ziipa.com', 'https://app.ziipa.com'];

test('R2 CORS retains the existing signed upload grant without broadening writes', () => {
  const writes = policy.rules.filter(rule => rule.allowed.methods.some(method => !['GET', 'HEAD'].includes(method)));
  assert.deepEqual(writes, [{
    allowed: {
      origins: [...productionOrigins, 'http://localhost:5178', 'http://localhost:8082'],
      methods: ['PUT'], headers: ['Content-Type'],
    },
    exposeHeaders: ['ETag'], maxAgeSeconds: 3600,
  }]);
});

test('private video reads allow only the existing production sites and range headers', () => {
  const reads = policy.rules.filter(rule => rule.allowed.methods.includes('GET') || rule.allowed.methods.includes('HEAD'));
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].allowed.origins, productionOrigins);
  assert.deepEqual(reads[0].allowed.methods, ['GET', 'HEAD']);
  assert.deepEqual(reads[0].allowed.headers, ['Range', 'If-Range']);
  assert.deepEqual(new Set(reads[0].exposeHeaders), new Set(['Content-Range', 'Accept-Ranges', 'Content-Length', 'ETag']));
});

test('the Wrangler policy cannot add wildcard origins or browser credentials to private storage', () => {
  assert.deepEqual(Object.keys(policy), ['rules']);
  assert.equal(policy.rules.length, 2);
  for (const rule of policy.rules) {
    assert.deepEqual(Object.keys(rule).sort(), ['allowed', 'exposeHeaders', 'maxAgeSeconds']);
    assert.deepEqual(Object.keys(rule.allowed).sort(), ['headers', 'methods', 'origins']);
    assert.ok(rule.allowed.origins.every(origin => !origin.includes('*') && new URL(origin).origin === origin));
    assert.ok(rule.allowed.headers.every(header => !['*', 'authorization', 'cookie'].includes(header.toLowerCase())));
    assert.equal(rule.maxAgeSeconds, 3600);
  }
});
