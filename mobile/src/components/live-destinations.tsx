import {useEffect,useRef,useState} from 'react';
import {Text,View} from 'react-native';
import {useIsFocused} from '@react-navigation/native';
import {Action,Notice} from './ui';
import {useZiipa} from '../provider';
import type {LiveBroadcast} from '../lib/live-types';
import {styles} from '../theme';
import {useOperationScope} from '../lib/use-operation-scope';

type Destination={status:string;channel_id:string;detail:string};
type TwitchAccount={provider:string;status:string;selected_target_id:string|null;targets:{id:string;name:string}[]};
type Props={broadcast:LiveBroadcast;disabled:boolean;onConnections:()=>void};
export function LiveDestinations(props:Props) {
  const {session}=useZiipa();
  return <ScopedDestinations key={`${session?.access_token||'guest'}:${props.broadcast.id}`} {...props}/>;
}
function ScopedDestinations({broadcast,disabled,onConnections}:Props) {
  const {api}=useZiipa();const focused=useIsFocused();
  const [destination,setDestination]=useState<Destination|null>(null);
  const [target,setTarget]=useState<{id:string;name:string}|null>(null);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const pending=useRef(false);
  const capture=useOperationScope(broadcast.id,focused);
  const path=`/api/live/streams/${broadcast.id}/destinations/twitch`;
  useEffect(()=>{
    const current=capture();setBusy(false);setDestination(null);setTarget(null);setError('');
    if(focused)void Promise.all([api<Destination>(path),api<{connections:TwitchAccount[]}>('/api/publishing/connections')]).then(([value,result])=>{
      if(!current())return;
      setDestination(value);
      const twitch=result.connections.find(account=>account.provider==='twitch'&&account.status==='authorized');
      setTarget(twitch?.targets.find(option=>option.id===twitch.selected_target_id)||null);
    }).catch((e:Error)=>{if(current())setError(e.message);});
  },[api,path,focused,capture]);
  async function change(enabled:boolean){
    if(pending.current||disabled||!focused||enabled&&(broadcast.status!=='prepared'||!target))return;
    pending.current=true;const current=capture();setBusy(true);setError('');
    try{const value=await api<Destination>(path,{enabled,consent:enabled,...(enabled?{expected_target_id:target?.id}:{})});if(current())setDestination(value);}
    catch(e){if(current())setError(e instanceof Error?e.message:'The destination could not be updated.');}
    finally{pending.current=false;if(current())setBusy(false);}
  }
  return <View style={styles.panel}>
    <Text style={styles.heading}>Broadcast destinations</Text>
    <Text style={styles.label}>Ziipa · public live feed</Text>
    <Notice text="Add your authorized Twitch channel before going live. This shares the broadcast and its audio with Twitch through Livepeer. Twitch and Livepeer usage limits apply; configuration alone does not confirm viewers can watch."/>
    {error?<Notice text={error}/>:null}
    {destination?<Text style={styles.small}>Twitch · {destination.status}{destination.channel_id?` · channel ${destination.channel_id}`:''}{'\n'}{destination.detail}</Text>:null}
    {target?<Text style={styles.label}>Selected Twitch channel: {target.name} · {target.id}</Text>:<Text style={styles.small}>Connect Twitch and select its authorized channel before approving a destination.</Text>}
    {destination?.status==='detached'&&<Action title={`Approve ${target?.name||'Twitch'} as a destination for this broadcast`} disabled={disabled||broadcast.status!=='prepared'||!target} busy={busy} onPress={()=>void change(true)}/>}
    {destination&&destination.status!=='detached'&&<Action title="Remove Twitch from this broadcast" secondary disabled={disabled} busy={busy} onPress={()=>void change(false)}/>}
    <Action title="Connect or manage my Twitch account" secondary disabled={disabled} onPress={onConnections}/>
  </View>;
}
