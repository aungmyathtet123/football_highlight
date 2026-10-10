const PHASE_FIELDS = ["originTime", "contactTime", "flightStartTime", "handoffTime", "payoffStartTime", "payoffEndTime", "reactionStart"];
import {narrationOutcomePolicy} from './narration-outcome-policy.mjs';

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function identityFor(moment, identityBindings) {
  const storyId = String(moment?.storyId || moment?.id || "");
  const binding = (Array.isArray(identityBindings) ? identityBindings : [])
    .find(item => String(item?.storyId || "") === storyId);
  if (!binding) return null;
  const allowed = {};
  for (const field of ["scorer", "assister", "goalkeeper", "team", "opponentTeam"]) {
    if (typeof binding[field] === "string" && binding[field].trim()) allowed[field] = binding[field].trim();
  }
  return Object.keys(allowed).length ? allowed : null;
}

function phaseMap(moment) {
  const brief = moment?.trackingBrief || {};
  const start = finite(moment?.startTime, 0);
  const end = finite(moment?.endTime, start);
  const result = { setupStart: start, actionEnd: end };
  for (const field of PHASE_FIELDS) result[field] = finite(brief[field], null);
  return result;
}

function overlayPolicy(moment, identity) {
  const tracking = String(moment?.trackingDecision || moment?.trackingStatus || "").toLowerCase();
  const trackingPassed = moment?.trackingPassed === true || tracking.includes("pass") || tracking.includes("verified") || tracking === "planned_reaction";
  const drawing = String(moment?.tacticalDrawing || "none");
  const reaction = ["reaction", "celebration"].includes(String(moment?.eventType || "").toLowerCase());
  return {
    playerRing: Boolean(moment?.playerHighlight && trackingPassed && !reaction),
    connectorArrow: Boolean(["pass", "run", "map"].includes(drawing) && trackingPassed),
    ballTrail: Boolean(["ball", "pass"].includes(drawing) && trackingPassed),
    freeze: String(moment?.effect || "") === "freeze_analysis" && trackingPassed,
    transition: String(moment?.transitionIn || "cut"),
    transitionDuration: finite(moment?.transitionDuration, 0.12),
    playerNameAllowed: Boolean(identity && (identity.scorer || identity.assister || identity.goalkeeper)),
    hideOnUncertainty: true,
  };
}

export function buildVisualReviewManifest(moments, trackingSummary = null, matchContext = null, identityBindings = [], tracking = null) {
  const selected = (Array.isArray(moments) ? moments : [])
    .filter(moment => moment?.selectedForFinalVideo)
    .sort((left, right) => Number(left.editOrder || 0) - Number(right.editOrder || 0));
  let outputCursor = 0;
  const reviewedMoments = selected.map((moment, index) => {
    const sourceStart = finite(moment.startTime, 0);
    const sourceEnd = finite(moment.endTime, sourceStart);
    const playbackRate = Math.max(0.72, Math.min(1, finite(moment.playbackRate, 1)));
    const freezeDuration = String(moment.effect || "") === "freeze_analysis" ? Math.max(.4, Math.min(1, finite(moment.freezeDuration, .65))) : 0;
    const transition = index === 0 ? 0 : Math.max(.04, Math.min(.36, finite(moment.transitionDuration, .04)));
    const outputStart = outputCursor - transition;
    const outputDuration = Math.max(0, (sourceEnd - sourceStart) / playbackRate) + freezeDuration;
    outputCursor = outputStart + outputDuration;
    const identity = identityFor(moment, identityBindings);
    const evidence=tracking?.moments?.[String(moment.trackingSourceId||moment.id)];
    const phaseChecks=evidence?.renderReview?.phaseChecks;
    const outcomePolicy=narrationOutcomePolicy(moment,evidence);
    const cropChecks=evidence?.finalCropVerified===true && evidence?.renderReview?.passed===true
      ? (phaseChecks||evidence.renderReview.observations?.map(check=>({...check,phase:'observed_action'}))||[]).filter(check=>Number.isFinite(check.time)
        && check.time>=0 && check.time<=sourceEnd-sourceStart && (!phaseChecks || check.ballVisible===true)
        && typeof check.description==='string') : [];
    return {
      reviewId: `visual-review-${index + 1}`,
      editOrder: index,
      storyId: String(moment.storyId || moment.id || ""),
      candidateId: String(moment.id || ""),
      eventType: String(moment.eventType || "action"),
      role: String(moment.role || "evidence"),
      source: { startTime: sourceStart, endTime: sourceEnd },
      output: { startTime: outputStart, endTime: outputCursor, duration: outputDuration },
      phaseMap: phaseMap(moment),
      verifiedIdentity: identity,
      identityPolicy: identity ? "use_only_this_binding" : "role_only_no_player_name",
      visualClaim: outcomePolicy ? outcomePolicy.confirmedFacts.join(' '):cropChecks.length ? cropChecks.map(check=>check.description).join(' ')
        : String(moment.semanticNarrationFacts?.[0] || moment.description || "Verified football action with visible player-and-ball evidence."),
      cropObservations: outcomePolicy ? outcomePolicy.confirmedFacts.map(description=>({phase:'observed_action',
        description,timingUnspecified:true}))
        :cropChecks.map(check=>({phase:check.phase,sourceTime:sourceStart+check.time,
          sceneLocalTime:check.time,description:check.description})),
      narrationEvidencePolicy: outcomePolicy?.type || (cropChecks.length ? "approved_crop_observations_override_source_discovery" : "source_observations_only"),
      outcomeNarrationPolicy:outcomePolicy,
      overlayPolicy: overlayPolicy(moment, identity),
      tracking: {
        passed: Boolean(moment.trackingPassed === true || String(moment.trackingDecision || "").toLowerCase().includes("pass")),
        decision: String(moment.trackingDecision || moment.trackingStatus || "unreported"),
        confidence: finite(moment.trackingConfidence, null),
      },
    };
  });
  return {
    version: 1,
    status: "reviewed_visual_timeline",
    authoritativeForNarration: true,
    selectedDuration: outputCursor,
    matchContext: matchContext || null,
    trackingSummary: trackingSummary || null,
    identityBindings: Array.isArray(identityBindings) ? identityBindings : [],
    moments: reviewedMoments,
  };
}
