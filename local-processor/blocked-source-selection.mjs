import {ACTION_GUIDANCE_SCHEMA,validateActionGuidance} from './action-guidance.mjs';
import {footballVideoPart} from './gemini-media-policy.mjs';
import {selectGuidedSourceAction} from './source-action-selection.mjs';
import {semanticSignature} from './pipeline-state.mjs';

export const BLOCKED_SELECTION_VERSION=7;
export const SOURCE_RESELECTION_FPS=8;

export function blockedSelectionScenes(candidates,tracking) {
  return candidates.filter(scene=>scene.selectionLocked===true).filter(scene=>{
    const evidence=tracking?.moments?.[scene.id];
    return evidence?.finalCropVerified!==true || evidence.geometryVerified!==true
      || evidence.sourceStartTime!==scene.startTime || evidence.sourceEndTime!==scene.endTime;
  });
}

export function blockedSelectionWindow(scene,shots,duration) {
  const incidentStart=scene.sourceReselection?.previousStart??scene.startTime;
  const incidentEnd=scene.sourceReselection?.previousEnd??scene.endTime;
  const touching=shots.filter(shot=>shot.endTime>incidentStart&&shot.startTime<incidentEnd);
  if(!touching.length) throw new Error('Source reselection requires measured camera-shot boundaries.');
  const startTime=Math.max(0,Math.min(incidentStart-2,touching[0].startTime));
  // A live goal can be crowded while its immediate broadcast replay shows the
  // decisive touch. Keep that adjacent replay available for the same incident.
  // Broadcasts often show two or three immediate angles before returning to
  // live play. Keep the last full goal replay available to compare.
  const endTime=Math.min(duration,Math.max(incidentEnd+(scene.eventType==='goal'?30:2),touching.at(-1).endTime));
  return {startTime,endTime,shots:shots.filter(shot=>shot.endTime>startTime&&shot.startTime<endTime)
    .map(shot=>({startTime:Math.max(startTime,shot.startTime)-startTime,
      endTime:Math.min(endTime,shot.endTime)-startTime}))};
}

export function blockedSelectionRequest(model,data,scene,window,previousFailure='') {
  return {model,contents:[footballVideoPart(data,SOURCE_RESELECTION_FPS),{text:
    `Choose ONE clear complete action from this original ${ (window.endTime-window.startTime).toFixed(3)}s source video. This is an explicitly authorized Step 1 source reselection, NOT a crop verification. The existing selection was source-local ${(scene.startTime-window.startTime).toFixed(3)} to ${(scene.endTime-window.startTime).toFixed(3)} seconds. It is ${scene.eventType==='goal'?'a selected scoring incident':'an unverified action with no reliable outcome label'}; determine the actual action from moving video pixels. Preserve that SAME incident, never replace a goal with an unrelated chance or celebration. All times must be seconds on the burned SCENE clock (input source-local seconds). Measured camera shots: ${JSON.stringify(window.shots)}.
Compare the live view and each immediate replay for four independently visible phases: setup BEFORE the decisive touch with both actor and ball, actual ball contact, the same ball in flight, and resolved payoff. Choose the clearest COMPLETE single camera view, preferring live when equally complete. For a GOAL ONLY, if no complete live view exists, you may choose one immediate broadcast replay only when you can verify from moving ball, players and sequence that it is the SAME goal; set selectedReplay and sameIncidentVerified true. The replay must itself show the eventual scorer and incoming match ball BEFORE decisive contact, contact, flight and goal-line payoff. A tight goalmouth view can omit the original corner taker but must show the eventual scorer and incoming ball before the header. A claimed goal needs the ball visibly inside the posts after contact; a cut to a reaction is not payoff. For a long corner-and-second-shot sequence, choose the complete second shot from its own setup through payoff. A keeper collecting a through pass is not a save unless a separate visible shot contact occurs before the collection; label the actual observed pass, tackle or reception. Do not join phases from different camera angles, unrelated reactions, or another incident. Do not make a vertical crop or invent coordinates; this selects original-ratio footage only. A later dense tracker and independent rendered crop review still verify geometry. ${previousFailure?`A previous choice at source ${scene.startTime.toFixed(3)}-${scene.endTime.toFixed(3)}s FAILED independent verification (${previousFailure}). Choose a different camera view or a materially wider interval with newly visible phases; never return the same interval on this repair.`:''}
Return selectionStart, selectionEnd, selectionReason, selectedReplay, sameIncidentVerified, and guide. Include at most six directly observed full-frame semantic anchors WITHIN the chosen interval, but timestamps must remain on the input SCENE clock (not rebased). The guide MUST include an observed setup anchor BEFORE the decisive contact, with BOTH initiating player and match ball visible. An incoming cross approaching a header is setup for that header: identify the jumping player before the touch. Then include that decisive contact, ball flight, and its IMMEDIATE resolved outcome (goalkeeper touch, ball off post, ball wide, goal, block, or controlled reception). Stop after that payoff; do NOT wait through a later scramble or whistle to decide the original shot outcome. Do not label a saved shot as 'reaction' merely because players react later. For multiple consecutive attempts, choose ONE complete decisive attempt rather than inventing one contact from a header and another result from a later volley. Ball and player boxes are normalized [ymin,xmin,ymax,xmax] 0..1000, null if hidden. Do not confuse white boots or spare balls with the moving match ball. A contact actor must actually touch/control this ball. Use the observed sporting outcome, not the provisional label. A real goal must include visible crossing inside the posts; do not downgrade a goal because framing is hard. If no complete view exists, return null selection bounds and honestly explain why. Never certify a crop here.`}],
    config:{responseMimeType:'application/json',responseJsonSchema:{type:'object',
      required:['selectionStart','selectionEnd','selectionReason','selectedReplay','sameIncidentVerified','guide'],properties:{
        selectionStart:{type:['number','null']},selectionEnd:{type:['number','null']},
        selectionReason:{type:'string'},selectedReplay:{type:'boolean'},sameIncidentVerified:{type:'boolean'},guide:ACTION_GUIDANCE_SCHEMA}},
      temperature:0,maxOutputTokens:8192,thinkingConfig:{thinkingLevel:'LOW'}}};
}

export function applyBlockedSelection(scene,window,value,context) {
  const duration=window.endTime-window.startTime;
  const start=value?.selectionStart,end=value?.selectionEnd;
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>duration+.001||end-start<.5
    ||typeof value.selectionReason!=='string'||value.selectionReason.trim().length<10)
    throw new Error('The source observer did not select a complete replacement action.');
  const guide=validateActionGuidance(value.guide,duration);
  const anchors=guide.anchors.filter(a=>a.time>=start&&a.time<=end);
  const contacts=anchors.filter(a=>a.phase==='contact'&&a.ball&&a.player);
  const payoff=anchors.find(a=>a.phase==='payoff'&&a.ball&&contacts.some(c=>c.time<a.time));
  const contact=contacts.filter(a=>payoff&&a.time<payoff.time).at(-1);
  const setup=anchors.find(a=>['setup','contact','flight'].includes(a.phase)
    &&a.ball&&a.player&&contact&&a.time<contact.time);
  if(!setup||!contact||!payoff||guide.uncertainties.length)
    throw new Error('Replacement source selection lacks observed setup, contact or resolved payoff.');
  if(guide.outcome==='save'&&/\b(?:pass(?:es|ed)?|cross(?:es|ed)?|through.ball)\b/i.test(contact.description)
    && !/\b(?:shoots?|shot|strik(?:e|es|ing)|header|heads?|volley)\b/i.test(contact.description)) {
    const error=new Error('The guide labels a pass or cross collected by the keeper as a shot save without a visible shot contact.');
    error.code='ACTION_GUIDE_OUTCOME';
    throw error;
  }
  if(scene.eventType==='goal'&&guide.outcome!=='goal')
    throw new Error('An awarded goal cannot be replaced with a non-goal action.');
  const absoluteStart=+(window.startTime+start).toFixed(6);
  // Stop once this chosen action resolves; a later scramble/second attempt
  // is not padding for the first shot. Reactions have their own saved scenes.
  const selectedEnd=Math.min(end,payoff.time+(guide.outcome==='goal'?1.25:.75));
  const absoluteEnd=+(window.startTime+selectedEnd).toFixed(6);
  const replay=value.selectedReplay===true;
  if(scene.sourceReselection) {
    const leadGain=scene.startTime-absoluteStart;
    const payoffGain=absoluteEnd-scene.endTime;
    const overlap=Math.max(0,Math.min(absoluteEnd,scene.endTime)-Math.max(absoluteStart,scene.startTime));
    const overlapFraction=overlap/Math.min(absoluteEnd-absoluteStart,scene.endTime-scene.startTime);
    if(overlapFraction>.65 && (Math.max(leadGain,payoffGain)<.75 || leadGain+payoffGain<1)) {
      const error=new Error('The replacement repeats the independently rejected camera angle without enough new setup or payoff footage.');
      error.code='SOURCE_ANGLE_UNCHANGED';
      throw error;
    }
  }
  const incidentStart=scene.sourceReselection?.previousStart??scene.startTime;
  const incidentEnd=scene.sourceReselection?.previousEnd??scene.endTime;
  if(replay && (scene.eventType!=='goal'||value.sameIncidentVerified!==true
    ||absoluteStart<incidentEnd||absoluteStart>incidentEnd+30))
    throw new Error('A replay must independently match the selected goal immediately after its live view.');
  // Live replacement must overlap the original incident, never a nearby play.
  if(!replay&&(absoluteEnd<=incidentStart
    ||absoluteStart>=incidentEnd))
    throw new Error('Replacement source action does not overlap the selected incident.');
  const unlocked={...scene,startTime:absoluteStart,endTime:absoluteEnd,
    isReplay:replay,storyPhase:replay?'replay':scene.storyPhase,
    selectionLocked:false,sceneSelectionApproved:false,trackingBrief:{},actionGuidance:undefined,
    sourceSceneAsset:undefined,portraitSceneAsset:undefined,selectedForFinalVideo:false};
  const observed={...unlocked,startTime:window.startTime,endTime:absoluteEnd,
    actionGuidance:{guide:{...guide,anchors:anchors.filter(a=>a.time<=selectedEnd)}}};
  const decision=selectGuidedSourceAction(unlocked,observed,{...context,authoritativeOutcome:true});
  if(!decision.scene) throw new Error(`Replacement source action is unresolved: ${decision.reason}`);
  const selected={...decision.scene,selectionLocked:true,sceneSelectionApproved:true,
    sourceAngleSelected:true,sourceAngleDeferred:false,keepDecision:'keep',
    sourceReselection:{version:BLOCKED_SELECTION_VERSION,previousStart:incidentStart,
      previousEnd:incidentEnd,selectedReplay:replay,reason:value.selectionReason,approvedCropPreserved:false},
    finalCropVerified:undefined,trackingRepairError:undefined};
  selected.semanticSignature=semanticSignature(selected);
  return selected;
}

export function mergeBlockedSelections(candidates,replacements) {
  const byId=new Map(replacements.map(scene=>[scene.id,scene]));
  for(const replacement of replacements) {
    const previous=candidates.find(scene=>scene.id===replacement.id&&scene.selectionLocked===true);
    if(!previous||previous.storyId!==replacement.storyId)
      throw new Error('Source reselection must preserve exact scene and incident identities.');
    if(previous.eventType==='goal'&&replacement.eventType!=='goal')
      throw new Error('Source reselection cannot omit an awarded goal.');
  }
  return candidates.map(scene=>byId.get(scene.id)||scene);
}
