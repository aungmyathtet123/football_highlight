import { SCORE_ACTION_SCHEMA } from './score-action-schema.mjs';
import {linkImmediateGoalReplays} from './action-boundaries.mjs';
import {verifiedSourceOutcomeCorrection} from './source-action-selection.mjs';

export const INITIAL_SECTION_VERSION = 2;
const text = {type:'string'}, number = {type:'number'}, boolean = {type:'boolean'};
const base = SCORE_ACTION_SCHEMA.properties.moments.items;
// No fixed array cardinalities: long broadcasts contain different numbers of
// shots/actions, and deeply constrained response schemas can be rejected by Google.
export const INITIAL_SECTION_SCHEMA = {
  type:'object', required:['moments','uncertainties','watchedThroughSeconds'], properties:{
    watchedThroughSeconds:number, uncertainties:{type:'array',items:text},
    moments:{type:'array',items:{...base,
      required:[...base.required,'storyId','shotIds','sourceObservation'],
      properties:{...base.properties,
        eventType:{type:'string',enum:['goal','disallowed_goal','save','shot_on_target','shot_off_target',
          'big_chance','celebration','var','offside','penalty','assist','foul','yellow_card','red_card',
          'free_kick','skill','dribble','tackle','normal_play']},
        storyPhase:{type:'string',enum:['build_up','action','payoff','reaction','replay','standalone']},
        storyId:text, shotIds:{type:'array',items:text}, visualClarity:number,
        narrativeCompleteness:number, focusX:number, onScreenText:text,
        trackingBrief:{...base.properties.trackingBrief,type:'object',
          required:['originTime','contactTime','flightStartTime','payoffStartTime','payoffEndTime']},
        sourceObservation:{type:'object',required:['setup','continuation','result','outcome',
          'initiatorAndBallVisible','continuationVisible','resultVisible','framingNotes','portraitReadability'],properties:{
          setup:text,continuation:text,result:text,outcome:text,
          framingNotes:text,portraitReadability:number,
          initiatorAndBallVisible:boolean,continuationVisible:boolean,resultVisible:boolean,
        }},
      }},
    },
    overlayMasks:{type:'array',items:{type:'object',required:['x','y','width','height'],properties:{
      x:number,y:number,width:number,height:number,label:text,confidence:number,
    }}},
  },
};

// This is validation of an INITIAL video observation, not an independent
// second opinion and not proof of a usable portrait crop. Never approve using
// normalized default timestamps or an invented percentage of the clip.
export function initialObservationProblems(item, duration) {
  const issues=[];
  const start=item?.startTime,end=item?.endTime;
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>duration+.05||end-start<.5)
    issues.push('invalid_excerpt_clock');
  if(!Array.isArray(item?.shotIds)||!item.shotIds.length) issues.push('missing_camera_shots');
  if(!String(item?.storyId||'').trim()) issues.push('missing_incident_id');
  if(!Number.isFinite(item?.confidence)||item.confidence<0||item.confidence>1) issues.push('invalid_confidence');
  if(item?.actionComplete!==true||item?.keepDecision==='reject') issues.push('incomplete_action');
  const observation=item?.sourceObservation;
  if(!observation||!['setup','continuation','result','outcome'].every(key=>
    typeof observation[key]==='string'&&observation[key].trim())) issues.push('missing_source_description');
  if(observation?.outcome!==item?.eventType) issues.push('outcome_class_conflict');
  const reaction=item?.eventType==='celebration'||item?.storyPhase==='reaction';
  if(!reaction) {
    if(item?.ballVisible!==true||item?.mainPlayerVisible!==true
      ||observation?.initiatorAndBallVisible!==true||observation?.continuationVisible!==true
      ||observation?.resultVisible!==true) issues.push('missing_visible_action_phase');
    const brief=item?.trackingBrief;
    const times=['originTime','contactTime','flightStartTime','payoffStartTime','payoffEndTime'];
    if(!brief||times.some(key=>!Number.isFinite(brief[key])||brief[key]<start||brief[key]>end)
      ||brief.originTime>brief.contactTime||brief.originTime>brief.flightStartTime
      // A cross/rebound can already be in the goalmouth before the final
      // scoring touch. These are overlapping observed phases, not a backwards
      // action. The resolved result must still follow BOTH release and touch.
      ||brief.originTime>brief.payoffStartTime
      ||brief.contactTime>brief.payoffEndTime||brief.flightStartTime>brief.payoffEndTime
      ||brief.payoffStartTime>brief.payoffEndTime) issues.push('invalid_action_phase_clock');
  } else if(observation?.resultVisible!==true) issues.push('unobserved_reaction');
  return issues;
}

// Keep scoring obligations BEFORE local validation. Otherwise rejecting both
// goals can turn "two observed goals" into a misleading complete zero-goal
// selection. This ledger is derived from the same paid video response; it
// neither fabricates action evidence nor sends another discovery request.
export function initialScoringObservations(draft, sectionStart = 0, sectionIndex = 0) {
  return (Array.isArray(draft?.moments) ? draft.moments : []).flatMap((item,index)=>{
    if(!['goal','disallowed_goal'].includes(item.eventType)
      ||item.storyPhase==='reaction'||item.eventType!==item.sourceObservation?.outcome
      ||item.sourceObservation?.resultVisible!==true) return [];
    const storyKey=String(item.storyId||`scene-${index+1}`).replace(/[^a-zA-Z0-9_-]/g,'-').slice(0,80);
    const absolute=time=>Number.isFinite(time)?sectionStart+time:null;
    return [{id:`observed-${sectionIndex+1}-${index+1}`,
      storyId:`story-${Math.round(sectionStart)}-${storyKey}`,eventType:item.eventType,
      startTime:absolute(item.startTime),endTime:absolute(item.endTime),
      contactTime:absolute(item.trackingBrief?.contactTime),
      isReplay:item.isReplay===true||item.storyPhase==='replay',section:sectionIndex+1}];
  });
}

export function initialScoringCoverage(observations, selected, {resolvedCandidates=selected}={}) {
  const eligible=(selected||[]).filter(scene=>scene.semanticVerified===true&&scene.actionComplete===true
    &&scene.keepDecision!=='reject'&&!scene.sourceAngleDeferred&&!scene.sourceSupportDeferred
    &&['goal','disallowed_goal'].includes(scene.eventType));
  const sameAction=(a,b)=>a.eventType===b.eventType&&(a.storyId===b.storyId
    ||Number.isFinite(a.contactTime)&&Number.isFinite(b.contactTime)
      &&Math.abs(a.contactTime-b.contactTime)<1
      &&Math.min(a.endTime,b.endTime)>Math.max(a.startTime,b.startTime));
  const groups=[];
  for(const observed of [...(observations||[])].sort((a,b)=>a.startTime-b.startTime)) {
    const group=groups.find(views=>views.some(other=>sameAction(observed,other)))
      // An explicit nearby replay is evidence for the same most recent goal,
      // not another scoring incident. Never collapse two distinct live goals.
      ||(observed.isReplay&&[...groups].reverse().find(views=>views.some(other=>
        other.eventType===observed.eventType&&Number.isFinite(other.endTime)
        &&observed.startTime>=other.endTime&&observed.startTime-other.endTime<=45)));
    if(group) group.push(observed);else groups.push([observed]);
  }
  const incidents=groups.map(views=>{
    const retained=eligible.some(scene=>views.some(view=>
      sameAction(view,{...scene,contactTime:scene.trackingBrief?.contactTime})));
    const corrected=(resolvedCandidates||[]).find(scene=>scene.semanticVerified===true
      &&scene.actionComplete===true&&scene.keepDecision!=='reject'
      &&views.some(view=>view.storyId===scene.storyId
        &&verifiedSourceOutcomeCorrection(scene,view.eventType)));
    return {id:views[0].storyId,eventType:views[0].eventType,observationIds:views.map(view=>view.id),
      covered:retained||Boolean(corrected),resolution:retained?'retained_scoring_action'
        :corrected?'source_outcome_corrected':null,
      ...(corrected?{correctedEventType:corrected.eventType,sourceOutcomeReconciliation:corrected.sourceOutcomeReconciliation}:{})};
  });
  const missing=incidents.filter(incident=>!incident.covered);
  return {version:1,required:incidents.length,covered:incidents.length-missing.length,
    complete:missing.length===0,missing,incidents};
}

// One semantic response per section. Transport/capacity retries belong inside
// observe(); they retry that request, not a new discovery or correction pass.
// Persist the raw successful response BEFORE interpreting it, including empty
// sections, so restart does not silently pay for the same observation again.
export async function observeInitialSections({sections,readCached,observe,save,consume,onProgress=async()=>{}}) {
  const results=[];
  for(const [index,section] of sections.entries()) {
    let draft=await readCached(section,index);
    const restored=draft!==undefined;
    if(!restored) {
      draft=await observe(section,index);
      await save(section,index,draft);
    }
    results.push(await consume(draft,section,index));
    await onProgress({index,section,restored,results});
  }
  return results;
}

// Choose ONE source view per incident before locking. Adjacent section overlap
// is a local duplicate, not grounds for another Gemini request. Reaction support
// is allowed only after its own action, never as substitute goal evidence.
export function selectInitialActionViews(candidates) {
  candidates=linkImmediateGoalReplays(candidates);
  const eligible=candidates.filter(scene=>scene.semanticVerified===true&&scene.actionComplete===true
    &&scene.keepDecision!=='reject'&&scene.sourceSelectionEvidence?.version===INITIAL_SECTION_VERSION);
  const groups=new Map();
  for(const scene of eligible.filter(scene=>scene.eventType!=='celebration'&&scene.storyPhase!=='reaction')) {
    const contact=scene.trackingBrief?.contactTime;
    const duplicate=[...groups.values()].find(group=>group.some(other=>
      other.eventType===scene.eventType && Number.isFinite(contact)
      && Number.isFinite(other.trackingBrief?.contactTime)
      && Math.abs(contact-other.trackingBrief.contactTime)<1
      && Math.min(scene.endTime,other.endTime)>Math.max(scene.startTime,other.startTime)));
    const key=duplicate?.[0]?.storyId||scene.storyId||scene.id;
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(scene);
  }
  const chosen=new Set(),stories=new Map();
  for(const views of groups.values()) {
    const readability=scene=>Number(scene.sourceSelectionEvidence?.observation?.portraitReadability||0);
    views.sort((a,b)=>readability(b)-readability(a)
      ||Number(b.visualClarity||0)-Number(a.visualClarity||0)
      ||Number(b.narrativeCompleteness||0)-Number(a.narrativeCompleteness||0)
      ||Number(Boolean(a.isReplay||a.storyPhase==='replay'))
      -Number(Boolean(b.isReplay||b.storyPhase==='replay'))
      ||a.startTime-b.startTime);
    const primary=views[0];chosen.add(primary.id);
    for(const scene of views) stories.set(scene.id,primary.storyId||primary.id);
  }
  for(const scene of eligible.filter(scene=>scene.eventType==='celebration'||scene.storyPhase==='reaction')) {
    const primary=eligible.find(action=>chosen.has(action.id)&&action.eventType==='goal'
      &&action.storyId===scene.storyId&&scene.startTime>=action.endTime-.1
      &&scene.startTime<=action.endTime+1);
    if(primary&&!eligible.some(other=>chosen.has(other.id)&&other.eventType==='celebration'
      &&other.storyId===scene.storyId)) chosen.add(scene.id);
  }
  return candidates.map(scene=>({...scene,storyId:stories.get(scene.id)||scene.storyId,
    sourceAngleSelected:chosen.has(scene.id),sourceAngleDeferred:!chosen.has(scene.id),
    sourceSupportDeferred:!chosen.has(scene.id),
    chosenIncidentAngle:chosen.has(scene.id)&&['goal','disallowed_goal'].includes(scene.eventType),
  }));
}
