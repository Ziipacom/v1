import { proxyBackend } from '@/lib/backend-proxy';

export const dynamic = 'force-dynamic';
function handle(request: Request) {
  return proxyBackend(request, process.env.ZIIPA_BACKEND_ORIGIN || 'https://api.ziipa.com', fetch, process.env.ZIIPA_PROXY_SECRET || '');
}
export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as OPTIONS, handle as HEAD };
