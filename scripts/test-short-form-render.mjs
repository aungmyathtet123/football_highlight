// Opt-in integration check. Reuses saved verified tracking; never overwrites a job.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { GoogleGenAI } from "@google/genai";
import { loadProjectEnv } from "../local-processor/env.mjs";
import { synthesizeGoogleCloudSpeech } from "../local-processor/google-cloud-tts.mjs";
import { renderVideoV2 } from "../local-processor/render-video-v2.mjs";
import { conciseCaption, shortReactionCandidates, shortFormWritingContract, obviousIdentityProblems, unverifiedNamedEntities } from "../local-processor/short-form-policy.mjs";

await loadProjectEnv(resolve(".env"));
const sourceJobId = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(sourceJobId || "")) throw new Error("Supply an existing completed job ID.");
const root = resolve(process.env.LOCAL_DATA_DIR || "local-data");
const draftId = process.argv[3];
if (draftId && !/^[a-f0-9-]{36}$/.test(draftId)) throw new Error("Invalid saved draft ID.");
const cachedDraft = draftId ? JSON.parse(await readFile(join(root,"outputs",draftId,"draft-audit.json"),"utf8")) : null;
const job = JSON.parse(await readFile(join(root, "jobs", `${sourceJobId}.json`), "utf8"));
const tracking = JSON.parse(await readFile(join(root, "outputs", sourceJobId, "tracking", "tracking.json"), "utf8"));
const id = randomUUID();
const directory = join(root, "outputs", id);
await mkdir(directory, { recursive: true });
let moments = shortReactionCandidates(job.moments.filter((moment) => moment.selectedForFinalVideo).sort((a,b) => a.editOrder-b.editOrder));
const filters = moments.map((moment,index) => `[0:v]trim=start=${moment.startTime}:end=${moment.endTime},setpts=PTS-STARTPTS,fps=4,scale=-2:360,drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':text='SCENE ${index}':fontsize=20:fontcolor=white:box=1:boxcolor=black:x=10:y=10,format=yuv420p[s${index}]`);
filters.push(`${moments.map((_,index)=>`[s${index}]`).join("")}concat=n=${moments.length}:v=1:a=0[v]`);
const proxy = join(directory,"evidence.mp4");
const graph = join(directory,"evidence-filter.txt");
await writeFile(graph,filters.join(";\n"));
await run(process.env.FFMPEG_PATH,["-hide_banner","-y","-i",job.sourceKey,"-/filter_complex",graph,"-map","[v]","-an","-c:v","libx264","-preset","veryfast","-crf","28",proxy]);
const ai = new GoogleGenAI({vertexai:true,apiKey:process.env.GEMINI_API_KEY,httpOptions:{timeout:90000}});
const response = cachedDraft ? {text:JSON.stringify({scenes:cachedDraft.moments.map((moment,index)=>({index,narration:moment.commentary,captionText:moment.onScreenText}))})} : await ai.models.generateContent({model:process.env.GEMINI_MODEL,contents:[{inlineData:{data:(await readFile(proxy)).toString("base64"),mimeType:"video/mp4"},videoMetadata:{fps:4}},{text:shortFormWritingContract()+" Watch every labeled scene. Return JSON {scenes:[{index,narration,captionText,visibleEvidence}]}. For action scenes use 8-13 words of causal analysis matching exactly those pixels. For celebration scenes narration and captionText must be empty strings. Do not add names, teams or scores. Do not rely on previous descriptions, which are not supplied."}],config:{responseMimeType:"application/json",temperature:.1}});
const scenes = JSON.parse(response.text || "{}").scenes;
if(!Array.isArray(scenes)||scenes.length!==moments.length) throw new Error("Incomplete visual script.");
moments = moments.map((moment,index)=>{
  const scene=scenes.find(item=>Number(item.index)===index);
  if(!scene) throw new Error("Missing scene.");
  const reaction=moment.eventType==="celebration"||moment.storyPhase==="reaction";
  const narration=reaction?"":String(scene.narration||"");
  if(obviousIdentityProblems(narration).length) throw new Error("Unverified name in draft.");
  if(!reaction&&!conciseCaption(scene.captionText)) throw new Error("Invalid caption headline.");
  return {...moment,editOrder:index,commentary:narration,onScreenText:reaction?"":conciseCaption(scene.captionText),effect:"none",freezeDuration:0,playbackRate:1,transitionIn:"cut",transitionDuration:0,playerHighlight:false,eventCallout:"none",colorGrade:moment.eventType==="goal"?"goal_gold":"clean",soundEffect:moment.eventType==="goal"?"impact":"none"};
});
const auditResponse=cachedDraft ? {text:JSON.stringify(cachedDraft.audit)} : await ai.models.generateContent({model:process.env.GEMINI_MODEL,contents:"Extract all player/team names, nicknames, initials, aliases and score claims in this narration and added captions. Roles are allowed. Return JSON {namedEntities:[],scoreClaims:[]}. Text: "+JSON.stringify(moments.map(m=>({narration:m.commentary,caption:m.onScreenText}))),config:{responseMimeType:"application/json",temperature:0}});
const audit=JSON.parse(auditResponse.text||"{}");
await writeFile(join(directory,"draft-audit.json"),JSON.stringify({moments,audit},null,2));
console.log(JSON.stringify({stage:"identity_audit",id,audit}));
if(!Array.isArray(audit.namedEntities)||!Array.isArray(audit.scoreClaims)||unverifiedNamedEntities(audit.namedEntities).length||audit.scoreClaims.length) throw new Error("Independent identity check failed.");
console.log(JSON.stringify({stage:"script_verified",id,scenes:moments.map(m=>({narration:m.commentary,caption:m.onScreenText}))}));
const tts = new Map();
tts.durations=new Map();
for(const moment of moments){
  if(!moment.commentary) continue;
  const path=join(directory,`${moment.id}.wav`);
  await synthesizeGoogleCloudSpeech(moment.commentary,path);
  const duration=Number(await run(process.env.FFPROBE_PATH,["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",path]));
  tts.set(moment.id,path);tts.durations.set(moment.id,duration);
}
const output=join(directory,"final.mp4");
console.log(JSON.stringify({stage:"rendering",id}));
const result=await renderVideoV2(job.sourceKey,output,moments,{...job.settings,durationMode:"auto",commentary:true,captions:true},job.media,tts,job.overlayMasks||[],tracking);
const media=JSON.parse(await run(process.env.FFPROBE_PATH,["-v","error","-show_entries","format=duration:stream=codec_type,width,height,r_frame_rate","-of","json",output]));
if(Number(media.format.duration)<30) throw new Error("Sample is shorter than the required minimum.");
await writeFile(join(directory,"short-form-test.json"),JSON.stringify({sourceJobId,moments,result,media},null,2));
console.log(JSON.stringify({stage:"rendered",id,output,duration:media.format.duration,loudness:result.loudness}));

function run(executable,args){return new Promise((resolveResult,reject)=>{const child=spawn(executable,args,{windowsHide:true});let stdout="",stderr="";child.stdout.on("data",chunk=>stdout+=chunk);child.stderr.on("data",chunk=>{stderr=(stderr+chunk).slice(-3000);});child.on("error",reject);child.on("close",code=>code===0?resolveResult(stdout):reject(new Error(stderr)));});}
