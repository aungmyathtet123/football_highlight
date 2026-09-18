function actionShotRange(moment, shots) {
  const brief = moment.trackingBrief || {};
  const sourceOrigin = Number(brief.originTime), contact = Number(brief.contactTime), payoff = Number(brief.payoffEndTime);
  let origin = sourceOrigin;
  const replay = moment.isReplay === true || moment.storyPhase === "replay";
  if (replay && Math.abs(sourceOrigin - Number(moment.startTime)) <= 0.15 && contact - sourceOrigin > 3) {
    const contactShot = shots.find(shot => shot.startTime <= contact && shot.endTime >= contact);
    if (contactShot && contactShot.startTime > sourceOrigin + 1) origin = Number(contactShot.startTime);
  }
  if (![origin, contact, payoff].every(Number.isFinite) || origin > contact || contact >= payoff) return undefined;
  const originIndex = shots.findIndex(shot => shot.startTime <= origin && shot.endTime >= origin);
  const payoffIndex = shots.findIndex(shot => shot.startTime <= payoff && shot.endTime >= payoff);
  if (originIndex < 0 || payoffIndex < originIndex) return undefined;
  return { origin, contact, payoff, originIndex, payoffIndex, first: shots[originIndex], last: shots[payoffIndex], replayOriginCorrected: origin !== sourceOrigin };
}

// Semantic review can refine the true action origin after shot alignment has
// already run. Remove stale in-shot pre-roll without changing scene identity.
// This is especially important for set pieces where a broad candidate may
// begin on an unrelated goalkeeper close-up many seconds before the delivery.
export function trimToVerifiedActionOrigin(moment) {
  if (moment?.storyPhase === "reaction" || moment?.eventType === "celebration") return moment;
  const origin = Number(moment?.trackingBrief?.originTime);
  const start = Number(moment?.startTime), end = Number(moment?.endTime);
  if (![origin, start, end].every(Number.isFinite) || origin <= start) return moment;
  const replay = moment.isReplay === true || moment.storyPhase === "replay";
  const correctedStart = Number(Math.max(start, origin - (replay ? 0.1 : 1.2)).toFixed(3));
  if (correctedStart <= start + 0.5 || end - correctedStart < 3) return moment;
  return {
    ...moment,
    startTime: correctedStart,
    trackingDecision: undefined,
    boundaryCorrection: {
      ...(moment.boundaryCorrection || {}),
      originalStartTime: moment.boundaryCorrection?.originalStartTime ?? start,
      originalEndTime: moment.boundaryCorrection?.originalEndTime ?? end,
      reason: "verified_action_origin_after_semantic_review",
    },
  };
}

// Retain one semantic action across consecutive broadcast shots while removing
// unrelated lead-in. Every changed interval is reviewed and tracked again.
export function alignGoalToShot(moment, shots) {
  if (moment.boundaryCorrection && moment.semanticVerified === true && moment.trackingDecision === "not_tracked") {
    moment = { ...moment, keepDecision: "keep", trackingDecision: undefined, rejectReason: undefined };
  }
  if (moment.boundaryCorrection && moment.semanticVerified === false && moment.semanticVerificationVersion == null
      && moment.trackingDecision === "incomplete_goal_action") {
    moment = { ...moment, semanticVerified: undefined, keepDecision: "keep", trackingDecision: undefined, rejectReason: undefined };
  }
  if (moment.eventType !== "goal") return moment;
  const replay = moment.isReplay === true || moment.storyPhase === "replay";
  const range = actionShotRange(moment, shots);
  if (!range) return moment;
  const preRoll = replay ? 0.1 : 1.2;
  const correctedStart = Number((range.replayOriginCorrected
    ? range.origin
    : Math.max(range.first.startTime, range.origin - preRoll)).toFixed(3));
  // The action candidate ends shortly after its verified result. Celebration
  // and replay remain separate story phases, so a broad observer interval
  // cannot lock unrelated play after the goalmouth payoff.
  const payoffTail = moment.isReplay || moment.storyPhase === "replay" ? 0.65 : 1.15;
  const correctedEnd = Number(Math.min(Number(moment.endTime), range.payoff + payoffTail).toFixed(3));
  const startChanged = correctedStart > Number(moment.startTime) + .04;
  const endChanged = correctedEnd < Number(moment.endTime) - .04;
  if ((!startChanged && !endChanged) || correctedStart > range.contact - 1
      || correctedEnd - correctedStart < 3) return moment;
  return { ...moment, startTime: correctedStart, endTime: correctedEnd,
    trackingBrief: range.replayOriginCorrected ? { ...moment.trackingBrief, originTime: range.origin } : moment.trackingBrief,
    boundaryCorrection: { originalStartTime: moment.boundaryCorrection?.originalStartTime ?? moment.startTime,
      originalEndTime: moment.boundaryCorrection?.originalEndTime ?? moment.endTime,
      reason: "preceding_footage_before_action_origin", shotStartTime: range.first.startTime,
      shotEndTime: range.last.endTime, shotCount: range.payoffIndex - range.originIndex + 1 },
    semanticVerified: undefined, semanticSignature: undefined, semanticVerificationVersion: undefined,
    keepDecision: "keep", trackingDecision: undefined, rejectReason: undefined,
    keyActionTimes: (moment.keyActionTimes || []).filter(keyframe => keyframe.time >= range.first.startTime),
    selectedForFinalVideo: false };
}

const PHASE_ACTION_EVENTS = new Set([
  "disallowed_goal", "save", "shot_on_target", "shot_off_target", "big_chance", "free_kick",
]);

export function alignActionToShot(moment, shots) {
  const goalAligned = alignGoalToShot(moment, shots);
  if (goalAligned.eventType === "goal" || !PHASE_ACTION_EVENTS.has(goalAligned.eventType)) return goalAligned;
  const range = actionShotRange(goalAligned, shots);
  if (!range) return goalAligned;
  const rejectedForPhases = /incomplete_action_phases|ball_not_visibly_continuous|unstable_camera|insufficient_joint_framing|keyframe_(?:opening|contact|ball_flight|payoff)/.test(String(goalAligned.trackingDecision || ""));
  const clippedAtContact = range.contact >= Number(goalAligned.endTime) - 0.45;
  const clippedAtPayoff = range.payoff >= Number(goalAligned.endTime) - 0.12;
  if (!rejectedForPhases && !clippedAtContact && !clippedAtPayoff) return goalAligned;
  const correctedStart = Number((range.replayOriginCorrected
    ? range.origin
    : Math.max(range.first.startTime, range.origin - 1.2)).toFixed(3));
  const correctedEnd = Number(goalAligned.endTime.toFixed(3));
  if (correctedEnd < range.contact + 0.7 || correctedEnd - correctedStart < 3) return goalAligned;
  if (Math.abs(correctedStart - Number(goalAligned.startTime)) <= 0.04) return goalAligned;
  return { ...goalAligned, startTime: correctedStart, endTime: correctedEnd,
    boundaryCorrection: {
      originalStartTime: goalAligned.boundaryCorrection?.originalStartTime ?? goalAligned.startTime,
      originalEndTime: goalAligned.boundaryCorrection?.originalEndTime ?? goalAligned.endTime,
      reason: "complete_contact_flight_and_payoff_shots", shotStartTime: range.first.startTime,
      shotEndTime: range.last.endTime, shotCount: range.payoffIndex - range.originIndex + 1,
    },
    semanticVerified: undefined, semanticSignature: undefined, semanticVerificationVersion: undefined,
    semanticGeometryVersion: undefined, keepDecision: goalAligned.isReplay ? "replay" : "keep",
    trackingDecision: undefined, rejectReason: undefined, selectedForFinalVideo: false };
}

// A second live goal cannot begin a few seconds after the previous goal ends:
// the match has not restarted yet. Keep it as replay proof for that incident.
export function linkImmediateGoalReplays(moments, maximumGap = 8, maximumReplayGap = 45) {
  const ordered = [...moments].sort((a, b) => a.startTime - b.startTime);
  const verifiedLiveStoryIds = new Set(ordered.filter(moment => moment.eventType === "goal"
    && !moment.isReplay && moment.storyPhase !== "replay"
    && moment.semanticVerified === true
    && (moment.keepDecision !== "reject" || moment.trackingDecision === "phase_verified_goal"))
    .map(moment => String(moment.storyId || moment.id)));
  const replayStoryLinks = new Map();
  const verifiedLiveGoals = [];
  const linked = ordered.map(moment => {
    if (moment.eventType !== "goal") return moment;
    const explicitReplay = moment.isReplay === true || moment.storyPhase === "replay";
    const previous = [...verifiedLiveGoals].reverse().find(goal => {
      const gap = Number(moment.startTime) - Number(goal.endTime);
      const overlap = Math.max(0, Math.min(Number(moment.endTime), Number(goal.endTime))
        - Math.max(Number(moment.startTime), Number(goal.startTime)));
      // Overlapping goal candidates cannot be two different live goals. They
      // are alternate descriptions/angles of the same scoring incident.
      return (gap >= 0 && gap <= (explicitReplay ? maximumReplayGap : maximumGap))
        || (overlap > 0 && Number(moment.startTime) > Number(goal.startTime));
    });
    const replayOnlyStory = explicitReplay
      && !verifiedLiveStoryIds.has(String(moment.storyId || moment.id));
    if (previous && moment.storyId !== previous.storyId && (!explicitReplay || replayOnlyStory)) {
      if (replayOnlyStory) {
        replayStoryLinks.set(String(moment.storyId || moment.id), String(previous.storyId || previous.id));
      }
      return { ...moment, storyId: previous.storyId, isReplay: true, storyPhase: "replay",
        linkedGoalCandidateId: previous.id };
    }
    if (!moment.isReplay && moment.semanticVerified === true
        && (moment.keepDecision !== "reject" || moment.trackingDecision === "phase_verified_goal")) {
      verifiedLiveGoals.push(moment);
    }
    return moment;
  });
  // A later analysis chunk may give the same replay and its preceding
  // celebration a new storyId. Once the replay is linked to the verified live
  // goal, carry that correction to its reaction companions as well.
  return linked.map(moment => {
    const linkedStoryId = replayStoryLinks.get(String(moment.storyId || moment.id));
    const companion = moment.isReplay || moment.storyPhase === "replay"
      || moment.eventType === "celebration" || moment.storyPhase === "reaction";
    return linkedStoryId && companion ? { ...moment, storyId: linkedStoryId } : moment;
  }).sort((a, b) => a.startTime - b.startTime);
}
