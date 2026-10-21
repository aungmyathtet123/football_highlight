// This is an observation aid, not a tracker or an asserted goal result.
// Preserve whole-scene video context and magnify an already observed region.
export const GOAL_OUTCOME_VERSION = 10;
export const OUTCOME_OBSERVATION_PROMPT_VERSION = 4;
export function outcomeScoreConflict(review, context, moment) {
  if (context?.status === 'unchanged') return review?.goalScored === true
    && review.eventType === 'goal' && review.goalDecision !== 'disallowed';
  // An increase calls for adjudication, not an automatic goal approval. An
  // unrelated chance overlapping a broad score window is not that incident.
  if (context?.status !== 'provisional' || !review) return false;
  if (moment && moment.sourceScoreAnchorId !== context.id
    && !['goal','disallowed_goal'].includes(moment.eventType)) return false;
  return review.goalScored !== true || review.eventType !== 'goal'
    || review.goalDecision === 'disallowed';
}

export function outcomeEvidenceConflict(review, context, moment) {
  if (outcomeScoreConflict(review,context,moment)) return true;
  // A neutral completed-action observation and an outcome-only observer may
  // disagree even when the scoreboard is absent. Resolve, don't silently veto.
  return moment?.semanticVerified===true && moment.trackingBrief?.payoffEvidence?.verified===true
    && ['goal','disallowed_goal'].includes(moment.eventType)
    && (review?.goalScored===false || review?.eventType==='uncertain');
}

export const SOURCE_OUTCOME_OBSERVATION_VERSION = 1;
export function outcomeObservationSchema() {
  return {type:'object',required:['goalScored','goalDecision','eventType','description','narrationFacts','uncertainties'],
    properties:{goalScored:{type:'boolean'},goalDecision:{type:'string',enum:['allowed','disallowed','unclear','not_applicable']},
      eventType:{type:'string',enum:['goal','save','shot_on_target','shot_off_target','big_chance','uncertain']},
      description:{type:'string'},narrationFacts:{type:'array',items:{type:'string'}},
      uncertainties:{type:'array',items:{type:'string'}}}};
}

// Reuse independent pixel observation, never an unverified discovery label.
export function reusableSourceOutcome(moment, sourceSignature) {
  const saved=moment?.sourceOutcomeObservation,review=saved?.review,brief=moment?.trackingBrief;
  if(typeof sourceSignature!=='string' || !sourceSignature || saved?.version!==SOURCE_OUTCOME_OBSERVATION_VERSION || saved.sourceSignature!==sourceSignature
    || saved.start!==moment.startTime || saved.end!==moment.endTime
    || moment.semanticVerified!==true || moment.actionComplete!==true
    || !reusableCompletedOutcome(review) || !brief || brief.payoffEvidence?.verified!==true) return null;
  if(typeof review.description!=='string' || !review.description.trim()
    || review.narrationFacts.some(fact=>typeof fact!=='string'||!fact.trim())) return null;
  const event=moment.eventType==='disallowed_goal'?'goal':moment.eventType;
  if(review.eventType!==event || review.goalScored!==['goal','disallowed_goal'].includes(moment.eventType)) return null;
  if(review.goalScored && !['allowed','disallowed','unclear'].includes(review.goalDecision)) return null;
  if(!review.goalScored && review.goalDecision!=='not_applicable') return null;
  const times=['originTime','contactTime','payoffStartTime','payoffEndTime'].map(key=>brief[key]);
  if(times.some(time=>!Number.isFinite(time)||time<moment.startTime||time>moment.endTime)
    || times[1]<times[0] || times[2]<times[1]-.125 || times[3]<=times[1]+.05) return null;
  return review;
}

// Alternative angles are evidence about the SAME incident, not replacements
// for a scene's boundaries, approvals, or position keyframes.
export function sameIncidentOutcomeWindows(moment, candidates, maximum=2) {
  if (!moment.sourceScoreAnchorId && !moment.storyId) return [];
  const linked=other=>moment.sourceScoreAnchorId
    ? other.sourceScoreAnchorId===moment.sourceScoreAnchorId
    : other.storyId===moment.storyId;
  const alternatives=candidates.filter(other=>other.id!==moment.id && linked(other)
    && ['goal','disallowed_goal','save','shot_on_target','shot_off_target','big_chance'].includes(other.eventType)
    && (other.sourceScoreObservation===true || other.semanticVerified===true)
    && other.actionComplete===true && Number.isFinite(other.startTime) && Number.isFinite(other.endTime)
    && other.endTime>other.startTime && other.endTime-other.startTime<=30
    && Math.min(other.endTime,moment.endTime)-Math.max(other.startTime,moment.startTime)<=.25);
  alternatives.sort((a,b)=>Number(b.semanticVerified===true)-Number(a.semanticVerified===true)
    || Number(a.sourceCameraSegments?.length||1)-Number(b.sourceCameraSegments?.length||1)
    || Math.abs(a.startTime-moment.startTime)-Math.abs(b.startTime-moment.startTime));
  const selected=[];
  for(const other of alternatives) {
    if(selected.length>=maximum) break;
    if(selected.some(window=>Math.min(window.end,other.endTime)-Math.max(window.start,other.startTime)>.25)) continue;
    selected.push({id:other.id,start:other.startTime,end:other.endTime,isReplay:Boolean(other.isReplay||other.storyPhase==='replay')});
  }
  return selected;
}

export function outcomeConflictSampleTimes(moment, maximum=12) {
  const start=Number(moment.startTime),end=Number(moment.endTime);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start) return [];
  const times=new Set([start,Math.max(start,end-.05)]),brief=moment.trackingBrief||{};
  for(const key of ['contactTime','payoffStartTime','payoffEndTime']) {
    if(!Number.isFinite(brief[key])) continue;
    for(const delta of [-.125,0,.125]) {
      if(times.size>=maximum) break;
      times.add(Math.max(start,Math.min(Math.max(start,end-.01),brief[key]+delta)));
    }
  }
  for(let step=1;times.size<maximum && step<maximum;step++)
    times.add(start+Math.max(0,end-start-.01)*step/(maximum-1));
  return [...times].sort((a,b)=>a-b);
}

// A single-scene outcome check must not inherit the whole-match inventory
// instructions. Repeated scorer/net instructions prime ambiguous chances as
// goals and make the model search for events that are not in this clip.
export function singleActionObservationContract() {
  return [
    'Observe ONE supplied action only. Do not inventory a match, search for more goals, or presume this scene contains a goal. A saved, blocked, wide or unfinished attempt is not a goal.',
    'Read the continuous moving match ball, starting at the initiating player, through every pass or touch to the visible result. Separate setup, contact, flight or continuation, and payoff. A still white object beside the net is not the moving ball.',
    'This request checks the physical outcome, NOT camera paths or keyframe geometry. Do not generate a trackingBrief, per-phase timestamps or rectangles. Those are measured separately. Magnified detail images assist observation only: never reuse their cropped coordinates as full-video coordinates.',
    'Classify a goal only when the moving ball path and visible net/goal result support it. Scoreboard and reaction alone cannot prove a crossing. Distinguish a physical finish from an official decision. Do not infer disallowance or its reason merely from an unchanged score. Describe conflicts honestly.',
    'Narration facts contain only what this scene visibly supports. Do not invent team names, player names, saves, rebounds, fouls, posts or contact by a defender. When an outcome is unclear, return uncertain rather than forcing a scorer story.',
  ].join(' ');
}

export function goalOutcomeDetailIndexes(moment,detail,count,maximum=16) {
  if (!(count>0)) return [];
  const selected=new Set([0,count-1]);
  const brief=moment.trackingBrief||{};
  // Native dense frames remain available on disk. Send phase neighbourhoods
  // plus broad context rather than 48 largely redundant high-detail images.
  for(const key of ['contactTime','payoffStartTime','flightStartTime']) {
    if(!Number.isFinite(brief[key])) continue;
    for(const delta of [0,-1,1,-2,2]) {
      if(selected.size>=maximum) break;
      const index=Math.round((brief[key]-detail.start)*detail.fps)+delta;
      if(index>=0 && index<count) selected.add(index);
    }
  }
  for(let step=0;selected.size<Math.min(count,maximum)&&step<maximum;step++)
    selected.add(Math.round(step*(count-1)/Math.max(1,maximum-1)));
  return [...selected].sort((a,b)=>a-b);
}

export function reusableDenseGoalOutcome(review, scoreContext) {
  return scoreContext?.status === 'provisional' && review?.goalScored === true
    && review.eventType === 'goal' && review.goalDecision === 'allowed'
    && Array.isArray(review.uncertainties) && review.uncertainties.length === 0
    && Array.isArray(review.narrationFacts) && review.narrationFacts.length > 0;
}

export function reusableCompletedOutcome(review) {
  return Array.isArray(review?.uncertainties) && review.uncertainties.length === 0
    && Array.isArray(review?.narrationFacts) && review.narrationFacts.length > 0
    && ((review.goalScored === true && review.eventType === 'goal')
      || (review.goalScored === false && ['save','shot_on_target','shot_off_target','big_chance'].includes(review.eventType)));
}

export function sameIncidentDecisionWindows(moment, candidates) {
  if (!moment.storyId) return [];
  return candidates.filter(other => other.id !== moment.id && other.storyId === moment.storyId
    && other.semanticVerified === true && ['var','offside','disallowed_goal'].includes(other.eventType)
    && Number(other.startTime) >= Number(moment.endTime)
    && Number(other.startTime) - Number(moment.endTime) <= 45)
    .slice(0, 3).map(other => ({ id: other.id, start: Number(other.startTime), end: Number(other.endTime) }));
}

export function needsGoalOutcomeObservation(moment) {
  return moment.semanticVerified === true && moment.keepDecision !== 'reject'
    && ['goal','disallowed_goal','save','shot_on_target','shot_off_target','big_chance'].includes(moment.eventType);
}

export function invalidateOlderGoalOutcomes(candidates) {
  return candidates.map(moment => moment.goalOutcomeCrosscheck
    && moment.goalOutcomeCrosscheck.version !== GOAL_OUTCOME_VERSION
    && moment.selectionLocked !== true
    ? { ...moment, semanticVerificationVersion: 0, semanticSignature: undefined,
      goalOutcomeCrosscheck: undefined } : moment);
}

export function goalOutcomeDetail(moment, media) {
  const start = Number(moment.startTime), end = Number(moment.endTime);
  const brief = moment.trackingBrief || {};
  const contact = Number(brief.contactTime);
  const payoffEnd = Number(brief.payoffEndTime);
  // A short selected camera view is already the complete action. Sparse
  // director phase hints must not crop its real touch out of native evidence.
  const wholeView=moment.sourceViewSplit===true && end-start<=12;
  const from = !wholeView && Number.isFinite(contact) ? Math.max(start, Math.min(end - .01, contact - 1.5)) : start;
  const to = !wholeView && Number.isFinite(payoffEnd) && payoffEnd > from
    ? Math.min(end, payoffEnd + .6) : end;
  const target = brief.payoffEvidence?.targetBox;
  let crop = null;
  if (Array.isArray(target) && target.length === 4 && target.every(Number.isFinite)
    && target[0] >= 0 && target[1] >= 0 && target[2] <= 1 && target[3] <= 1
    && target[2] > target[0] && target[3] > target[1]) {
    const width = Math.min(1, Math.max(.5, target[2] - target[0] + .24));
    const height = Math.min(1, Math.max(.8, target[3] - target[1] + .4));
    const x = Math.max(0, Math.min(1 - width, (target[0] + target[2]) / 2 - width / 2));
    const y = Math.max(0, Math.min(1 - height, (target[1] + target[3]) / 2 - height / 2));
    const even = value => Math.floor(value / 2) * 2;
    crop = { x: even(x * media.width), y: even(y * media.height),
      width: even(width * media.width), height: even(height * media.height) };
  }
  return { start: from, end: Math.min(end, Math.max(from + .01, to)),
    // A header/deflection can cross the line between two 0.5-second samples.
    // Use dense native result evidence, bounded to 48 images per observation.
    fps: Math.min(8, 48 / Math.max(.01, to - from)), crop };
}
