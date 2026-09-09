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
      method: request.method, headers, redirect: 'manual',
      ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: request.body, duplex: 'half' }),
    } as RequestInit);
    const response = new Response(upstream.body, upstream);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  } catch {
    return Response.json({ detail: 'Ziipa API is temporarily unavailable.' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
