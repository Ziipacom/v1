import { captionInference, type CaptionEnvironment } from '@/lib/caption-inference';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const { env } = await import('cloudflare:workers');
    return captionInference(request, env as unknown as CaptionEnvironment);
  } catch {
    return Response.json({ detail: 'Caption inference is unavailable in this runtime.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
