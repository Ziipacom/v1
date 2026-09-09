import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, ScrollView, Switch, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Clapperboard, Download, RefreshCw, Send } from 'lucide-react-native';
import { Action, Notice } from '../components/ui';
import { useZiipa } from '../provider';
import { prepareMediaShare } from '../lib/share-creation';
import type { PreparedMedia } from '../lib/share-types';
import { readyRender, type RenderConfig, type RenderJob } from '../lib/render-types';
import type { RootStack } from '../lib/types';
import { styles } from '../theme';
import { useOperationScope } from '../lib/use-operation-scope';

export function ExportsScreen(props: NativeStackScreenProps<RootStack,'Exports'>) {
  const { session } = useZiipa();
  return <ScopedExportsScreen key={`${session?.access_token || 'guest'}:${props.route.params.itemId}`} {...props}/>;
}

function ScopedExportsScreen({route,navigation}: NativeStackScreenProps<RootStack,'Exports'>) {
  const {api,data,session,guest}=useZiipa();
  const focused=useIsFocused();
  const [foreground,setForeground]=useState(AppState.currentState==='active');
  const [config,setConfig]=useState<RenderConfig|null>(null);
  const [jobs,setJobs]=useState<RenderJob[]>([]);
  const [rights,setRights]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [prepared,setPrepared]=useState<{id:string,media:PreparedMedia}|null>(null);
  const preparedRef=useRef(prepared);
  const enabled=useRef(true);
  const inFlight=useRef(false);
  const actionFlight=useRef(false);
  const generation=useRef(0);
  const item=data.drafts.find((draft)=>draft.id===route.params.itemId && !draft.demo && draft.creator_id===session?.user.id);
  preparedRef.current=prepared;
  const active=focused&&foreground;
  const savedEdit=JSON.stringify([item?.media_id,item?.trim_start,item?.trim_end,item?.captions,item?.overlays,item?.soundtrack]);
  const capture=useOperationScope(savedEdit,active);
  enabled.current=active;
  useEffect(()=>{
    const listener=AppState.addEventListener('change',state=>setForeground(state==='active'));
    return ()=>listener.remove();
  },[]);
  useEffect(()=>{
    generation.current++;
    enabled.current=active;
    preparedRef.current?.media.dispose();preparedRef.current=null;setPrepared(null);setRights(false);setBusy(false);
    return ()=>{generation.current++;enabled.current=false;preparedRef.current?.media.dispose();};
  },[active,session?.access_token,route.params.itemId,savedEdit]);
  const refresh=useCallback(async()=>{
    if (guest||inFlight.current) return;
    inFlight.current=true;
    const current=generation.current;
    const valid=capture();
    try {
      const [settings,result]=await Promise.all([api<RenderConfig>('/api/render/config'),api<RenderJob[]>(`/api/render/jobs?item_id=${encodeURIComponent(route.params.itemId)}`)]);
      if (valid() && enabled.current && current===generation.current) {
        setConfig(settings);setJobs(result);
        if (preparedRef.current && !result.some(job=>job.id===preparedRef.current?.id&&readyRender(job,route.params.itemId))) {
          preparedRef.current.media.dispose();preparedRef.current=null;setPrepared(null);
        }
      }
    } finally {inFlight.current=false;}
  },[api,guest,route.params.itemId,capture]);
  useEffect(()=>{
    if (!active) return;
    let stop=false;let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{await refresh();}catch(e){if(!stop)setMessage(e instanceof Error?e.message:'Cannot load exports.');}if(!stop)timer=setTimeout(()=>void poll(),5000);};
    void poll();return()=>{stop=true;clearTimeout(timer);};
  },[active,refresh]);
  async function run(work:(valid:()=>boolean)=>Promise<void>) {
    if(actionFlight.current)return;
    actionFlight.current=true;
    const valid=capture();
    setBusy(true);setMessage('');
    try{await work(valid);}catch(e){if(valid())setMessage(e instanceof Error?e.message:'Export failed.');}finally{actionFlight.current=false;if(valid())setBusy(false);}
  }
  return <ScrollView style={styles.screen} contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
    <View style={styles.panel}><Clapperboard color="white" size={28}/><Text style={styles.heading}>Export your saved edit</Text><Text style={styles.label}>{item?.title||'Saved creation'}</Text><Text style={styles.small}>Create an MP4 with your trim, captions, text overlays and soundtrack included. Save editor changes before exporting.</Text></View>
    {!item||guest?<Notice text="Save your own uploaded video to your account before rendering an export."/>:<>
      {message?<Notice text={message}/>:null}
      {!config?.can_render&&<Notice text={config?.detail||config?.requirements?.join(' · ')||'The export worker is not ready. You can keep editing; rendering starts once the worker is available.'}/>}
      {config?.max_duration_seconds&&<Text style={styles.small}>Up to {config.max_duration_seconds} seconds · {Math.round((config.max_output_bytes||0)/1024/1024)} MB MP4 · maximum long edge {config.max_output_long_edge}px</Text>}
      <View style={styles.panel}><Text style={styles.label}>Saved effects</Text><Text style={styles.small}>{item.captions?.length||0} caption cues · {item.overlays?.length||0} text overlays{item.soundtrack?.media_id?` · ${item.soundtrack.name}`:''}</Text><Text style={styles.small}>The original stays unchanged. Exports are private until you choose to publish or share them.</Text>
      {item.soundtrack?.media_id&&<View style={styles.row}><Switch accessibilityLabel="I have permission to include this soundtrack" value={rights} onValueChange={setRights}/><Text style={[styles.small,{flex:1}]}>I have permission to include this soundtrack in the exported video.</Text></View>}
      <Action title="Render saved video" icon={Clapperboard} busy={busy} disabled={!config?.can_render||!!item.soundtrack?.media_id&&!rights} onPress={()=>void run(async(valid)=>{await api('/api/render/jobs',{item_id:item.id,soundtrack_rights_confirmed:rights});if(!valid())return;await refresh();if(valid())setMessage('Export queued. You can leave this screen and return to check it.');})}/>
      </View>
      <Action title="Refresh exports" secondary icon={RefreshCw} busy={busy} onPress={()=>void run(refresh)}/>
      {jobs.map(job=><View key={job.id} style={styles.panel}><Text style={styles.label}>{job.status==='ready'?'MP4 export ready':job.status}</Text><Text style={styles.small}>{job.detail}</Text><Text style={styles.small}>{new Date(job.created_at).toLocaleString()}</Text>
        {['queued','processing'].includes(job.status)&&<Action title="Cancel this render" secondary busy={busy} onPress={()=>void run(async()=>{await api(`/api/render/jobs/${job.id}/cancel`,{});await refresh();})}/>}
        {['failed','cancelled','stale'].includes(job.status)&&<Action title="Retry with my current saved edit" secondary busy={busy} disabled={!config?.can_render||!!item.soundtrack?.media_id&&!rights} onPress={()=>void run(async()=>{await api('/api/render/jobs',{item_id:item.id,soundtrack_rights_confirmed:rights,retry_failed:true});await refresh();})}/>}
        {readyRender(job,item.id)&&<>
          <Action title="Prepare rendered video" secondary icon={Download} busy={busy} onPress={()=>void run(async(valid)=>{
            if(!session)throw new Error('Sign in to export.');
            preparedRef.current?.media.dispose();preparedRef.current=null;setPrepared(null);
            const current=generation.current;
            const media=await prepareMediaShare(item,session.access_token,job.id,valid);
            if(!valid()||!enabled.current||current!==generation.current){media.dispose();return;}preparedRef.current={id:job.id,media};setPrepared({id:job.id,media});
          })}/>
          {prepared?.id===job.id&&<Action title={Platform.OS==='web'?'Download / share MP4':'Share MP4'} icon={Download} busy={busy} onPress={()=>void run(async(valid)=>{const outcome=await prepared.media.share();if(valid())setMessage(outcome==='cancelled'?'Sharing cancelled.':outcome==='downloaded'?'Rendered MP4 downloaded.':'Share sheet opened. Ziipa has not assumed a network post was delivered.');})}/>}
          {item.visibility==='published'&&<Action title="Publish this rendered version" icon={Send} onPress={()=>navigation.navigate('Publishing',{itemId:item.id,renderId:job.id})}/>}
        </>}
      </View>)}
    </>}
    <Action title="Return to saved editor" secondary onPress={()=>item?navigation.navigate('Composer',{item}):navigation.goBack()}/>
  </ScrollView>;
}
