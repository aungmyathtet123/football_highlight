// Local-only diagnostic. Reuses saved evidence; never changes a completed job.
import {readFile, mkdir, writeFile} from "node:fs/promises";
import {resolve,join} from "node:path";
import {randomUUID} from "node:crypto";
import {renderVideoV2} from "../local-processor/render-video-v2.mjs";
import {loadProjectEnv} from "../local-processor/env.mjs";
await loadProjectEnv(resolve(".env"));
const job = JSON.parse(await readFile(resolve(process.argv[2]),"utf8"));
const tracking = JSON.parse(await readFile(resolve(process.argv[3]),"utf8"));
const moment = job.moments.find(m=>m.id === process.argv[4]);
if (!moment || !tracking.moments[moment.id]) throw Error("Matching saved scene and tracking are required.");
const directory=resolve("work",`tactical-render-${randomUUID()}`);
await mkdir(directory,{recursive:true});
const tacticalDrawing=process.argv[5] || "ball";
const selected={...moment,selectedForFinalVideo:true,editOrder:0,effect:"freeze_analysis",freezeDuration:.8,
  freezeAtPhase:tacticalDrawing === "pass" ? "origin" : "contact",tacticalDrawing,playerHighlight:true,playbackRate:1,
  commentary:undefined,onScreenText:"BALL DIRECTION"};
const speech=new Map();speech.durations=new Map();
await renderVideoV2(job.sourceKey,join(directory,"diagnostic.mp4"),[selected],
  {...job.settings,commentary:false,originalAudio:"muted",durationMode:"auto"},job.media,speech,[],tracking);
await writeFile(join(directory,"test.json"),JSON.stringify({sourceJob:job.id,moment:selected.id}));
console.log(directory);
