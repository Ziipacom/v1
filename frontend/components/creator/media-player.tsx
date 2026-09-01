'use client';
import { useEffect, useState } from 'react';
import type { Item, Caption } from './types';
export function vtt(captions:Caption[]) {
  const stamp=(t:number)=>new Date(t*1000).toISOString().slice(11,23);
  return 'WEBVTT\n\n'+captions.map((c,i)=>`${i+1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text.replace(/-->/g,'→')}\n`).join('\n');
}
export function MediaPlayer({item}:{item:Item}) {
  const [track,setTrack]=useState('');
  const [error,setError]=useState(false);
  useEffect(()=>{if(!item.captions?.length)return;const url=URL.createObjectURL(new Blob([vtt(item.captions)],{type:'text/vtt'}));setTrack(url);return()=>URL.revokeObjectURL(url);},[item.captions]);
  if (!item.media_url) return <div className="cw-preview-image"><img src={item.cover} alt={item.title}/><span>{item.label} · no playable media</span></div>;
  return <div className="cw-player">{item.content_type?.startsWith('audio/') ? <><img src={item.cover} alt=""/><audio controls preload="metadata" src={item.media_url} onError={()=>setError(true)}/></> : <video key={item.media_url} controls playsInline preload="metadata" poster={item.cover} src={item.media_url} onError={()=>setError(true)} onLoadedMetadata={e=>{e.currentTarget.currentTime=item.trim_start||0;}} onTimeUpdate={e=>{const video=e.currentTarget;if(item.trim_end && video.currentTime>=item.trim_end){video.pause();video.currentTime=item.trim_start||0;}}}>{track&&<track kind="captions" src={track} srcLang="en" label="Creator captions" default/>}</video>}{error&&<p role="alert">This media could not play. Try another file or browser-compatible codec.</p>}</div>;
}
