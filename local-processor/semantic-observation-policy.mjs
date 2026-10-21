// Deliberately exclude the director's event, description, names and timing
// hypotheses from the independent visual verifier.
import {outcomeObservationSchema} from './goal-outcome-detail.mjs';

// Source-native end witnesses disambiguate a completed play from a pass that
// merely approaches a receiver before the broadcast cuts. These are evidence
// images for the observer, never invented completion/coordinate approvals.
export function sourceCompletionDetailTimes(window) {
  const start=Number(window?.start),end=Number(window?.end);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start) return [];
  return [...new Set([1,.5,.25,.04].map(offset=>+Math.max(start,end-offset).toFixed(4)))];
}
export function missingSemanticReviewIds(expectedIds, response) {
  const returned = new Map();
  for(const item of Array.isArray(response?.candidates)?response.candidates:[]) {
    if(item && typeof item.id==='string') returned.set(item.id,[...(returned.get(item.id)||[]),item]);
  }
  return expectedIds.filter(id => {
    const items=returned.get(id)||[],item=items[0];
    return items.length!==1 || typeof item.semanticMatch !== "boolean" || typeof item.actionComplete !== "boolean";
  });
}

export function semanticReviewSchema(ids) {
  const number = { type: 'number' }, text = { type: 'string' };
  const payoff = { type: ['object','null'], properties: {
    verified: { type: 'boolean' }, eventType: text, startTime: number, endTime: number,
    targetBox: { type: 'array', items: number, minItems: 4, maxItems: 4 },
  } };
  return { type: 'object', required: ['candidates'], properties: {
    // Fixed candidate-array bounds make this deeply nested schema fail Vertex
    // validation. Four candidates reproduce 400 even WITHOUT media.
    // Retain strict fields/ID enums; enforce exact count and unique IDs locally.
    candidates: { type: 'array', items: {
      type: 'object', required: ['id','semanticMatch','actionComplete','correctedEventType','correctedDescription','isReplay','narrationFacts','reason','trackingBrief','outcomeReview','sourceActionWindow'],
      properties: {
        id: { type: 'string', enum: ids }, semanticMatch: { type: 'boolean' }, actionComplete: { type: 'boolean' },
        correctedEventType: text, correctedDescription: text, isReplay: { type: 'boolean' },
        narrationFacts: { type: 'array', items: text }, reason: text, payoffEvidence: payoff,
        outcomeReview:{...outcomeObservationSchema(),type:['object','null']},
        sourceActionWindow:{type:['object','null'],required:['startTime','endTime','setupVisible','contactVisible','payoffVisible','cleanSourceBoundaries','reason'],
          properties:{startTime:number,endTime:number,setupVisible:{type:'boolean'},contactVisible:{type:'boolean'},
            payoffVisible:{type:'boolean'},cleanSourceBoundaries:{type:'boolean'},reason:text}},
        trackingBrief: { type: ['object','null'], properties: {
          primaryPlayerRole: text, attackDirection: text, cameraMode: text, payoffTarget: text,
          originTime: number, contactTime: number, flightStartTime: number, handoffTime: number,
          payoffStartTime: number, payoffEndTime: number, goalFocusX: {type:['number','null']},
          annotationStartTime: number, annotationEndTime: number, payoffEvidence: payoff,
          requiredSubjectsByPhase: { type: 'array', items: { type: 'object', required: ['phase','subjects'],
            properties: { phase: text, subjects: { type: 'array', items: text } } } },
        } },
      },
    } },
  } };
}

// Only Step 1 may refine a scene's source bounds. The observer supplies an
// explicit complete interval, rather than the application adding a fixed
// pre-roll/result tail that can accidentally include a different incident.
export function applyReviewedSourceActionWindow(moment,review,window) {
  review=correctSemanticResultHold(review);
  if(moment.selectionLocked===true||review?.semanticMatch!==true||review.actionComplete!==true
    ||['celebration','var','offside'].includes(review.correctedEventType)) return moment;
  const proof=review.sourceActionWindow;
  if(!proof||['setupVisible','contactVisible','payoffVisible','cleanSourceBoundaries'].some(key=>proof[key]!==true)
    ||!Number.isFinite(proof.startTime)||!Number.isFinite(proof.endTime)
    ||typeof proof.reason!=='string'||proof.reason.trim().length<12) return null;
  const sourceStart=Number(window.start),sourceEnd=Number(window.end);
  const start=sourceStart+proof.startTime,end=sourceStart+proof.endTime;
  const contact=review.trackingBrief?.contactTime,payoffStart=review.trackingBrief?.payoffStartTime;
  const payoffEnd=review.trackingBrief?.payoffEndTime;
  const evidence=review.payoffEvidence??review.trackingBrief?.payoffEvidence;
  if(![sourceStart,sourceEnd,start,end,contact,payoffStart,payoffEnd].every(Number.isFinite)
    ||proof.startTime<0||end>sourceEnd+.001||end<=start+.1
    ||contact<proof.startTime||payoffStart<contact||payoffStart>=proof.endTime
    ||payoffEnd<=payoffStart||payoffEnd>proof.endTime+.001
    ||evidence && (evidence.verified!==true||!Number.isFinite(evidence.startTime)||!Number.isFinite(evidence.endTime)
      ||evidence.startTime<payoffStart-.001||evidence.endTime>proof.endTime+.001
      ||evidence.endTime<=evidence.startTime)) return null;
  return {...moment,startTime:+start.toFixed(4),endTime:+end.toFixed(4),
    verifiedSourceActionWindow:{...proof,reviewSourceStartTime:sourceStart,reviewSourceEndTime:sourceEnd,
      startTime:+start.toFixed(4),endTime:+end.toFixed(4)},
    boundaryCorrection:{...(moment.boundaryCorrection||{}),
      originalStartTime:moment.boundaryCorrection?.originalStartTime??moment.startTime,
      originalEndTime:moment.boundaryCorrection?.originalEndTime??moment.endTime,
      reason:'independently_observed_complete_source_window'}};
}

export function conflictingSourceActionWindowIds(response) {
  return (response?.candidates||[]).filter(review=>review.semanticMatch===true&&review.actionComplete===true
    &&!['celebration','var','offside'].includes(review.correctedEventType)
    &&(!review.sourceActionWindow||['setupVisible','contactVisible','payoffVisible','cleanSourceBoundaries']
      .some(key=>review.sourceActionWindow[key]!==true))).map(review=>String(review.id));
}

export function mergeMissingSemanticReview(saved, correction, requestedId) {
  const original=Array.isArray(saved?.candidates)?saved.candidates:[];
  const matches=(Array.isArray(correction?.candidates)?correction.candidates:[])
    .filter(item=>item?.id===requestedId);
  if(matches.length!==1 || typeof matches[0].semanticMatch!=='boolean'
    || typeof matches[0].actionComplete!=='boolean') return {candidates:[...original]};
  let replaced=false;
  const candidates=original.flatMap(item=>{
    if(item?.id!==requestedId)return [item];
    if(replaced)return [];replaced=true;return [matches[0]];
  });
  if(!replaced)candidates.push(matches[0]);
  return {candidates};
}

export function correctSemanticReelClock(review, clip) {
  const offset = Number(clip?.reelStartTime), duration = Number(clip?.reelEndTime) - offset;
  const brief = review?.trackingBrief;
  if (!(offset > 0) || !(duration > 0) || !brief) return correctSemanticResultHold(review);
  const timeKeys = ['originTime','contactTime','flightStartTime','handoffTime','payoffStartTime','payoffEndTime','annotationStartTime','annotationEndTime'];
  const times = timeKeys.map(key => brief[key]).filter(Number.isFinite);
  // Convert only when the observed numbers prove the wrong clock. Meaningful
  // setup may begin AFTER the reel boundary, so equality to it is not required.
  // Every time must fit this clip on the reel and at least two must exceed its
  // local duration; mixed clocks and ambiguous valid local times stay untouched.
  const fitsReel = times.every(time => time >= offset - .02 && time <= offset + duration + .05);
  const outsideLocal = times.filter(time => time > duration + .05).length;
  const startsAtReelBoundary = Math.abs(Number(brief.originTime) - offset) <= .02;
  if (!fitsReel || !(outsideLocal >= 2 || startsAtReelBoundary && outsideLocal >= 1)) return correctSemanticResultHold(review);
  const shift = value => Number.isFinite(value) ? value - offset : value;
  const payoff = value => value && typeof value === 'object'
    ? {...value,startTime:shift(value.startTime),endTime:shift(value.endTime)} : value;
  const corrected = {...brief};
  for (const key of timeKeys) {
    if (Number.isFinite(brief[key])) corrected[key] = shift(brief[key]);
  }
  corrected.payoffEvidence = payoff(brief.payoffEvidence);
  return correctSemanticResultHold({...review,trackingBrief:corrected,payoffEvidence:payoff(review.payoffEvidence),
    sourceActionWindow:payoff(review.sourceActionWindow),timingCorrection:'observed_reel_clock_to_clip_clock'});
}

// The observer may end its general phase hold one sampled frame after its
// explicitly verified result. Use that result's own end, not an invented
// ending, only when the full positive evidence already fits the exact window.
// This never moves scene bounds, contacts, ball flight or visibility flags.
export function correctSemanticResultHold(review) {
  const window=review?.sourceActionWindow,brief=review?.trackingBrief;
  const result=review?.payoffEvidence??brief?.payoffEvidence;
  if(review?.semanticMatch!==true||review.actionComplete!==true||!window||!brief||!result
    ||['setupVisible','contactVisible','payoffVisible','cleanSourceBoundaries'].some(key=>window[key]!==true)
    ||result.verified!==true||result.eventType!==review.correctedEventType
    ||![window.startTime,window.endTime,brief.contactTime,brief.payoffStartTime,brief.payoffEndTime,
      result.startTime,result.endTime].every(Number.isFinite)
    ||!Array.isArray(result.targetBox)||result.targetBox.length!==4
    ||result.targetBox.some(value=>!Number.isFinite(value)||value<0||value>1)
    ||result.targetBox[0]>=result.targetBox[2]||result.targetBox[1]>=result.targetBox[3]) return review;
  const oneObservedFrame=1/8; // All gameplay source reviews are sampled at 8 fps.
  if(brief.payoffEndTime<=window.endTime||brief.payoffEndTime-window.endTime>oneObservedFrame+.001
    ||brief.contactTime<window.startTime||brief.payoffStartTime<brief.contactTime
    ||result.startTime<brief.payoffStartTime||result.endTime<=result.startTime
    ||result.endTime>window.endTime||window.endTime-result.endTime>oneObservedFrame+.001) return review;
  return {...review,trackingBrief:{...brief,payoffEndTime:result.endTime},
    timingCorrection:review.timingCorrection||'observed_result_hold_to_complete_window',
    resultHoldCorrection:{originalEndTime:brief.payoffEndTime,observedEndTime:result.endTime,
      reason:'explicit_verified_result_inside_complete_window'}};
}

// A model clock outside its supplied clip is not a camera instruction. Never
// silently clamp every phase to the scene end; request that scene alone.
export function invalidSemanticTimingIds(response, clips) {
  const actions = new Set(['goal','disallowed_goal','save','shot_on_target','shot_off_target','big_chance','assist',
    'free_kick','skill','dribble','tackle','foul','normal_play']);
  return (response?.candidates || []).filter(review => {
    if (review.semanticMatch !== true || review.actionComplete !== true || !actions.has(review.correctedEventType)) return false;
    const clip=clips.find(item=>item.id===String(review.id));
    if (!clip) return true;
    const duration=clip.reelEndTime-clip.reelStartTime;
    const corrected=correctSemanticReelClock(review,clip),brief=corrected.trackingBrief;
    if (!brief) return true;
    const required=['originTime','contactTime','payoffStartTime','payoffEndTime'];
    if (required.some(key=>!Number.isFinite(brief[key]))) return true;
    const times=Object.entries(brief).filter(([key])=>/Time$/.test(key)).map(([,value])=>value);
    const sourceWindow=corrected.sourceActionWindow;
    return sourceWindow!=null && (!Number.isFinite(sourceWindow.startTime)||!Number.isFinite(sourceWindow.endTime)
      ||sourceWindow.startTime<0||sourceWindow.endTime>duration+.001||sourceWindow.endTime<=sourceWindow.startTime)
      ||times.some(time=>!Number.isFinite(time)||time<-.05||time>duration+.05)
      || brief.contactTime<brief.originTime-.05
      || brief.payoffStartTime<brief.contactTime-.125
      || brief.payoffEndTime<=brief.payoffStartTime
      || brief.payoffEndTime<=brief.contactTime+.05
      ||sourceWindow && (brief.contactTime<sourceWindow.startTime-.001
        ||brief.payoffStartTime>=sourceWindow.endTime
        ||brief.payoffEndTime>sourceWindow.endTime+.001);
  }).map(review=>String(review.id));
}

export function semanticClipManifest(candidates, windows) {
  let cursor = 0;
  return candidates.map((candidate, index) => {
    const window = windows[index];
    const duration = Number(window.end) - Number(window.start);
    const clip = { id: String(candidate.id), reelStartTime: +cursor.toFixed(3),
      reelEndTime: +(cursor + duration).toFixed(3),
      sourceStartTime: +Number(window.start).toFixed(3), sourceEndTime: +Number(window.end).toFixed(3) };
    cursor += duration;
    return clip;
  });
}

export function semanticReviewInputArgs(sourcePath, windows) {
  return windows.flatMap(window => ["-ss", Number(window.start).toFixed(3),
    "-t", (Number(window.end) - Number(window.start)).toFixed(3), "-threads", "2", "-i", sourcePath]);
}

// Score-anchored actions are independent incidents. Repeated long reaction
// windows in a concatenated reel can transfer a neighbour's result and phases.
export function semanticReviewBatches(candidates) {
  const batches = [];
  let batch = [], seconds = 0;
  const flush = () => { if (batch.length) batches.push(batch); batch = []; seconds = 0; };
  for (const moment of candidates) {
      if (moment.sourceScoreObservation || moment.sourceAdditionalAction
        || ['goal','disallowed_goal','save','shot_on_target','shot_off_target','big_chance'].includes(moment.eventType)) {
      flush(); batches.push([moment.id]); continue;
    }
    const duration = Math.max(.5, Number(moment.endTime) - Number(moment.startTime));
    if (batch.length && (seconds + duration > 45 || batch.length >= 4)) flush();
    batch.push(moment.id); seconds += duration;
  }
  flush();
  return batches;
}

export function semanticReviewWindow(moment, candidates, sourceDuration) {
  if (moment.sourceViewSplit === true || moment.selectionLocked === true) return {start:moment.startTime,end:moment.endTime};
  if (['assist','skill','dribble','tackle','free_kick','normal_play'].includes(moment.eventType)) {
    // Review context is NOT selected footage. Observe a bounded result tail
    // so Step 1 can end at real control instead of declaring flight complete.
    return {start:moment.startTime,end:Math.min(sourceDuration,moment.endTime+2)};
  }
  if (!['goal','disallowed_goal'].includes(moment.eventType) || moment.isReplay || moment.storyPhase === 'replay') {
    return {start: moment.startTime, end: moment.endTime};
  }
  if (moment.sourceScoreObservation) {
    // Observe the complete proposed live action plus a bounded result handle.
    // The independent score ledger supplies decision context separately; a
    // 20-second celebration is not additional contact/ball-flight evidence.
    return {start: moment.startTime, end: Math.min(sourceDuration, moment.endTime + 2)};
  }
  const companions = candidates.filter(candidate => candidate.id !== moment.id && candidate.storyId === moment.storyId
    && candidate.startTime >= moment.startTime && candidate.startTime <= moment.endTime + 12);
  return {start: moment.startTime, end: Math.min(sourceDuration, Math.max(moment.endTime, ...companions.map(candidate => candidate.endTime)))};
}

export function semanticReviewLabel(id, fontPath=process.env.CAPTION_FONT_PATH
  || (process.platform==='win32'?'C:/Windows/Fonts/arialbd.ttf':'/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')) {
  const label = String(id).replace(/[^a-zA-Z0-9_-]/g, '-');
  const font=String(fontPath).replaceAll('\\','/').replace(':','\\:').replaceAll("'","\\'");
  // setpts=PTS-STARTPTS runs before this label, so the printed time resets
  // for each candidate even after their clips are concatenated.
  return `drawtext=fontfile='${font}':text='${label} LOCAL %{pts\\:flt}s':fontcolor=white:fontsize=24:box=1:boxcolor=black@0.72:boxborderw=8:x=12:y=12`;
}

export function syntheticReactionMismatch(candidate, review) {
  return candidate.completionReason === "candidate reaction window immediately following a verified live goal"
    && !["celebration", "var", "offside"].includes(String(review?.correctedEventType));
}

export function unsupportedNormalPlay(review) {
  if (review?.correctedEventType !== "normal_play") return false;
  // Coaches/stoppage footage must not enter gameplay tracking merely because
  // it is a complete video interval. Require the observer's action evidence.
  return !review.trackingBrief || !Array.isArray(review.trackingBrief.requiredSubjectsByPhase)
    || !review.trackingBrief.requiredSubjectsByPhase.some(phase => phase.subjects?.includes("ball"));
}

export function reconcileVerifiedGoalDecisions(candidates) {
  return candidates.map(candidate => {
    if (candidate.eventType !== "goal" || candidate.semanticVerified !== true) return candidate;
    const decision = candidates.find(other => other.id !== candidate.id
      && other.storyId === candidate.storyId && other.semanticVerified === true
      && ["var", "offside", "disallowed_goal"].includes(other.eventType)
      && Number(other.startTime) >= Number(candidate.startTime)
      && Number(other.startTime) - Number(candidate.endTime) <= 45
      && /disallow|overturn|no goal|ruled out/i.test([other.description, ...(other.semanticNarrationFacts || [])].join(" ")));
    if (!decision) return candidate;
    return { ...candidate, eventType: "disallowed_goal",
      description: `${candidate.description} The verified same-incident decision disallows the goal.`,
      semanticNarrationFacts: [...(candidate.semanticNarrationFacts || []), "The same incident's goal is disallowed after the referee's decision."],
      verifiedDecisionSceneId: decision.id,
      trackingBrief: { ...candidate.trackingBrief,
        ...(candidate.trackingBrief?.payoffEvidence ? { payoffEvidence: {
          ...candidate.trackingBrief.payoffEvidence, eventType: "disallowed_goal" } } : {}) } };
  });
}
