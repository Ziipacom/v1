import {useEffect,useRef,useState} from 'react';
import {Linking, Text, View} from 'react-native';
import {useIsFocused} from '@react-navigation/native';
import {Radio, RefreshCw} from 'lucide-react-native';
import {Action, Field, Notice} from './ui';
import {useZiipa} from '../provider';
import {styles} from '../theme';
import {useOperationScope} from '../lib/use-operation-scope';

type Channel = {target_id:string;title:string;game_id:string;game_name:string;language:string;is_live:boolean;channel_url:string};
type Person = {id?:string;name?:string;handle?:string;url?:string};
type Props={connected:boolean;targetId:string;onBroadcast:()=>void};
export function TwitchChannel(props:Props) {
  const {session}=useZiipa();
  return <ScopedChannel key={`${session?.access_token||'guest'}:${props.connected}:${props.targetId}`} {...props}/>;
}
function ScopedChannel({connected,targetId,onBroadcast}:Props) {
  const {api}=useZiipa();
  const focused=useIsFocused();
  const capture=useOperationScope(String(connected),focused);
  const pending=useRef(false);
  const [channel,setChannel]=useState<Channel|null>(null);
  const [title,setTitle]=useState('');
  const [language,setLanguage]=useState('');
  const [game,setGame]=useState('');
  const [people,setPeople]=useState<Person[]>([]);
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  useEffect(()=>{setChannel(null);setPeople([]);setTitle('');setLanguage('');setGame('');setMessage('');setBusy(false);},[connected,focused]);
  async function run(work:(current:()=>boolean)=>Promise<void>){
    if(pending.current||!connected||!targetId||!focused)return;
    pending.current=true;const current=capture();setBusy(true);setMessage('');
    try{await work(current);}catch(error){if(current())setMessage(error instanceof Error?error.message:'Twitch could not complete this request.');}
    finally{pending.current=false;if(current())setBusy(false);}
  }
  function fill(value:Channel){if(value.target_id!==targetId)throw new Error('The selected Twitch channel changed. Refresh your connected accounts.');setChannel(value);setTitle(value.title);setLanguage(value.language);setGame(value.game_id);}
  return <View style={styles.panel}>
    <Text style={styles.heading}>Your Twitch channel</Text>
    <Notice text="Twitch accepts live video through an encoder or Ziipa's live relay. It does not offer a general API for uploading a finished video. Authorize your channel, then choose Twitch in your broadcast destinations."/>
    {message?<Notice text={message}/>:null}
    <Action title="Load channel status and settings" icon={RefreshCw} secondary busy={busy} disabled={!connected} onPress={()=>void run(async(current)=>{const value=await api<Channel>('/api/publishing/connections/twitch/channel');if(current())fill(value);})}/>
    {channel&&<>
      <Text style={styles.label}>{channel.is_live?'Twitch reports the channel live':'Twitch reports the channel offline'}{channel.game_name?` · ${channel.game_name}`:''}</Text>
      <Field label="Broadcast title" value={title} onChangeText={setTitle} maxLength={140} editable={!busy}/>
      <Field label="Twitch category ID (optional)" value={game} onChangeText={setGame} keyboardType="number-pad" editable={!busy}/>
      <Field label="Broadcast language" value={language} onChangeText={setLanguage} autoCapitalize="none" maxLength={10} editable={!busy}/>
      <Action title="Apply these settings to my Twitch channel" busy={busy} disabled={!connected||!title.trim()} onPress={()=>void run(async(current)=>{const value=await api<Channel>('/api/publishing/connections/twitch/channel-settings',{title:title.trim(),game_id:game,language,consent:true,expected_target_id:targetId});if(!current())return;fill(value);setMessage('Twitch confirmed the channel settings. This has not started a broadcast.');})}/>
      <Action title="Open my Twitch channel" secondary onPress={()=>void run(async(current)=>{const url=new URL(channel.channel_url);if(url.protocol!=='https:'||url.hostname!=='www.twitch.tv'||url.port||url.username||url.password||url.search||url.hash||!/^\/[a-z0-9_]+\/?$/i.test(url.pathname))throw new Error('Twitch returned an invalid channel link. Reload the channel.');if(current())await Linking.openURL(url.href);})}/>
    </>}
    <Action title="Set up a Ziipa live broadcast" icon={Radio} onPress={onBroadcast}/>
    <Action title="Load channels I follow on Twitch" secondary busy={busy} disabled={!connected} onPress={()=>void run(async(current)=>{const result=await api<{people:Person[];detail:string}>('/api/publishing/connections/twitch/follows',{});if(!current())return;setPeople(result.people);setMessage(result.detail);})}/>
    {people.map((person,index)=><Text key={person.id||person.handle||index} style={styles.small}>{person.name||person.handle||'Twitch channel'}</Text>)}
  </View>;
}
