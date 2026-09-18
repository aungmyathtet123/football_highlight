// Explicit opt-in Gemini check of an existing uncropped, labeled test proxy.
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {resolve,join} from "node:path";
import {GoogleGenAI} from "@google/genai";
import {loadProjectEnv} from "../local-processor/env.mjs";
import {normalizePayoffEvidence} from "../local-processor/payoff-evidence.mjs";
await loadProjectEnv(resolve(".env"));
const id=process.argv[2];
if(!/^[a-f0-9-]{36}$/.test(id||"")) throw new Error("Provide a saved test export ID.");
const directory=resolve("local-data/outputs",id);
const saved=JSON.parse(await readFile(join(directory,"short-form-test.json"),"utf8"));
const ai=new GoogleGenAI({vertexai:true,apiKey:process.env.GEMINI_API_KEY,httpOptions:{timeout:90000}});
const response=await ai.models.generateContent({model:process.env.GEMINI_MODEL,contents:[
  {inlineData:{data:(await readFile(join(directory,"evidence.mp4"))).toString("base64"),mimeType:"video/mp4"},videoMetadata:{fps:4}},
  {text:"Watch every labeled SCENE completely. Return JSON {scenes:[{index,visibleResult,payoffEvidence}]}. Ignore prior names, scores, and hypotheses. For an actual visible goal, save, or shot result, payoffEvidence is {verified:true,eventType:'goal'|'save'|'shot_on_target'|'big_chance',startTime,endTime,targetBox:[x1,y1,x2,y2]}. Times are seconds relative to the START OF THAT LABELED SCENE, not the whole proxy. Choose a continuous interval at least 0.5 seconds where the result is visibly proven. The normalized targetBox must contain the ball/result and relevant goalkeeper/net or receiver, not unrelated walking players. Keep the rectangle focused on the actual result rather than the whole pitch. If uncertain, celebration only, or no actual result visible, payoffEvidence:null. This evidence is used to keep the real scoring area inside a portrait crop. Do not invent coordinates or timing."}
],config:{responseMimeType:"application/json",temperature:0}}).catch(error=>{throw new Error(`Gemini visual verification failed (${error.status||error.code||"provider error"}).`);});
const parsed=JSON.parse(response.text||"{}");
const moments=saved.moments.map((moment,index)=>{
  const proof=parsed.scenes?.find(scene=>scene.index===index);
  return {...moment,trackingBrief:{...moment.trackingBrief,payoffEvidence:normalizePayoffEvidence(proof?.payoffEvidence,moment.eventType,moment.startTime,moment.endTime,moment.startTime)}};
});
await mkdir(resolve("work"),{recursive:true});
await writeFile(resolve("work/benchmark-payoffs.json"),JSON.stringify({moments,observations:parsed.scenes},null,2));
console.log(JSON.stringify({path:resolve("work/benchmark-payoffs.json"),observations:parsed.scenes}));
