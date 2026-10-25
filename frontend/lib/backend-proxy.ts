const mediaReadPath = /^\/api\/creator\/media\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Only an already-authorized media redirect may reach private R2 storage. */
function privateStorageLocation(location: string | null): URL | null {
  if (!location || location.length > 8192) return null;
  try {
    const url = new URL(location);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
        !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname) ||
        !url.pathname.startsWith('/ziipa-media/')) return null;
    return url;
  } catch {
    return null;
  }
}

/** Website sessions stay HttpOnly and same-origin in both the portal and Studio. */
export async function proxyBackend(request: Request, origin: string, fetcher: typeof fetch = fetch, proxySecret = '') {
  let backend: URL;
  const incoming = new URL(request.url);
  try {
    backend = new URL(origin);
    if (backend.protocol !== 'https:' || backend.username || backend.password || backend.pathname !== '/' || backend.search || backend.hash || backend.origin === incoming.origin) throw new Error('Invalid backend');
  } catch {
    return Response.json({ detail: 'Ziipa API origin is not configured correctly.' }, { status: 503 });
  }
  if (!incoming.pathname.startsWith('/api/')) return new Response(null, { status: 404 });
  const target = new URL(backend.origin);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'cookie', 'authorization', 'origin', 'range', 'if-range', 'x-ziipa-user']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Only the Cloudflare edge supplies this IP; never forward browser-provided
  // X-Forwarded-* or Ziipa proxy headers. The API trusts it only with our secret.
  const clientIp = request.headers.get('cf-connecting-ip');
  if (proxySecret.length >= 32 && clientIp) {
    headers.set('x-ziipa-proxy-secret', proxySecret);
    headers.set('x-ziipa-client-ip', clientIp);
  }
  try {
    const upstream = await fetcher(target, {
      method: request.method, headers, redirect: 'manual', signal: request.signal,
      ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: request.body, duplex: 'half' }),
    } as RequestInit);
    if (upstream.status === 307 && request.method === 'GET' && mediaReadPath.test(incoming.pathname)) {
      void upstream.body?.cancel().catch(() => {});
      const location = privateStorageLocation(upstream.headers.get('location'));
      if (!location) return Response.json({ detail: 'Media is temporarily unavailable.' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
      // The API has checked ownership/publication before issuing this redirect.
      // Stream its bytes without a browser-visible cross-origin redirect. Never
      // buffer a video or forward account cookies, bearer tokens or proxy keys.
      const mediaHeaders = new Headers();
      for (const name of ['range', 'if-range']) {
        const value = request.headers.get(name);
        if (value) mediaHeaders.set(name, value);
      }
      const media = await fetcher(location, { method: 'GET', headers: mediaHeaders, redirect: 'manual', signal: request.signal });
      const responseHeaders = new Headers({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
      if (media.status === 416) {
        const range = media.headers.get('content-range');
        if (range && /^bytes \*\/\d+$/.test(range)) responseHeaders.set('Content-Range', range);
        await media.body?.cancel();
        return new Response(null, { status: 416, headers: responseHeaders });
      }
      if (![200, 206].includes(media.status) || !/^(video|audio|image)\//i.test(media.headers.get('content-type') || '')) {
        await media.body?.cancel();
        return Response.json({ detail: 'Media is temporarily unavailable.' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
      }
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const value = media.headers.get(name);
        if (value) responseHeaders.set(name, value);
      }
      return new Response(media.body, { status: media.status, headers: responseHeaders });
    }
    const response = new Response(upstream.body, upstream);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  } catch {
    return Response.json({ detail: 'Ziipa API is temporarily unavailable.' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
