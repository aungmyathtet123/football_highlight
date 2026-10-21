const number={type:'number'},text={type:'string'};
const payoff={type:['object','null'],properties:{verified:{type:'boolean'},eventType:text,startTime:number,endTime:number,
  targetBox:{type:'array',items:number,minItems:4,maxItems:4}}};
export const SCORE_ACTION_SCHEMA={type:'object',required:['moments','uncertainties'],properties:{
  uncertainties:{type:'array',items:text},moments:{type:'array',items:{type:'object',
    required:['startTime','endTime','eventType','storyPhase','keepDecision','actionComplete','completionReason','trackingBrief','importanceScore','confidence','ballVisible','mainPlayerVisible','isReplay','description','analysisPurpose'],
    properties:{startTime:number,endTime:number,eventType:{type:'string',enum:['goal','disallowed_goal','save','shot_on_target','shot_off_target','big_chance','celebration','var']},
      storyPhase:{type:'string',enum:['action','reaction','replay']},keepDecision:{type:'string',enum:['keep','support','replay','reject']},
      actionComplete:{type:'boolean'},completionReason:text,importanceScore:number,confidence:{type:'number',minimum:0,maximum:1},
      ballVisible:{type:'boolean'},mainPlayerVisible:{type:'boolean'},isReplay:{type:'boolean'},description:text,analysisPurpose:text,
      keyActionTimes:{type:'array',items:{type:'object',required:['time','detail'],properties:{time:number,detail:text}}},
      trackingBrief:{type:['object','null'],properties:{primaryPlayerRole:text,attackDirection:text,cameraMode:text,payoffTarget:text,
        originTime:number,contactTime:number,flightStartTime:number,handoffTime:number,payoffStartTime:number,payoffEndTime:number,
        annotationStartTime:number,annotationEndTime:number,goalFocusX:{type:['number','null']},payoffEvidence:payoff,
        requiredSubjectsByPhase:{type:'array',items:{type:'object',required:['phase','subjects'],properties:{phase:text,subjects:{type:'array',items:text}}}}}}
    }}}}};
export function validScoreActionDraft(draft,duration) {
  return Array.isArray(draft?.moments)&&Array.isArray(draft.uncertainties)&&draft.moments.every(scene=>
    Number.isFinite(scene.startTime)&&Number.isFinite(scene.endTime)&&scene.startTime>=0&&scene.endTime>scene.startTime&&scene.endTime<=duration+.05
    && Number.isFinite(scene.confidence)&&scene.confidence>=0&&scene.confidence<=1
    && ['keep','support','replay','reject'].includes(scene.keepDecision)
    && ['action','reaction','replay'].includes(scene.storyPhase));
}
// Discovery stopping condition only, never a source/crop approval. A later
// goal cannot be the incident whose score was already read before that goal.
export function hasCompleteLiveScoreCandidate(moments,anchor,offset=0) {
  return (moments||[]).some(scene=>{
    if(!['goal','disallowed_goal'].includes(scene.eventType) || scene.actionComplete!==true
      || scene.isReplay || scene.storyPhase==='replay' || scene.keepDecision==='reject') return false;
    const brief=scene.trackingBrief,finish=brief?.payoffEvidence?.verified===true
      ? brief.payoffEvidence.startTime : brief?.contactTime ?? scene.endTime;
    return Number.isFinite(finish) && finish>=scene.startTime && finish<=scene.endTime
      && (!Number.isFinite(anchor?.after?.time) || offset+finish<=anchor.after.time+.001);
  });
}
export function scoreActionObservationProfile(duration) {
  const seconds=Math.max(1,Number(duration)||1);
  // Discovery only locates candidate passages. Avoid feeding tens of thousands
  // of frames/tokens into a retry of a broad score-transition search. Short
  // independently verified clips and
  // native tracking still inspect contact at higher frame rates afterwards.
  const bitrateKbps=Math.floor(Math.min(1800,12*1024*1024*8/seconds/1000));
  return {fps:2,height:720,bitrateKbps,maximumBytes:15*1024*1024};
}
export function scoreActionSearchWindows(anchor,maximumSeconds=40,overlapSeconds=10) {
  const start=Number(anchor.startTime),end=Number(anchor.endTime);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start) return [];
  if(end-start<=maximumSeconds) return [anchor];
  const windows=[];
  const step=Math.max(1,maximumSeconds-overlapSeconds);
  for(let cursor=start;cursor<end;cursor+=step) {
    const upper=Math.min(end,cursor+maximumSeconds);
    windows.push({...anchor,startTime:cursor,endTime:upper,partialSearch:true});
    if(upper===end) break;
  }
  return windows;
}
