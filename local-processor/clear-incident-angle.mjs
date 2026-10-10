import {verifiedRecapBuildUp} from './recap-action-inventory.mjs';
import {bindSourceScoreCandidates} from './source-score-ledger.mjs';
import { LIVE_FIRST_SELECTION_POLICY } from './fixed-scene-queue.mjs';
const actionEvents = new Set(['goal','disallowed_goal','save','shot_on_target','shot_off_target','big_chance','tackle','free_kick','normal_play','assist','dribble']);
export const CLEAR_ANGLE_WORKFLOW_VERSION = 12;
const reaction = scene => scene.storyPhase === 'reaction' || ['celebration','var','offside'].includes(scene.eventType);

export function sourceCameraSegments(scene, shots = []) {
  const start = Number(scene.startTime), end = Number(scene.endTime);
  return shots.filter(shot => Number(shot.endTime) > start + .03 && Number(shot.startTime) < end - .03)
    .map(shot => ({id: shot.id || shot.shotId, startTime: Math.max(start, Number(shot.startTime)),
      endTime: Math.min(end, Number(shot.endTime))}));
}

// A coarse discovery timestamp can land in a replay or reaction rather than
// the live finish. Inspect measured source shots around the score transition
// BEFORE locking scenes. These are neutral observation proposals, not proof
// that a goal exists: the independent semantic/outcome gates still decide it.
export function sourceScoreShotProposals(anchors, shots = [], candidates = []) {
  const ids = new Set(candidates.map(scene => scene.id));
  return anchors.flatMap(anchor => shots.filter(shot =>
    Number.isFinite(shot.startTime) && Number.isFinite(shot.endTime)
    && shot.endTime - shot.startTime >= 2.5 && shot.endTime - shot.startTime <= 45
    && shot.endTime > anchor.startTime && shot.startTime < anchor.after.time
  ).map(shot => {
    const id = `score-shot-${anchor.id}-${Math.round(shot.startTime*1000)}-${Math.round(shot.endTime*1000)}`;
    return {id, startTime:shot.startTime, endTime:shot.endTime,
      eventType:anchor.status==='reversed'?'disallowed_goal':'goal',
      storyId:anchor.id, sourceScoreAnchorId:anchor.id, sourceScoreObservation:true,
      sourceScoreShotProposalVersion:1, sourceViewSplit:true,
      sourceCameraBoundary:{startTime:shot.startTime,endTime:shot.endTime},
      storyPhase:'action', keepDecision:'keep', actionComplete:true,
      completionReason:'Unverified source-camera proposal; independent pixels must establish completion.',
      description:'Unverified camera shot near a source score transition.',
      ballVisible:true, mainPlayerVisible:true, isReplay:false,
      importanceScore:90, confidence:.5, trackingBrief:null,
      semanticVerified:undefined, selectedForFinalVideo:false};
  }).filter(scene => !ids.has(scene.id)));
}

export function trimCompleteCameraView(scene) {
  if (!scene.sourceViewSplit || scene.semanticVerified !== true || scene.actionComplete !== true) return scene;
  const payoff = scene.trackingBrief?.payoffEvidence;
  const contact = Number(scene.trackingBrief?.contactTime), resultEnd = Number(scene.trackingBrief?.payoffEndTime);
  if (payoff?.verified !== true || !Number.isFinite(contact) || !Number.isFinite(resultEnd)
    || resultEnd <= contact || resultEnd > scene.endTime) return scene;
  const end = Math.min(scene.endTime, Math.max(resultEnd,Number(payoff.endTime)||resultEnd)+.5);
  if (scene.endTime-end < .15 || end-scene.startTime < 2.5) return scene;
  return {...scene,endTime:+end.toFixed(3),
    sourceCameraBoundary:{startTime:scene.startTime,endTime:+end.toFixed(3)},
    sourceCameraSegments:(scene.sourceCameraSegments||[]).map(segment=>({...segment,endTime:Math.min(segment.endTime,end)})),
    selectedForFinalVideo:false,trackingDecision:undefined,trackingPassed:undefined};
}

export function splitIncidentCameraViews(candidates, shots = []) {
  const existingIds = new Set(candidates.map(scene => scene.id));
  return candidates.flatMap(scene => {
    const segments = sourceCameraSegments(scene,shots);
    if (!(scene.sourceScoreObservation||scene.sourceAdditionalAction) || !actionEvents.has(scene.eventType) || segments.length < 2
      || scene.sourceViewSplit === true) return [scene];
    const views = segments.filter(segment => segment.endTime-segment.startTime >= 2.5)
      .map((segment,index) => ({...scene,id:`${scene.id}-shot-${index+1}`,
        startTime:segment.startTime,endTime:segment.endTime,sourceViewSplit:true,
        parentSourceCandidateId:scene.id,sourceCameraSegments:[segment],
        sourceCameraBoundary:{startTime:segment.startTime,endTime:segment.endTime},boundaryCorrection:undefined,
        // The old cross-shot clock cannot describe an atomic camera view.
        // These are candidates, NOT approvals: observe the new short view.
        trackingBrief:null,keyActionTimes:[],recommendedCrop:[],
        semanticVerified:undefined,semanticSignature:undefined,semanticVerificationVersion:undefined,
        semanticGeometryVersion:undefined,goalOutcomeCrosscheck:undefined,
        trackingDecision:undefined,trackingPassed:undefined,selectionLocked:false,
        keepDecision:scene.isReplay?'replay':'keep',selectedForFinalVideo:false}));
    // Preserve the complete multi-shot sequence only as a last alternative
    // when no single camera view contains the complete action.
    return [...views.filter(view => !existingIds.has(view.id)),scene];
  });
}

// Choose before geometry work. Prefer the first independently complete live
// view. Use a verified replay only when no complete live view is available.
export function selectClearIncidentAngles(candidates, shots = [], scoreLedger = null) {
  // A Step-1 ranking is not a pixel rejection. Reconsider saved, complete
  // alternatives when the previously preferred draft changes its outcome.
  // Never reopen a semantic failure or change an already locked scene.
  candidates=candidates.map(scene=>scene.selectionLocked!==true
    && scene.selectionDecision==='removed_duplicate_incident_view'
    && scene.semanticVerified===true && scene.actionComplete===true
    ? {...scene,keepDecision:scene.isReplay?'replay':'keep',rejectReason:undefined,
      selectionDecision:undefined,sourceAngleDeferred:false} : scene);
  const groups = new Map();
  const annotated = splitIncidentCameraViews(bindSourceScoreCandidates(candidates,scoreLedger),shots).map(scene => ({...scene,
    sourceIncidentOptional: scene.sourceScoreObservation === true
      && scoreLedger?.anchors?.some(anchor => anchor.id === scene.sourceScoreAnchorId && anchor.status === 'reversed') === true,
    sourceCameraSegments: sourceCameraSegments(scene, shots)}));
  for (const scene of annotated) {
    const anchored=scene.sourceScoreObservation || scene.sourceScoreBindingVersion && scene.sourceScoreAnchorId;
    if (!(anchored||scene.sourceAdditionalAction) || scene.sourceIncidentOptional
      || !(actionEvents.has(scene.eventType)||verifiedRecapBuildUp(scene))
      || (anchored && !['goal','disallowed_goal'].includes(scene.eventType))
      || (scene.sourceAdditionalAction && !scene.sourceScoreObservation && ['goal','disallowed_goal'].includes(scene.eventType))
      || scene.actionComplete !== true || scene.semanticVerified === false || scene.keepDecision === 'reject') continue;
    const story = String(scene.sourceScoreAnchorId || scene.storyId || scene.id);
    if (!groups.has(story)) groups.set(story, []);
    groups.get(story).push(scene);
  }
  const primary = new Set();
  const ranks = new Map();
  for (const angles of groups.values()) {
    // Prefer a complete single-camera LIVE view, then the earliest such view.
    // A longer parent spanning setup/reaction cuts is only needed when no
    // independently complete atomic view exists. Replays stay behind live.
    angles.sort((a,b) => Number(b.semanticVerified === true) - Number(a.semanticVerified === true)
      || Number(Boolean(a.isReplay || a.storyPhase==='replay')) - Number(Boolean(b.isReplay || b.storyPhase==='replay'))
      || Math.max(1,a.sourceCameraSegments.length) - Math.max(1,b.sourceCameraSegments.length)
      || Number(a.startTime) - Number(b.startTime)
      || Number(b.visualClarity || 0) - Number(a.visualClarity || 0)
      || Number(b.confidence || 0) - Number(a.confidence || 0));
    primary.add(angles[0].id);
    angles.forEach((scene,index) => ranks.set(scene.id,index+1));
  }
  return annotated.map(scene => {
    const immediateGoalReaction = scene.eventType === 'celebration'
      && !scene.isReplay && annotated.some(action => primary.has(action.id)
        && action.eventType === 'goal' && action.semanticVerified === true
        && action.actionComplete === true && action.keepDecision !== 'reject'
        && !action.isReplay && action.storyPhase !== 'replay'
        && String(action.storyId || action.id) === String(scene.storyId || scene.id)
        && scene.startTime >= action.endTime - .3 && scene.startTime <= action.endTime + .75
        && scene.endTime - scene.startTime <= 5);
    if (!(scene.sourceScoreObservation||scene.sourceAdditionalAction
      ||scene.sourceScoreBindingVersion&&scene.sourceScoreAnchorId)) {
      // Unrelated full-time/statistics reactions are not a new football action
      // for duration recovery. They remain in the observed source inventory.
      if(reaction(scene) && !scene.selectionLocked && !annotated.some(action=>
        ['goal','disallowed_goal'].includes(action.eventType) && action.actionComplete===true
        && action.semanticVerified!==false && action.keepDecision!=='reject'
        && String(action.storyId||action.id)===String(scene.storyId||scene.id)))
        return {...scene,sourceSupportDeferred:true};
      return immediateGoalReaction ? {...scene,sourceSupportDeferred:false} : scene;
    }
    const selected = primary.has(scene.id);
    return {...scene, sourceAngleSelected: selected,
      sourceAngleSelectionPolicy: LIVE_FIRST_SELECTION_POLICY,
      sourceAngleReserved: false,
      sourceAngleRank: ranks.get(scene.id),
      sourceAngleDeferred: !reaction(scene) && !selected,
      // Decisions/reactions are optional support, not another required action
      // angle. Inspect them only when needed for a narration fact.
      sourceSupportDeferred: reaction(scene) && !immediateGoalReaction,
    };
  });
}
