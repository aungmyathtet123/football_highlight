import {mkdir,readFile,readdir,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {normalizeScoreSamples,buildSourceScoreLedger,SCORE_LEDGER_VERSION} from './source-score-ledger.mjs';
import {mapWithConcurrency} from './bounded-concurrency.mjs';
// All IO/API work is injected: uses the processor's bounded FFmpeg and durable
// request scheduler. No separate SDK retries or fixture-specific timestamps.
export async function observeSourceScore({sourcePath,fingerprint,media,directory,model,ffmpeg,run,generate,onProgress=async()=>{}}) {
  const interval=10;
  const key=createHash('sha256').update(JSON.stringify({version:SCORE_LEDGER_VERSION,fingerprint,model,interval})).digest('hex');
  const folder=join(directory,key);await mkdir(folder,{recursive:true});
  try {return JSON.parse(await readFile(join(folder,'ledger.json'),'utf8'));} catch {}
  const ready=join(folder,'frames-ready.json');
  try {await readFile(ready);} catch {
    // Exact input seeks avoid decoding a whole AV1 source just to read 34
    // scorebugs. Keep full native pixels and bounded concurrent decoders.
    const indexes=Array.from({length:Math.max(1,Math.ceil(media.duration/interval))},(_,index)=>index);
    await mapWithConcurrency(indexes,3,async index=>{
      const upper=join(folder,`upper-${String(index+1).padStart(4,'0')}.jpg`),lower=upper.replace('upper-','lower-');
      try {if((await stat(upper)).size>0&&(await stat(lower)).size>0)return;} catch {}
      await onProgress(`Preparing native score sample ${index+1}/${indexes.length}; exact source seeks, no full-video decode.`);
      await run(ffmpeg,['-hide_banner','-loglevel','error','-y','-ss',String(index*interval),'-i',sourcePath,
        '-filter_complex','[0:v]split=2[u][l];[u]crop=iw:ih/4:0:0[upper];[l]crop=iw:ih/4:0:ih*3/4[lower]',
        '-map','[upper]','-frames:v','1','-threads','1','-q:v','2',upper,
        '-map','[lower]','-frames:v','1','-threads','1','-q:v','2',lower]);
    });
    await writeFile(ready,JSON.stringify({version:SCORE_LEDGER_VERSION}));
  }
  const images=(await readdir(folder)).filter(name=>/^upper-\d+\.jpg$/.test(name)).sort();
  if (!images.length) throw new Error('Source-score sampling returned no native images.');
  const batches=[];for(let from=0;from<images.length;from+=6) batches.push(from);
  const results=await mapWithConcurrency(batches,2,async from=>{
    const ids=images.slice(from,from+6).map((_,index)=>String(from+index+1));
    const path=join(folder,`batch-${from}.json`);let samples;
    try {samples=normalizeScoreSamples(JSON.parse(await readFile(path,'utf8')).samples,ids);} catch {}
    if (!samples) {
      await onProgress(`Reading source scoreboard samples ${from+1}-${from+ids.length} of ${images.length}; completed batches stay saved.`);
      const contents=[];
      for(let index=from;index<from+ids.length;index++) {
        contents.push({text:`Sample ID ${index+1}, approximate source ${(index*interval).toFixed(1)} seconds. SAME native source frame, top and bottom edges. This is discovery context, not an action/contact timestamp.`});
        for(const name of [images[index],images[index].replace('upper','lower')]) contents.push({inlineData:{mimeType:'image/jpeg',data:(await readFile(join(folder,name))).toString('base64')},mediaResolution:{level:'MEDIA_RESOLUTION_HIGH'}});
      }
      contents.push({text:'Read ONLY the actual broadcast scoreboard. Do NOT analyze an action, infer a goal, identify players or guess from adjacent samples. Advertisements, shirt numbers and clock digits are not scores. Return one sample per exact ID, readable boolean, homeLabel/awayLabel exactly as printed, integer homeGoals/awayGoals (-1 if unreadable), matchClock exactly as printed. If a score is unclear set readable:false.'});
      const sampleSchema={type:'object',required:['sampleId','readable','homeLabel','awayLabel','homeGoals','awayGoals','matchClock'],properties:{
        sampleId:{type:'string',enum:ids},readable:{type:'boolean'},homeLabel:{type:'string'},awayLabel:{type:'string'},
        homeGoals:{type:'integer'},awayGoals:{type:'integer'},matchClock:{type:'string'}}};
      const result=await generate({model,contents,config:{responseMimeType:'application/json',thinkingConfig:{thinkingLevel:'LOW'},
        responseJsonSchema:{type:'object',required:['samples'],properties:{samples:{type:'array',items:sampleSchema}}}}},`Source score ledger batch ${from}`);
      samples=normalizeScoreSamples(result.parsed.samples,ids);
      await writeFile(path,JSON.stringify({samples}));
    }
    return samples;
  });
  const ledger=buildSourceScoreLedger(results.flat(),media.duration,interval);
  await writeFile(join(folder,'ledger.json'),JSON.stringify(ledger,null,2));return ledger;
}
