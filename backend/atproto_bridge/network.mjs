import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

const FIXED = new Set(['bsky.social', 'public.api.bsky.app', 'plc.directory']);
export function allowedUrl(value, extraOrigins = []) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.href.length > 8192) throw new Error('Unapproved AT Protocol URL');
  const pds = /^(?:[a-z0-9-]+\.)+host\.bsky\.network$/.test(url.hostname);
  if (!FIXED.has(url.hostname) && !pds && !extraOrigins.includes(url.origin)) throw new Error('Unapproved AT Protocol host');
  return url;
}

export function isPublicAddress(value) {
  try {
    let address = ipaddr.parse(value);
    if (address.kind() === 'ipv6' && address.isIPv4MappedAddress()) address = address.toIPv4Address();
    return address.range() === 'unicast';
  } catch { return false; }
}

export function safeFetch(extraOrigins = [], lookup = dnsLookup, transport = https.request) {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = allowedUrl(request.url, extraOrigins);
    if (request.headers.has('cookie')) throw new Error('Cookies forbidden on provider requests');
    if (['public.api.bsky.app', 'plc.directory'].includes(url.hostname) && (request.headers.has('authorization') || request.headers.has('dpop'))) throw new Error('Provider credentials forbidden on public resolution');
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('Non-public provider address');
    const pinned = addresses[0];
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    if (body && body.length > 26 * 1024 * 1024) throw new Error('Provider request too large');
    return await new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error, response) => { if (finished) return; finished = true; clearTimeout(deadline); request.signal.removeEventListener('abort', abort); error ? reject(error) : resolve(response); };
      const req = transport(url, { method: request.method, headers: Object.fromEntries(request.headers), agent: false,
        lookup: (_host, options, cb) => options.all ? cb(null, [pinned]) : cb(null, pinned.address, pinned.family),
      }, res => {
        const chunks = []; let length = 0;
        res.on('data', part => {
          length += part.length;
          if (length > 1024 * 1024) { req.destroy(); finish(new Error('Provider response too large')); }
          else chunks.push(part);
        });
        res.on('error', () => finish(new Error('Provider response interrupted')));
        res.on('end', () => {
          const status = res.statusCode;
          if (status >= 300 && status < 400) return finish(new Error('Provider redirect forbidden'));
          const response = new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: res.headers });
          Object.defineProperty(response, 'url', { value: url.href });
          finish(null, response);
        });
      });
      const abort = () => { req.destroy(); finish(new Error('Provider request cancelled')); };
      const deadline = setTimeout(() => { req.destroy(); finish(new Error('Provider request deadline exceeded')); }, 15000);
      request.signal.addEventListener('abort', abort, { once: true });
      req.on('error', () => finish(new Error('Provider transport unavailable')));
      if (request.signal.aborted) return abort();
      req.end(body);
    });
  };
}
