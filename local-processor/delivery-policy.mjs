const SAFE_STATIC_EVENTS = new Set(["celebration"]);

export const SAFE_STATIC_TRACKING_PREFIX = "safe_static_";

export function safeStaticFallbackEligible(moment) {
  if (!moment || moment.semanticVerified !== true || moment.actionComplete !== true) return false;
  const playerOnlyReaction = SAFE_STATIC_EVENTS.has(String(moment.eventType || ""))
    || moment.storyPhase === "reaction"
    || moment.role === "reaction";
  return playerOnlyReaction
    && moment.mainPlayerVisible === true
    && Number(moment.confidence || 0) >= 0.84
    && Number(moment.visualClarity || 0) >= 70;
}

export function usesSafeStaticPresentation(moment) {
  return String(moment?.trackingDecision || "").startsWith(SAFE_STATIC_TRACKING_PREFIX);
}

export function recoverSafeStaticCandidates(moments) {
  return (Array.isArray(moments) ? moments : []).map((moment) => (
    moment.keepDecision === "reject" && safeStaticFallbackEligible(moment)
      ? downgradeToSafeStatic(moment, moment.trackingDecision || "tracking_unavailable", false)
      : moment
  ));
}

export function downgradeToSafeStatic(moment, reason, selectedForFinalVideo = false) {
  const replay = moment.isReplay === true || moment.storyPhase === "replay";
  const decisive = ["goal", "disallowed_goal", "save", "shot_on_target", "shot_off_target", "big_chance"].includes(moment.eventType);
  const hasFreezeAnchor = Number.isFinite(Number(moment.trackingBrief?.contactTime))
    || Number.isFinite(Number(moment.trackingBrief?.payoffStartTime));
  const requestedFreeze = moment.effect === "freeze_analysis";
  return {
    ...moment,
    keepDecision: replay ? "replay" : "keep",
    selectedForFinalVideo,
    trackingDecision: `${SAFE_STATIC_TRACKING_PREFIX}${String(reason || "tracking_unavailable")}`,
    rejectReason: undefined,
    playerHighlight: false,
    tacticalDrawing: "none",
    effect: requestedFreeze && hasFreezeAnchor
      ? "freeze_analysis"
      : replay
        ? "replay_treatment"
        : decisive
          ? "slow_motion"
          : "none",
    fallbackPresentation: {
      mode: "stable_vertical_crop",
      reason: String(reason || "tracking_unavailable"),
      markerSuppressed: true,
      dynamicCameraSuppressed: true,
    },
  };
}
