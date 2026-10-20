'use client';

import { useEffect, useState } from 'react';

type PlatformStatus = { maintenance_mode: boolean; signup_paused: boolean; banner: string };

export function PlatformNotice() {
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  useEffect(() => {
    let live = true;
    let loading = false;
    let controller: AbortController | null = null;
    async function refresh() {
      if (loading || document.visibilityState === 'hidden') return;
      loading = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 15000);
      try {
        const response = await fetch('/api/platform/status', { cache: 'no-store', credentials: 'omit', signal: controller.signal });
        if (response.ok) {
          const next = await response.json() as PlatformStatus;
          if (live) setStatus(next);
        }
      } catch { /* The notice is optional; the API enforces actual restrictions. */ }
      finally { clearTimeout(timeout); loading = false; }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 60000);
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { live = false; clearInterval(timer); controller?.abort(); document.removeEventListener('visibilitychange', visible); };
  }, []);
  const message = status?.banner || (status?.maintenance_mode
    ? 'Ziipa maintenance: creator changes are temporarily paused.'
    : status?.signup_paused ? 'New Ziipa registrations are temporarily paused.' : '');
  if (!message) return null;
  return <aside role="status" style={{ background: '#25163e', color: '#f6f0ff', borderBottom: '1px solid #6234b2', padding: '12px 20px', textAlign: 'center', fontSize: 14 }}>{message}</aside>;
}
