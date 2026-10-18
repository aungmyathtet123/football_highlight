import {createHash} from 'node:crypto';
import {hybridDetectorScene} from './hybrid-tracking-policy.mjs';
import {hybridEvidenceWindowMatches} from './hybrid-framing.mjs';

export const HYBRID_CAMERA_REPAIR_VERSION=1;
const finite=Number.isFinite;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Compare the delivered trajectory on a common clock. A denser set of
// detections alone is not a new camera plan and must not buy another verdict.
export function cameraPlanSignature(scene,evidence) {
  const frames=evidence?.keyframes||[],duration=scene.endTime-scene.startTime;
  if(!frames.length || frames.some(frame=>!finite(frame.time)||!finite(frame.cameraX)))return null;
  let index=0;
  const samples=Array.from({length:Math.ceil(duration*24)+1},(_,tick)=>{
    const time=Math.min(duration,tick/24);
    while(index+1<frames.length && frames[index+1].time<=time)index++;
    const a=frames[index],b=frames[index+1]||a;
    const progress=b.sceneCut||b.cameraCut?0:Math.max(0,Math.min(1,(time-a.time)/Math.max(.001,b.time-a.time)));
    return Math.round((a.cameraX+(b.cameraX-a.cameraX)*progress)*10000);
  });
  return hash({start:scene.startTime,end:scene.endTime,samples,
    cuts:frames.filter(frame=>frame.sceneCut||frame.cameraCut).map(frame=>Math.round(frame.time*24))});
}

export function hybridRepairScene(scene,evidence) {
  const comparison=evidence?.outcomeComparison,source=comparison?.sourceOutcome;
  const sameSource=comparison?.sameActionVerified===true
    && comparison.sourceSceneStartTime===scene.startTime && comparison.sourceSceneEndTime===scene.endTime;
  const sourceObserved=sameSource && source?.actionComplete===true && !comparison.clockProblems?.length;
  const review=comparison?.clockProblems?.length
    ? evidence.initialRenderReview:evidence?.renderReview;
  const checks=(sourceObserved?source.phaseChecks:review?.phaseChecks)||[];
  const duration=scene.endTime-scene.startTime;
  const visible=checks.filter(check=>finite(check.time)&&check.time>=0&&check.time<=duration
    &&check.ballVisible===true&&typeof check.description==='string'&&check.description.trim().length>=12);
  const payoffs=visible.filter(check=>check.phase==='payoff').sort((a,b)=>a.time-b.time);
  const payoff=payoffs[0];
  const contact=visible.filter(check=>check.phase==='contact'&&check.playerVisible===true
    &&payoff&&check.time<payoff.time).sort((a,b)=>a.time-b.time).at(-1);
  const setup=visible.filter(check=>check.phase==='setup'&&check.playerVisible===true
    &&contact&&check.time<contact.time).sort((a,b)=>a.time-b.time)[0];
  const absolute=time=>+(scene.startTime+time).toFixed(3);
  const brief=contact&&payoff ? {...scene.trackingBrief,
    originTime:absolute(setup?.time??0),contactTime:absolute(contact.time),
    flightStartTime:absolute(contact.time),handoffTime:absolute(contact.time+.10),
    payoffStartTime:absolute(payoff.time),payoffEndTime:scene.endTime,
    timingEvidence:sourceObserved?'independent_source_action_phases':'observed_crop_contact_phases'}:scene.trackingBrief;
  // Source semantics may guide a new pass. They never supply detector points
  // or final crop approval; the new pixels receive their own complete review.
  const eventType=sourceObserved && source.eventType!=='uncertain'
    && !['goal','disallowed_goal'].includes(scene.eventType) ? source.eventType:scene.eventType;
  return hybridDetectorScene({...scene,eventType,trackingBrief:brief});
}

export async function repairHybridCamera(scene,evidence,{track,review,assess,checkpoint}) {
  let current=evidence;
  if(assess(scene,current).usable)return {evidence:current,assessment:assess(scene,current)};
  const source=evidence?.outcomeComparison?.sourceOutcome;
  if(source?.actionComplete===false)return {evidence:current,assessment:assess(scene,current),reason:'source_action_unresolved'};
  const repairScene=hybridRepairScene(scene,evidence);
  const plans=[
    {name:'dense_ball_follow',sampleFps:20,coarseSampleFps:10,ballImageSize:1600,imageSize:1280,cameraStrategy:'ball_follow'},
    {name:'source_cadence_ball_follow',sampleFps:30,coarseSampleFps:15,ballImageSize:1920,imageSize:1280,cameraStrategy:'ball_follow'},
  ];
  const history=[...(evidence?.cameraRepairHistory||[])];
  for(const plan of plans) {
    const key=hash({version:HYBRID_CAMERA_REPAIR_VERSION,id:scene.id,start:scene.startTime,end:scene.endTime,
      eventType:repairScene.eventType,brief:repairScene.trackingBrief,plan});
    if(history.some(entry=>entry.key===key))continue;
    const priorSignature=cameraPlanSignature(scene,current);
    const native=await track(repairScene,plan);
    if(!hybridEvidenceWindowMatches(scene,native))throw new Error('Camera repair changed the locked source interval.');
    const signature=cameraPlanSignature(scene,native);
    const entry={key,version:HYBRID_CAMERA_REPAIR_VERSION,strategy:plan.name,cameraSignature:signature,
      status:signature && signature!==priorSignature?'reviewing':'unchanged'};
    history.push(entry);
    if(!signature || signature===priorSignature) {
      current={...current,cameraRepairHistory:[...history]};
      await checkpoint(current,plan);
      continue;
    }
    current=await review(repairScene,{...native,outcomeComparison:evidence.outcomeComparison,
      initialRenderReview:undefined,renderReview:undefined,finalCropVerified:false,
      cameraRepairHistory:[...history]});
    // Assessment uses the locked scene and the independent source/crop
    // correction policy. A provisional semantic repair cannot bypass it.
    const assessment=assess(scene,current);
    entry.status=assessment.usable?'verified':'rejected';
    current={...current,cameraRepairHistory:history.map(item=>({...item}))};
    await checkpoint(current,plan);
    if(assessment.usable)return {evidence:current,assessment};
  }
  return {evidence:current,assessment:assess(scene,current)};
}
