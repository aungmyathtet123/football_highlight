// Bounded request-contract diagnostic. Never writes job state or crop approvals.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { loadProjectEnv } from '../local-processor/env.mjs';
import { geminiTrafficPolicy } from '../local-processor/gemini-traffic-policy.mjs';
import { geminiGenerationConfig } from '../local-processor/gemini-generation-config.mjs';
import { videoFramingRequest, videoFramingWindows, normalizeVideoFramingResponse,
  validateVideoFramingFrames } from '../local-processor/gemini-video-framing.mjs';
import { focusedFramingResponseSchema, FOOTBALL_ACTION_COMPLETION_CONTRACT } from '../local-processor/gemini-framing.mjs';

const [input,durationText,output,countText,boundsMode]=process.argv.slice(2);
const duration=Number(durationText);
if(!input||!output||!Number.isFinite(duration)||duration<=0) throw new Error('Usage: video duration-seconds new-report-directory');
await loadProjectEnv(resolve('.env'));
const directory=resolve(output);await mkdir(directory,{recursive:true});
const traffic=geminiTrafficPolicy();
const model=process.env.GEMINI_KEYFRAME_MODEL||process.env.GEMINI_MODEL;
const ai=new GoogleGenAI({vertexai:true,project:process.env.GOOGLE_CLOUD_PROJECT,location:traffic.location,
  apiKey:process.env.GEMINI_API_KEY,httpOptions:{...traffic.httpOptions,timeout:180000}});
const window={...videoFramingWindows(duration)[0],start:0,end:duration};
if(countText) {
  const count=Number(countText);
  if(!Number.isInteger(count)||count<1||count>window.count) throw new Error('Invalid diagnostic row bound');
  window.count=count;window.indexes=window.indexes.slice(0,count);
}
const request=videoFramingRequest({model,data:(await readFile(resolve(input))).toString('base64'),window,fps:8,
  sceneContext:{startTime:0,endTime:duration},contract:FOOTBALL_ACTION_COMPLETION_CONTRACT,schema:focusedFramingResponseSchema()});
request.config=geminiGenerationConfig(model,request.config);
if(boundsMode==='unbounded') {
  delete request.config.responseSchema.properties.frames.minItems;
  delete request.config.responseSchema.properties.frames.maxItems;
}
if(boundsMode==='bounded') {
  request.config.responseSchema.properties.frames.minItems=window.count;
  request.config.responseSchema.properties.frames.maxItems=window.count;
}
const started=Date.now();
try {
  const response=await ai.models.generateContent(request);
  await writeFile(join(directory,'response.json'),JSON.stringify(response));
  const raw=JSON.parse(response.text);
  const decoded=normalizeVideoFramingResponse(raw);
  let validationError=null;
  try {validateVideoFramingFrames(decoded,window.indexes,8);} catch(error) {validationError=error.message;}
  const report={model,seconds:(Date.now()-started)/1000,requestedRows:window.count,
    returnedRows:raw.frames?.length,finishReason:response.candidates?.[0]?.finishReason,
    usage:response.usageMetadata,validationError};
  await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  if(validationError) process.exitCode=1;
} catch(error) {
  const message=String(error.message).replaceAll(process.env.GEMINI_API_KEY||'__no_key__','[REDACTED]').slice(0,1000);
  const report={model,seconds:(Date.now()-started)/1000,error:message};
  await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));process.exitCode=1;
}
