import { narrationInference, type NarrationEnvironment } from '@/lib/narration-inference';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const { env } = await import('cloudflare:workers');
    return narrationInference(request, env as unknown as NarrationEnvironment);
  } catch {
    return Response.json({ detail: 'Narration inference is unavailable in this runtime.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
