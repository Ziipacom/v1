'use client';
import { useState, type FormEvent } from 'react';
import { UploadCloud, Save, Send, Scissors, Captions, WandSparkles, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api';
import type { Item, Category } from './types';
import { MediaPlayer, vtt } from './media-player';

export function Composer({item,remix,onSaved}:{item?:Item;remix?:Item;onSaved:()=>Promise<void>}) {
 const [title,setTitle]=useState(item?.title||(remix?`Remix of ${remix.title}`:''));
 const [category,setCategory]=useState<Category>(item?.category||'video');
 const [description,setDescription]=useState(item?.description||'');
 const [tags,setTags]=useState(item?.tags.join(', ')||'');
 const [city,setCity]=useState(item?.city||'');
 const [media,setMedia]=useState<{id:string;url:string;content_type:string}|null>(item?.media_id?{id:item.media_id,url:item.media_url||item.cover,content_type:item.content_type||'video/mp4'}:null);
 const [start,setStart]=useState(item?.trim_start||0);
 const [end,setEnd]=useState(item?.trim_end?.toString()||'');
 const [caption,setCaption]=useState(item?.captions?.[0]?.text||'');
 const [price,setPrice]=useState(item?.price_cents!=null?(item.price_cents/100).toString():'');
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
 const captions=caption.trim()?[{start,end:Number(end)||Math.max(start+5,5),text:caption}]:[];
 const preview:Item={id:'preview',title:title||'Your preview',description,category,creator:'You',city,tags:[],cover:media?.content_type.startsWith('image/')?media.url:'/brand/ziipa-background.png',media_url:media&&!media.content_type.startsWith('image/')?media.url:null,content_type:media?.content_type,label:'Your upload',demo:false,trim_start:start,trim_end:Number(end)||null,captions};
 async function upload(file:File) {
  setBusy(true);setError('');setNotice('Uploading to your local workspace…');
  try {if(file.size>50*1024*1024)throw new Error('Choose a file smaller than 50 MB.');const response=await fetch('/api/creator/media',{method:'POST',credentials:'same-origin',headers:{'Content-Type':file.type},body:file,signal:AbortSignal.timeout(120000)});const result=await response.json() as {id:string;url:string;content_type:string;detail?:string};if(!response.ok)throw new Error(result.detail||'Upload failed');setMedia(result);setNotice('Upload saved. Add your details, then save or publish.');}
  catch(e){setError((e as Error).message);setNotice('');}finally{setBusy(false);}
 }
 async function save(visibility:'draft'|'published') {
  setBusy(true);setError('');setNotice('');
  try {await api(`/creator/items${item?`/${item.id}`:''}`,{title,description,category,tags:tags.split(',').map(t=>t.trim()).filter(Boolean),city,media_id:media?.id||null,visibility,trim_start:start,trim_end:Number(end)||null,captions,price_cents:price?Math.round(Number(price)*100):null,remix_of:remix?.id||item?.remix_of||null});await onSaved();}
  catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 function downloadCaptions(){const url=URL.createObjectURL(new Blob([vtt(captions)],{type:'text/vtt'}));const link=document.createElement('a');link.href=url;link.download='ziipa-captions.vtt';link.click();URL.revokeObjectURL(url);}
 return <div className="cw-composer"><form className="cw-fields" onSubmit={(e:FormEvent)=>{e.preventDefault();void save('draft');}}><label className="cw-upload"><UploadCloud size={28}/><strong>{media?'Replace your media':'Bring your next idea to life'}</strong><span>MP4, WebM, MP3, WAV, JPG, PNG or WebP · up to 50 MB</span><Input type="file" aria-label="Upload creator media" accept="video/mp4,video/webm,audio/mpeg,audio/wav,image/jpeg,image/png,image/webp" disabled={busy} onChange={e=>{const file=e.target.files?.[0];if(file)void upload(file);}}/></label><label>Title<Input value={title} onChange={e=>setTitle(e.target.value)} maxLength={140} required placeholder="Give your idea a name"/></label><div className="cw-field-pair"><label>Category<NativeSelect value={category} onChange={e=>setCategory(e.target.value as Category)}><option value="video">Video</option><option value="music">Music & film</option><option value="games">Gaming</option><option value="live">Live stream plan</option><option value="nft">NFT collection draft</option><option value="store">Store listing</option></NativeSelect></label><label>City (optional)<Input value={city} onChange={e=>setCity(e.target.value)} maxLength={80} placeholder="New York"/></label></div><label>Description<Textarea value={description} onChange={e=>setDescription(e.target.value)} maxLength={3000} placeholder="Tell the story behind your creation…"/></label><label>Tags<Input value={tags} onChange={e=>setTags(e.target.value)} placeholder="music, studio, electronic"/><small>Up to 12 tags, separated by commas.</small></label>{category==='store'&&<label>Display price (USD)<Input type="number" min="0" max="1000000" step="0.01" value={price} onChange={e=>setPrice(e.target.value)}/><small>Local listing only. Checkout and seller payouts are not connected.</small></label>}<div className="cw-editor-settings"><h3><Scissors size={17}/> Playback trim</h3><div className="cw-field-pair"><label>Start (seconds)<Input type="number" min="0" max="86400" step="0.1" value={start} onChange={e=>setStart(Number(e.target.value))}/></label><label>End (seconds)<Input type="number" min="0.1" max="86400" step="0.1" value={end} onChange={e=>setEnd(e.target.value)} placeholder="Full length"/></label></div><h3><Captions size={17}/> Caption overlay</h3><Textarea value={caption} onChange={e=>setCaption(e.target.value)} maxLength={250} aria-label="Caption text" placeholder="Add a caption for this segment…"/><small>Manual caption, shown from start to end (or for five seconds). Trim changes playback, not the source file.</small>{caption&&<Button type="button" variant="ghost" onClick={downloadCaptions}><Download size={15}/> Export captions (.vtt)</Button>}</div>{remix&&<p className="cw-info">Attribution linked to “{remix.title}” by {remix.creator}. This is a local attribution record, not an on-chain royalty contract. Only upload material you have permission to remix.</p>}<p className="cw-info"><WandSparkles size={16}/> Automatic captions, background removal, beat sync, and licensed sounds need additional model and rights integrations.</p>{error&&<p className="cw-error" role="alert">{error}</p>}{notice&&<p className="cw-info" role="status">{notice}</p>}<div className="cw-editor-actions"><Button type="submit" variant="outline" disabled={busy}><Save size={16}/> Save draft</Button><Button type="button" className="cw-primary" disabled={busy||!media||!title.trim()||category==='live'||category==='nft'} onClick={()=>void save('published')}><Send size={16}/> Publish locally</Button></div><small>Local posts are visible to signed-in members on this installation. Nothing is sent to AT Protocol.</small></form><aside className="cw-composer-preview"><span>WEB APP PREVIEW</span><MediaPlayer item={preview}/><h3>{title||'Your next creation'}</h3><p>{description||'Your story starts here.'}</p></aside></div>;
}
