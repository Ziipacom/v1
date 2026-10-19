'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Expand, LogOut, RefreshCw, Smartphone } from 'lucide-react';
import { BrandLogo } from '@/components/brand-logo';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import './portal-studio.css';

export function PortalStudio({member,onLogout,logoutBusy,onSessionEnded}:{member:{name:string};onLogout:()=>Promise<void>;logoutBusy:boolean;onSessionEnded:()=>void}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [compact,setCompact] = useState(false);
  const [ready,setReady] = useState(false);
  const [slow,setSlow] = useState(false);
  const [attempt,setAttempt] = useState(0);
  useEffect(()=>{
    const target = frame.current;
    if (!target) return;
    setReady(false); setSlow(false);
    // Navigate after insertion. Some Chrome profiles retain the initial blank
    // browsing context when a nested app is mounted during client hydration.
    const navigation = requestAnimationFrame(()=>{
      target.src = new URL(`/studio/index.html?portal=1&reload=${attempt}`,location.origin).href;
    });
    const timeout = window.setTimeout(()=>setSlow(true),20000);
    return ()=>{cancelAnimationFrame(navigation);window.clearTimeout(timeout);};
  },[attempt]);
  function studioLoaded() {
    try {
      const location = frame.current?.contentWindow?.location;
      if (location?.origin === window.location.origin && location.pathname === '/studio/index.html') {
        setReady(true); setSlow(false);
      }
    } catch { setSlow(true); }
  }
  useEffect(()=>{
    function message(event:MessageEvent) {
      if(event.origin !== location.origin || event.source !== frame.current?.contentWindow || event.data?.source !== 'ziipa-studio') return;
      if(event.data.type === 'signed-out') onSessionEnded();
    }
    window.addEventListener('message',message);
    return ()=>window.removeEventListener('message',message);
  },[onSessionEnded]);
  return <main className="portal-studio">
    <header className="portal-studio-header"><BrandLogo/><div className="portal-studio-heading"><strong>Creator Studio</strong><span>{member.name}&apos;s workspace</span></div><div className="portal-studio-actions"><Button variant="ghost" onClick={()=>setCompact(!compact)} aria-pressed={compact}>{compact?<Expand size={18}/>:<Smartphone size={18}/>}<span>{compact?'Expand workspace':'Phone layout'}</span></Button><Button variant="ghost" aria-label="Reload Studio" onClick={()=>{if(confirm('Reload Studio? Unsaved editor changes will be lost.')){setReady(false);setAttempt(attempt+1);}}}><RefreshCw size={18}/></Button><Button variant="ghost" disabled={logoutBusy} onClick={()=>void onLogout()}><LogOut size={18}/><span>Sign out</span></Button></div></header>
    <section className={`portal-studio-stage ${compact?'is-compact':''}`} aria-label="Ziipa shared creator app">
      {!ready&&<div role="status" aria-live="polite" className={`portal-studio-loading ${slow?'is-slow':''}`}>
        <span>{slow?'Studio is taking longer than expected.':'Opening your Studio…'}</span>
        {slow&&<><p>Your account and saved media are safe. Open the same Studio directly, or retry this frame.</p><div className="portal-studio-recovery"><a href="/studio/index.html" target="_blank" rel="noopener">Open Studio in its own tab</a><Button variant="ghost" onClick={()=>setAttempt(value=>value+1)}>Retry Studio</Button></div></>}
      </div>}
      <iframe key={attempt} ref={frame} title="Ziipa Studio — Discover, create, connect and mint" allow="camera; microphone; autoplay; fullscreen; clipboard-write" allowFullScreen onLoad={studioLoaded} onError={()=>setSlow(true)}/>
    </section>
    <footer className="portal-studio-footer"><Link href="/"><ArrowLeft size={14}/> Website</Link><span>One Studio for web, Android and iOS · shared creations and connected accounts</span><Link href="/account-deletion">Account & privacy</Link></footer>
  </main>;
}
