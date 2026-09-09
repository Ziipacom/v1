import type { Item } from './types';
export type RenderJob = {
  id: string; item_id: string; status: 'queued' | 'processing' | 'ready' | 'failed' | 'stale' | 'cancelled';
  detail: string; output_media_id: string | null; input_fingerprint: string; created_at: string;
};
export type RenderConfig = {
  configured: boolean; worker_ready: boolean; can_render: boolean; detail?: string;
  requirements?: string[];
  max_duration_seconds?: number; max_output_bytes?: number; max_output_long_edge?: number;
};
export function readyRender(job: RenderJob, itemId: string) {
  return job.status === 'ready' && job.item_id === itemId && !!job.output_media_id;
}
export function hasEditorEffects(item: Item) {
  return !!(item.trim_start || item.trim_end != null || item.captions?.length || item.overlays?.length || item.soundtrack?.media_id);
}
export function renderId(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid rendered export. Refresh your saved exports.');
  return value;
}
