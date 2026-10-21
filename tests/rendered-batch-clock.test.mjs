import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import vm from 'node:vm';
import {encodedBatchClock} from '../local-processor/rendered-batch-clock.mjs';
import {renderedNarrationManifest} from '../local-processor/completed-video-narration.mjs';

const part={timelineDuration:6,synchronization:[{momentId:'a',visualStart:0,visualDuration:3},
  {momentId:'b',visualStart:3,visualDuration:3}]};
test('measured encoding tail belongs only to the last scene of its own batch',()=>{
  const result=encodedBatchClock(part,6.046);
  assert.equal(result.timelineDuration,6.046);
  assert.equal(result.synchronization[0].visualDuration,3);
  assert.equal(result.synchronization[1].visualStart,3);
  assert.equal(result.synchronization[1].visualDuration,3.0460000000000003);
  assert.equal(part.synchronization[1].visualDuration,3,'estimated input is unchanged');
});
test('a missing scene, discontinuous clock or substantial render truncation is not excused as encoder rounding',()=>{
  for(const measured of [0,NaN,5,7])assert.throws(()=>encodedBatchClock(part,measured));
  for(const cuts of [[],[{...part.synchronization[0],visualStart:1}],
    [{...part.synchronization[0],visualDuration:6},part.synchronization[1]],
    [...part.synchronization].reverse()])assert.throws(()=>encodedBatchClock({...part,synchronization:cuts},6.04));
});
test('production batch rendering probes every encoded part and hands narration the measured aggregate clock',async()=>{
  const code=await readFile(new URL('../local-processor/render-video-v2.mjs',import.meta.url),'utf8');
  const body=code.slice(code.indexOf('async function renderChunkedCompleteRecap('),code.indexOf('export async function renderVideoV2('));
  const files=new Map(),calls=[];
  const render=vm.runInNewContext(`${body}\nrenderChunkedCompleteRecap`,{dirname,join,encodedBatchClock,
    process:{env:{FFMPEG_PATH:'encoder',FFPROBE_PATH:'probe'}},resolveExecutable:x=>x,
    applyPortraitMatchHeader:async(path)=>calls.push({command:'header',path}),
    writeFile:async(path,data)=>files.set(path,data),
    run:async(command,args)=>{calls.push({command,args});return command==='probe'?'6.046\n':'';},
    renderVideoV2:async(_source,_path,selected,settings)=>{
      calls.push({command:'scene-batch',offset:settings.__sceneIndexOffset});
      return {timelineDuration:6,synchronization:selected.map((item,index)=>({
        momentId:item.id,visualStart:index*2,visualDuration:2})),teaserDuration:0};
    }});
  const scenes=Array.from({length:12},(_,index)=>({id:'scene-'+index}));
  const result=await render('source.mp4','edited.mp4',scenes,{}, {},new Map(),[],{},null,null);
  assert.equal(calls.filter(call=>call.command==='probe').length,4);
  assert.equal(calls.filter(call=>call.command==='header').length,1,'header is applied once after combining every batch');
  assert.deepEqual(calls.filter(call=>call.command==='scene-batch').map(call=>call.offset),[0,3,6,9],
    'presentation transitions do not reset at a render batch boundary');
  assert.equal(calls.at(-1).command,'header');
  assert.equal(result.synchronization.length,12);
  assert.ok(Math.abs(result.timelineDuration-24.184)<1e-8);
  assert.equal(result.synchronization[3].visualStart,6.046);
  const manifest={moments:scenes.map(item=>({candidateId:item.id}))};
  const measured=24.205;
  const exact=renderedNarrationManifest(manifest,result,measured);
  assert.equal(exact.moments.at(-1).output.endTime,measured);
  assert.throws(()=>renderedNarrationManifest(manifest,{...result,timelineDuration:24},measured),/scene clock/);
  const saved=JSON.parse([...files].find(([path])=>path.endsWith('synchronization.json'))[1]);
  assert.equal(saved.clockSource,'measured_encoded_batches');assert.equal(saved.beats.length,12);
});
