import { musicInference, type MusicEnvironment } from '@/lib/music-inference';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const { env } = await import('cloudflare:workers');
    return musicInference(request, env as unknown as MusicEnvironment);
  } catch {
    return Response.json({ detail: 'Music inference is unavailable in this runtime.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
