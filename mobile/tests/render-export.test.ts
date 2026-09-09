import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {exportDownload, renderedExportId, unchangedRender, type MediaExport} from '../src/lib/share-types.ts';
import type {Item} from '../src/lib/types.ts';

const item={id:'076ead28-200c-4240-b13c-41b173ab97e8'} as Item;
const job={id:'31783018-c4ee-4f87-a3a1-e5498620f6bb',item_id:item.id,status:'ready',output_media_id:'fbc2b55a-7721-4dc9-8f91-f15729e80d6d',input_fingerprint:'a'.repeat(64)};
const info:MediaExport={url:`/api/creator/media/${job.output_media_id}`,render_id:job.id,rendered:true,media_id:job.output_media_id,content_type:'video/mp4',size:1234,input_fingerprint:job.input_fingerprint,output_sha256:'b'.repeat(64)};

test('render export must bind the selected creation, ready job, artifact and saved edit fingerprint',()=>{
  assert.equal(renderedExportId(item,job.id,job,info),job.output_media_id);
  for(const changed of [{...job,item_id:'another-creation'},{...job,status:'stale'},{...job,output_media_id:null},{...job,input_fingerprint:'c'.repeat(64)}])
    assert.throws(()=>renderedExportId(item,job.id,changed,info));
  for(const changed of [{...info,render_id:'another-render'},{...info,rendered:false},{...info,media_id:'../private'},{...info,output_sha256:''},{...info,content_type:'text/html'}])
    assert.throws(()=>renderedExportId(item,job.id,job,changed));
});

test('revalidation permits a renewed signed URL but rejects replacement exported bytes or edits',()=>{
  assert.doesNotThrow(()=>unchangedRender(info,{...info,url:'https://storage.example/video?renewed-signature'}));
  for(const changed of [{...info,rendered:false},{...info,media_id:'another'},{...info,input_fingerprint:'d'.repeat(64)},{...info,output_sha256:'e'.repeat(64)},{...info,size:1},{...info,content_type:'text/html'}])
    assert.throws(()=>unchangedRender(info,changed));
});

test('download credentials never accompany an absolute storage URL or an alternate API route',()=>{
  const local=exportDownload(info,'https://api.ziipa.com',job.output_media_id,'secret');
  assert.equal(local.authenticated,true);
  assert.equal(local.headers.Authorization,'Bearer secret');
  const storage=exportDownload({...info,url:'https://bucket.example/video.mp4?signature=test'},'https://api.ziipa.com',job.output_media_id,'secret');
  assert.equal(storage.authenticated,false);
  assert.deepEqual(storage.headers,{});
  for(const url of ['https://api.ziipa.com/api/me','https://api.ziipa.com'+info.url,'https://bucket.example/video#fragment','https://secret@bucket.example/video','//bucket.example/video','/api/creator/media/another'])
    assert.throws(()=>exportDownload({...info,url},'https://api.ziipa.com',job.output_media_id,'secret'));
});
