// Local-only regression benchmark. No Gemini/TTS calls and no existing-job writes.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { loadProjectEnv } from "../local-processor/env.mjs";
import { renderVideoV2 } from "../local-processor/render-video-v2.mjs";
await loadProjectEnv(resolve(".env"));
const id = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(id || "")) throw new Error("Provide a completed source job ID.");
const root = resolve(process.env.LOCAL_DATA_DIR || "local-data");
const job = JSON.parse(await readFile(join(root,"jobs",`${id}.json`),"utf8"));
const proof = process.argv[3] ? JSON.parse(await readFile(resolve(process.argv[3]),"utf8")) : null;
const candidates = proof?.moments || job.moments;
const moments = candidates.filter(m=>(process.argv[4] ? m.id===process.argv[4] : m.selectedForFinalVideo) && m.storyPhase!=="reaction" && m.eventType!=="celebration").map(m=>({...m,selectedForFinalVideo:true})).sort((a,b)=>a.editOrder-b.editOrder).slice(0,3);
if (!moments.length) throw new Error("No selected actions to test.");
const directory = resolve("work",`tracking-benchmark-${Date.now()}`);
await mkdir(directory,{recursive:true});
const inputs = join(directory,"moments.json");
const resultPath = join(directory,"tracking.json");
const shotPath = join(directory,"shots.json");
await run(resolve(".venv-tracking/Scripts/python.exe"),[resolve("local-processor/shot-boundaries.py"),"--source",job.sourceKey,"--output",shotPath]);
await writeFile(inputs,JSON.stringify({moments}));
console.log(JSON.stringify({stage:"tracking",directory,scenes:moments.map(m=>({id:m.id,start:m.startTime,end:m.endTime}))}));
await run(resolve(".venv-tracking/Scripts/python.exe"),[
  resolve("local-processor/track-football-v2.py"),"--source",job.sourceKey,
  "--moments",inputs,"--output",resultPath,"--model",resolve("tools/tracking/yolo11n.pt"),
  "--ball-model",resolve("tools/tracking/yolo-football-ball-detection.pt"),"--sample-fps","10",
  "--image-size","960","--ball-image-size","1280",
  "--shots",shotPath,"--cache-dir",resolve("work",`tracking-regression-cache-${id}`),
  "--tracker",process.env.BENCHMARK_TRACKER || "botsort",
  "--camera-motion",process.env.BENCHMARK_CAMERA_MOTION || "sparseOptFlow",
]);
const tracking = JSON.parse(await readFile(resultPath,"utf8"));
const report = [];
for (const [index, original] of moments.entries()) {
  const moment = {...original,playbackRate:1,effect:"none",freezeDuration:0,playerHighlight:false,commentary:"",eventCallout:"none",soundEffect:"none",colorGrade:"clean",transitionIn:"cut",selectedForFinalVideo:true};
  const output = join(directory,`scene-${index+1}.mp4`);
  await renderVideoV2(job.sourceKey,output,[moment],{...job.settings,durationMode:"auto",captions:false,commentary:false,originalAudio:"muted",logoMasking:false},job.media,new Map(),[],tracking);
  const evidence = tracking.moments[moment.id];
  report.push({id:moment.id,output,ballDetectionCoverage:evidence.ballDetectionCoverage,directBallInFrameCoverage:evidence.directBallInFrameCoverage,jointFitCoverage:evidence.jointFitCoverage,cameraMaxStep:evidence.cameraMaxStep,slicedFrames:evidence.slicedFrames});
  console.log(JSON.stringify({stage:"scene_rendered",...report.at(-1)}));
  await run(process.env.FFMPEG_PATH || "ffmpeg",["-hide_banner","-y","-i",output,"-vf","fps=1,scale=180:320,tile=5x2","-frames:v","1",join(directory,`scene-${index+1}.jpg`)]);
}
await writeFile(join(directory,"report.json"),JSON.stringify(report,null,2));
console.log(JSON.stringify({stage:"complete",directory,report}));
function run(command,args) { return new Promise((ok,fail)=>{
  const child=spawn(command,args,{windowsHide:true}); let error="";
  child.stdout.on("data",d=>process.stdout.write(d));
  child.stderr.on("data",d=>{error=(error+d).slice(-2500);});
  child.on("error",fail); child.on("close",code=>code===0?ok():fail(new Error(error)));
}); }
