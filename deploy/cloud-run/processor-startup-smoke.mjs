// Runs only in the Linux build image; never creates an upload or calls Gemini.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const root=await mkdtemp(join(tmpdir(),'touchline-startup-'));
const port=18987;
let logs='';
const processor=spawn(process.execPath,['local-processor/server.mjs'],{
  env:{...process.env,LOCAL_DATA_DIR:root,LOCAL_PROCESSOR_PORT:String(port),
    GOOGLE_CLOUD_PROJECT:'startup-smoke',GOOGLE_CLOUD_LOCATION:'global',
    KEYFRAME_PROVIDER:'gemini',FFMPEG_PATH:'/usr/bin/ffmpeg',FFPROBE_PATH:'/usr/bin/ffprobe',
    TRACKING_PYTHON:'/opt/venv/bin/python',SOCCERNET_CALF_ENABLED:'false'}});
processor.stdout.on('data',chunk=>{logs+=chunk;});
processor.stderr.on('data',chunk=>{logs+=chunk;});
const exited=once(processor,'exit');
let passed=false;
try {
  const deadline=Date.now()+45000;
  while(Date.now()<deadline){
    if(processor.exitCode!==null||processor.signalCode!==null)throw new Error(`Processor startup failed: ${logs}`);
    try {
      const response=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(5000)});
      if(response.ok){
        const health=await response.json();
        assert.equal(health.ok,true,JSON.stringify(health.tools));
        const jobs=await(await fetch(`http://127.0.0.1:${port}/jobs`)).json();
        assert.equal(jobs.jobs.length,0);
        passed=true;break;
      }
    } catch(error){if(error?.code==='ERR_ASSERTION')throw error;}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.equal(passed,true,`Processor did not become healthy: ${logs}`);
  console.log('Verified real processor startup, module imports and Linux tool health with zero video jobs or AI calls.');
} finally {
  if(processor.exitCode===null&&processor.signalCode===null)processor.kill('SIGTERM');
  await exited;
  await rm(root,{recursive:true,force:true});
}
