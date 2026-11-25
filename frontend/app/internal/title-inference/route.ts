import { titleInference, type TitleEnvironment } from '@/lib/title-inference';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const { env } = await import('cloudflare:workers');
    return titleInference(request, env as unknown as TitleEnvironment);
  } catch {
    return Response.json({ detail: 'Title inference is unavailable in this runtime.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
