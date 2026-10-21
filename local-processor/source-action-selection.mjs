import {ACTION_GUIDANCE_VERSION,actionGuidanceKey,validateActionGuidance,guidedDetectorScene,matchingActionGuidance} from './action-guidance.mjs';

const nonGoalOutcome={save:'save',wide:'shot_off_target',over:'shot_off_target',blocked:'big_chance',woodwork:'big_chance'};

// A broad section label is a hypothesis, not an immutable match fact. Only an
// authoritative same-source video observation of contact AND resolved result
// can correct it. Missing anchors/occlusion never authorize dropping a goal.
export function verifiedSourceOutcomeCorrection(scene, originalEventType) {
  const correction=scene.sourceOutcomeReconciliation,saved=scene.actionGuidance;
  if(!correction||correction.version!==1||correction.originalEventType!==originalEventType
    ||correction.eventType!==scene.eventType||correction.authoritative!==true
    ||!['goal','disallowed_goal'].includes(originalEventType)
    ||saved?.model!==correction.model||!saved?.sourceFingerprint
    ||JSON.stringify(saved.sourceFingerprint)!==JSON.stringify(correction.sourceFingerprint)) return false;
  const guide=matchingActionGuidance(scene,saved,saved.sourceFingerprint,saved.model);
  return Boolean(guide&&guide.uncertainties.length===0&&nonGoalOutcome[guide.outcome]===scene.eventType
    &&guide.anchors.some(contact=>contact.phase==='contact'&&contact.ball&&contact.player
      &&guide.anchors.some(result=>result.phase==='payoff'&&result.ball&&result.time>contact.time)));
}

// This is a source-selection operation. It must never run on Step 2's locked
// scenes, change an approved camera, or approve a portrait crop.
export function sourceActionGuideWindow(scene,duration) {
  if(scene.selectionLocked) throw new Error('A locked scene cannot return to source selection.');
  return {...scene,startTime:Math.max(0,scene.startTime-1),endTime:Math.min(duration,scene.endTime+2),
    sourceSceneAsset:undefined,actionGuidance:undefined};
}

export function selectGuidedSourceAction(scene,observed,{model,sourceFingerprint,authoritativeOutcome=false}) {
  if(scene.selectionLocked) throw new Error('A locked scene cannot change its source action.');
  const window=observed;
  const guide=validateActionGuidance(window.actionGuidance.guide,window.endTime-window.startTime);
  const reaction=scene.eventType==='celebration'||scene.storyPhase==='reaction';
  if(reaction) return {scene,reason:null};
  // The context window can contain a replay AFTER the resolved action. Its
  // later contact must not erase the already observed finish of the first view.
  const allContacts=guide.anchors.filter(a=>a.phase==='contact'&&a.ball&&a.player);
  const payoff=guide.anchors.find(a=>a.phase==='payoff'&&a.ball
    &&allContacts.some(contact=>contact.time<a.time)
    &&window.startTime+a.time>=scene.startTime);
  const contacts=allContacts.filter(a=>payoff&&a.time<payoff.time);
  const contact=contacts.at(-1);
  const setup=guide.anchors.find(a=>['setup','flight','contact'].includes(a.phase)&&a.ball&&a.player
    &&contact&&a.time<contact.time);
  // A contradictory optional shot may be another angle of an earlier goal.
  // Do not invent a new score incident or silently downgrade an awarded goal.
  const scoringLabel=['goal','disallowed_goal'].includes(scene.eventType);
  const correctScoringLabel=scoringLabel&&Boolean(nonGoalOutcome[guide.outcome])
    &&authoritativeOutcome&&guide.uncertainties.length===0&&contact&&payoff;
  if(scoringLabel&&guide.outcome!=='goal'&&!correctScoringLabel)
    return {scene:null,reason:'source_goal_outcome_unresolved'};
  if(!['goal','disallowed_goal'].includes(scene.eventType)&&guide.outcome==='goal')
    return {scene:null,reason:'optional_action_goal_context_conflict'};
  // A compact guide is deliberately sparse. A missing setup ANCHOR does not
  // negate the initial full-video observation of setup; it still needs direct
  // contact/finish anchors and the independent native/crop check in Step 2.
  const initialSetup=scene.semanticVerified===true&&scene.actionComplete===true
    &&scene.sourceSelectionEvidence?.observation?.initiatorAndBallVisible===true
    &&Number.isFinite(scene.trackingBrief?.originTime)&&contact
    &&scene.trackingBrief.originTime<window.startTime+contact.time;
  if(guide.outcome==='uncertain'||(!setup&&!initialSetup)||!contact||!payoff)
    return {scene:null,reason:'source_action_has_no_observed_complete_phases'};
  // Do not turn six sample timestamps into tightly cropped source boundaries.
  // Preserve the initially observed buildup and follow-through; only extend
  // the end when the original selection actually cut off the observed finish.
  const startTime=scene.startTime;
  const endTime=Math.min(window.endTime,Math.max(scene.endTime,window.startTime+payoff.time+.5));
  if(endTime-startTime<.5) return {scene:null,reason:'source_action_too_short'};
  const outcomeType={save:'save',wide:'shot_off_target',over:'shot_off_target',blocked:'big_chance',
    woodwork:'big_chance',pass:'normal_play',dribble:'dribble',tackle:'tackle'}[guide.outcome]||scene.eventType;
  const shift=window.startTime-startTime;
  const localGuide={...guide,anchors:guide.anchors.filter(a=>(a.time<=payoff.time||a.phase==='reaction')
    &&a.time+shift>=0&&a.time+shift<=endTime-startTime)
    .map(a=>({...a,time:+(a.time+shift).toFixed(6)}))};
  const selected={...scene,startTime,endTime,eventType:outcomeType,sourceSceneAsset:undefined,
    semanticVerified:true,actionComplete:true,ballVisible:true,mainPlayerVisible:true,
    description:[setup?.description||scene.sourceSelectionEvidence?.observation?.setup,
      contact.description,payoff.description].filter(Boolean).join(' '),
    semanticNarrationFacts:[setup?.description||scene.sourceSelectionEvidence?.observation?.setup,
      contact.description,payoff.description].filter(Boolean),
    trackingBrief:{...scene.trackingBrief,originTime:Math.max(startTime,
      setup?window.startTime+setup.time:scene.trackingBrief.originTime),
      contactTime:window.startTime+contact.time,flightStartTime:window.startTime+contacts[0].time,
      payoffStartTime:window.startTime+payoff.time,payoffEndTime:endTime},
    sourceActionGuideVersion:ACTION_GUIDANCE_VERSION};
  if(correctScoringLabel) {
    selected.sourceOutcomeReconciliation={version:1,originalEventType:scene.eventType,eventType:outcomeType,
      authoritative:true,model,sourceFingerprint,sourceStartTime:scene.startTime,sourceEndTime:scene.endTime,
      reason:'Complete source video shows a resolved non-goal action, not the broad section scoring label.'};
    // Remove stale goal/VAR facts, net rectangles and "NO GOAL" captions.
    // Otherwise the writer/overlay could still repeat the corrected mistake.
    selected.analysisPurpose=`Explain the observed ${guide.outcome} action and its resolved result.`;
    selected.onScreenText=undefined;
    selected.completionReason=payoff.description;
    selected.trackingBrief={...selected.trackingBrief,payoffEvidence:null,goalFocusX:null};
    const evidence=scene.sourceSelectionEvidence;
    if(evidence) selected.sourceSelectionEvidence={...evidence,originalObservation:evidence.observation,
      observation:{...evidence.observation,setup:setup?.description||evidence.observation?.setup,
        continuation:contact.description,result:payoff.description,outcome:outcomeType}};
  }
  selected.actionGuidance={version:ACTION_GUIDANCE_VERSION,model,sourceFingerprint,
    key:actionGuidanceKey(selected,sourceFingerprint,model),sourceStartTime:startTime,sourceEndTime:endTime,
    observationWindow:{startTime:window.startTime,endTime:window.endTime},guide:localGuide};
  return {scene:guidedDetectorScene(selected,localGuide),reason:null};
}
