// Isolated end-to-end regression using a saved whole-video observation timeline.
// Uses configured Gemini/TTS services. Never overwrites existing jobs or exports.
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { loadProjectEnv } from "../local-processor/env.mjs";
await loadProjectEnv(resolve(".env"));
const sourceId = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(sourceId || "")) throw new Error("Provide a saved source job ID.");
const original = JSON.parse(await readFile(join(resolve(process.env.LOCAL_DATA_DIR || "local-data"),"jobs",`${sourceId}.json`),"utf8"));
let observations = original.observedMoments || original.moments;
if (process.argv[3]) {
  const timelineId = process.argv[3];
  if (!/^[a-f0-9-]{36}$/.test(timelineId)) throw new Error("Provide a valid saved observation job ID.");
  const timeline = JSON.parse(await readFile(join(resolve(process.env.LOCAL_DATA_DIR || "local-data"),"jobs",`${timelineId}.json`),"utf8"));
  const hashFile = async path => { const hash=createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); };
  if (await hashFile(original.sourceKey) !== await hashFile(timeline.sourceKey)) throw new Error("Observation timeline belongs to different source footage.");
  observations = timeline.observedMoments || timeline.moments;
}
const resumeDirectory = process.env.REGRESSION_RESUME_DIR ? resolve(process.env.REGRESSION_RESUME_DIR) : null;
if (resumeDirectory && !resumeDirectory.startsWith(resolve("work") + sep)) throw new Error("Regression resume directory must be inside work/.");
const directory = resumeDirectory || resolve("work",`pipeline-regression-${Date.now()}`);
const data = join(directory,"data");
await mkdir(join(data,"jobs"),{recursive:true});
let id = randomUUID();
const moments = observations.map(moment => {
  const clean = {...moment, keepDecision:moment.isReplay ? "replay" : "keep",selectedForFinalVideo:false};
  for (const key of ["trackingDecision","semanticSignature","semanticVerified","semanticVerificationVersion","rejectReason"]) delete clean[key];
  return clean;
});
const now = new Date().toISOString();
if (resumeDirectory) {
  const jobs = (await readdir(join(data,"jobs"))).filter(name => name.endsWith(".json"));
  if (jobs.length !== 1) throw new Error("Expected exactly one isolated regression job.");
  const saved = JSON.parse(await readFile(join(data,"jobs",jobs[0]),"utf8"));
  if (saved.sourceKey !== original.sourceKey) throw new Error("Resume source does not match this regression.");
  id = saved.id;
} else await writeFile(join(data,"jobs",`${id}.json`),JSON.stringify({id,stage:"detecting_moments",progress:30,
  sourceKey:original.sourceKey,sourceName:original.sourceName,media:original.media,settings:{...original.settings},
  moments,warnings:[],createdAt:now,updatedAt:now}));
const port=8791;
const child=spawn(process.execPath,[resolve("local-processor/server.mjs")],{windowsHide:true,
  env:{...process.env,LOCAL_PROCESSOR_PORT:String(port),LOCAL_DATA_DIR:data,
    TRACKING_CACHE_DIR:join(directory,"tracking-cache")}});
let logs="";
child.stdout.on("data",data=>{logs+=data;});
child.stderr.on("data",data=>{logs+=data;});
child.on("error",error=>{console.error(error.message);});
try {
  let ready=false;
  for(let attempt=0;attempt<30;attempt++) {
    try { const health=await fetch(`http://127.0.0.1:${port}/health`); ready=health.ok; } catch { /* starting */ }
    if(ready)break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  if(!ready)throw new Error("Regression processor did not start.");
  const retryEndpoint = process.env.REGRESSION_RETRY_MODE === "render" ? "retry-render" : "retry-analysis";
  const response=await fetch(`http://127.0.0.1:${port}/jobs/${id}/${retryEndpoint}`,{method:"POST"});
  if(!response.ok)throw new Error(await response.text());
  console.log(JSON.stringify({directory,id,stage:"started"}));
  let previous="";
  for(;;) {
    const job=await (await fetch(`http://127.0.0.1:${port}/jobs/${id}`)).json();
    const state=JSON.stringify({stage:job.stage,progress:job.progress,detail:job.progressDetail,error:job.error?.message});
    if(state!==previous){console.log(state);previous=state;}
    if(job.stage==="completed" || job.stage==="failed") {
      await writeFile(join(directory,"result.json"),JSON.stringify(job,null,2));
      console.log(JSON.stringify({directory,id,result:job.stage,output:join(data,"outputs",id,"final.mp4")}));
      if(job.stage==="failed")process.exitCode=1;
      break;
    }
    await new Promise(resolve=>setTimeout(resolve,3000));
  }
} finally {
  child.kill();
  await writeFile(join(directory,"processor.log"),logs);
}
