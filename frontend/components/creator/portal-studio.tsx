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
  const [attempt,setAttempt] = useState(0);
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
      {!ready&&<output className="portal-studio-loading">Opening your Studio…</output>}
      <iframe key={attempt} ref={frame} src="/studio/index.html" title="Ziipa Studio — Discover, create, connect and mint" allow="camera; microphone; autoplay; fullscreen; clipboard-write" allowFullScreen onLoad={()=>setReady(true)}/>
    </section>
    <footer className="portal-studio-footer"><Link href="/"><ArrowLeft size={14}/> Website</Link><span>One Studio for web, Android and iOS · shared creations and connected accounts</span><Link href="/account-deletion">Account & privacy</Link></footer>
  </main>;
}
