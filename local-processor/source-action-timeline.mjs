import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {footballVideoPart} from './gemini-media-policy.mjs';

const PHASES=['setup','contact','flight','continuation','payoff','reaction','decision'];
const SITUATIONS=['approach','possession','release','travel','receive','keeper_touch','rebound','loose_ball','result','reaction','decision'];
export const SOURCE_ACTION_TIMELINE_VERSION=1;
export const SOURCE_ACTION_TIMELINE_SCHEMA={type:'OBJECT',required:['phases','uncertainties'],properties:{
  phases:{type:'ARRAY',items:{type:'OBJECT',required:['phase','situation','startTime','endTime','visibleAction','actionResolved','ballInPlay'],properties:{
    phase:{type:'STRING',enum:PHASES},situation:{type:'STRING',enum:SITUATIONS},
    startTime:{type:'NUMBER'},endTime:{type:'NUMBER'},visibleAction:{type:'STRING'},
    actionResolved:{type:'BOOLEAN'},ballInPlay:{type:'BOOLEAN'}}}},
  uncertainties:{type:'ARRAY',items:{type:'STRING'}}}};

export function validateSourceActionTimeline(value,duration,{fps=8,sampled=false,coverageEnd=duration}={}) {
  if(!Number.isFinite(duration)||duration<=0||!Array.isArray(value?.phases)||!value.phases.length
    ||value.phases.length>64||!Array.isArray(value.uncertainties)) throw Error('Incomplete source action timeline');
  let end=0;
  const phases=value.phases.map((phase,index)=>{
    // Video observations can label a contact at ONE sampled tick and use
    // inclusive end times. Decode that representation, never shift a contact
    // or invent a phase across an unobserved gap. Preserve the original map.
    const next=value.phases[index+1];
    const point=sampled&&phase.endTime===phase.startTime;
    const inclusive=sampled&&next&&Math.abs(next.startTime-phase.endTime-1/fps)<.00011;
    const finalInclusive=sampled&&!next&&Math.abs(coverageEnd-phase.endTime-1/fps)<.00011;
    const decoded={...phase,endTime:point||inclusive||finalInclusive?Math.min(duration,phase.endTime+1/fps):phase.endTime};
    return decoded;
  });
  for(const phase of phases) {
    if(!PHASES.includes(phase.phase)||!SITUATIONS.includes(phase.situation)
      ||!Number.isFinite(phase.startTime)||!Number.isFinite(phase.endTime)
      ||Math.abs(phase.startTime-end)>.001||phase.endTime<=phase.startTime||phase.endTime>duration+.001
      ||typeof phase.visibleAction!=='string'||!phase.visibleAction.trim()
      ||typeof phase.actionResolved!=='boolean'||typeof phase.ballInPlay!=='boolean'
      ||phase.phase==='payoff'&&(!['result','keeper_touch','rebound'].includes(phase.situation)||!phase.actionResolved))
      throw Error('Invalid source action timeline clock or consequence');
    end=phase.endTime;
  }
  if(Math.abs(end-coverageEnd)>.001) throw Error('Source action timeline omitted part of the selected scene');
  return sampled?{...value,phases,observedThrough:coverageEnd,originalPhases:value.originalPhases||value.phases}:value;
}

// Semantic labels come from one complete-video observation. Coordinates,
// source cuts and identity remain the original observations. This is NOT a
// visibility verdict; the newly rendered crop still needs independent review.
export function applySourceActionTimeline(raw,timeline,duration) {
  validateSourceActionTimeline(timeline,duration,{coverageEnd:timeline.observedThrough??duration});
  if(!Array.isArray(raw?.frames)) return raw;
  return {...raw,frames:raw.frames.map(frame=>{
    const phase=timeline.phases.find(value=>frame?.time>=value.startTime-1e-7&&frame.time<value.endTime-1e-7);
    return phase?{...frame,phase:phase.phase,situation:phase.situation,
      actionResolved:phase.actionResolved,ballInPlay:phase.ballInPlay,
      phaseEvidence:phase.visibleAction}:frame;
  })};
}

export async function observeSourceActionTimeline({contextPath,duration,signature,directory,model,generate,report=async()=>{},contract=''}) {
  const path=join(directory,`${signature}.source-action-timeline-v${SOURCE_ACTION_TIMELINE_VERSION}.json`);
  try {return validateSourceActionTimeline(JSON.parse(await readFile(path,'utf8')),duration);} catch(error) {
    if(error.code!=='ENOENT') throw error;
  }
  await report('Reading the complete selected action once to identify setup, touches and the visible finish; saved position observations remain reusable.');
  const value=await generate({model,contents:[footballVideoPart((await readFile(contextPath)).toString('base64'),8),{text:
    `Watch this complete ORIGINAL selected football scene, duration ${duration} seconds. Identify a single coherent action timeline before any crop planning. Do not emit coordinates, names, camera commands or approval flags.
Partition the ENTIRE video from 0 to ${duration} seconds into adjacent non-overlapping phases using scene-local times. Include every real pass, kick, header, goalkeeper contact and visible sporting consequence. Give each visible contact a short interval containing its actual timestamp. Describe concrete visual evidence, not a claimed outcome or scoreboard.
A run toward a stationary set-piece ball BEFORE touching it is setup/approach, NOT possession or release. The meaningful kick then becomes contact/release. Flight/travel follows the actual ball. A receiving touch is contact/receive.
A shot hitting the post/crossbar, being saved, blocked, going wide or visibly crossing inside the posts is payoff/result with actionResolved:true at that visible consequence. A later defensive clearance does NOT erase the completed shot's payoff: mark it separately as continuation/release or flight/travel and keep the earlier payoff in the timeline. A NEW attacking shot must have its own contact and payoff. For still-live rebounds keep ballInPlay:true. Do not mistake a ball bouncing inside the net for an unresolved new attack. Never invent a goal from celebrating players. If the finish is hidden, describe uncertainty, not a fake payoff.
Reaction-only footage follows a visible result. Keep directly observed late clearance and reactions as their own phases. Situation is approach|possession|release|travel|receive|keeper_touch|rebound|loose_ball|result|reaction|decision. actionResolved and ballInPlay describe the actual phase, not whether all future possessions have finished. ${contract}`}],
    config:{responseMimeType:'application/json',responseSchema:SOURCE_ACTION_TIMELINE_SCHEMA,maxOutputTokens:8192,thinkingConfig:{thinkingLevel:'MEDIUM'}}},'complete source action timeline');
  // Preserve an invalid original answer for diagnosis, never retry semantics
  // silently or promote its labels to a crop-approval result.
  await writeFile(`${path}.response.json`,JSON.stringify(value));
  const checked=validateSourceActionTimeline(value,duration);
  await writeFile(`${path}.tmp`,JSON.stringify(checked));await rename(`${path}.tmp`,path);
  return checked;
}
