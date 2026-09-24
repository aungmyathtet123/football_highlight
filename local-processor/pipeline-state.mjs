import { createHash } from "node:crypto";

export const SEMANTIC_VERIFICATION_VERSION = 9;

export function stableSignature(value) {
  const canonical = (item) => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, canonical(item[key])])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function semanticSignature(moment) {
  return stableSignature({ version: 5, start: moment.startTime, end: moment.endTime,
    event: moment.eventType, description: moment.description, storyPhase: moment.storyPhase });
}

export function needsSemanticReview(moment) {
  return moment.semanticVerificationVersion !== SEMANTIC_VERIFICATION_VERSION || moment.semanticSignature !== semanticSignature(moment);
}

export function mergeSemanticReview(moment, review) {
  const fields = ["eventType", "storyPhase", "role", "description", "actionComplete", "trackingBrief",
    "semanticVerificationVersion", "semanticGeometryVersion", "semanticDecisionContextVersion", "semanticVerified", "semanticSignature", "semanticNarrationFacts"];
  const result = { ...moment };
  for (const key of fields) if (Object.hasOwn(review, key)) result[key] = review[key];
  if (result.eventType !== "celebration") {
    if (result.storyPhase === "reaction") result.storyPhase = result.isReplay ? "replay" : "action";
    if (result.role === "reaction") result.role = "evidence";
  }
  if (review.semanticVerified === false) return { ...result, keepDecision: "reject",
    selectedForFinalVideo: false, trackingDecision: "semantic_mismatch", rejectReason: review.rejectReason };
  // A cached semantic approval cannot undo a newer local framing rejection.
  return result;
}

export function incidentManifest(candidates) {
  const groups = new Map();
  for (const moment of candidates) {
    const id = moment.storyId || `unlinked-${moment.id}`;
    if (!groups.has(id)) groups.set(id, { id, actions: [], replays: [], reactions: [] });
    const role = moment.eventType === "celebration" || moment.storyPhase === "reaction" ? "reactions"
      : moment.isReplay || moment.storyPhase === "replay" ? "replays" : "actions";
    groups.get(id)[role].push({ id: moment.id, start: moment.startTime, end: moment.endTime,
      event: moment.eventType, semanticVerified: moment.semanticVerified === true,
      decision: moment.trackingDecision || moment.keepDecision, reason: moment.rejectReason || null });
  }
  return { version: 1, incidents: [...groups.values()] };
}

export function rankIncidentGroups(candidates) {
  const priority = { goal: 1000, disallowed_goal: 950, offside: 850, var: 850, save: 700, shot_on_target: 700, big_chance: 500, free_kick: 400 };
  const groups = new Map();
  for (const moment of candidates) {
    if (moment.semanticVerified === false || moment.actionComplete === false) continue;
    const id = moment.storyId || `unlinked-${moment.id}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(moment);
  }
  return [...groups.values()].filter(group => group.some(m => m.eventType !== "celebration" && m.storyPhase !== "reaction"))
    .sort((a, b) => Math.max(...b.map(m => (priority[m.eventType] || 0) + Number(m.importanceScore || 0)))
      - Math.max(...a.map(m => (priority[m.eventType] || 0) + Number(m.importanceScore || 0))))
    .map(group => group.sort((a, b) => a.startTime - b.startTime));
}

export function evidenceReport(candidates, capacity, minimum) {
  const rejected = candidates.filter(m => m.keepDecision === "reject").map(m => ({
    id: m.id, start: m.startTime, end: m.endTime, event: m.eventType,
    reason: m.rejectReason || m.trackingDecision || "analysis_rejected",
    semanticVerified: m.semanticVerified === true,
  }));
  return { version: 1, capacity, minimum, shortfall: Math.max(0, minimum - capacity), rejected,
    repairable: rejected.filter(m => m.semanticVerified && trackingRepairableReason(m.reason)).map(m => m.id) };
}

export function trackingRepairableReason(value) {
  return /framing|camera|ball|goal_action|action_phases|keyframe_(?:opening|contact|ball_flight|payoff)/.test(String(value || ""));
}

export function parseTrackingProgress(line) {
  if (!line.startsWith("TRACK_PROGRESS ")) return null;
  try {
    const value = JSON.parse(line.slice(15));
    if (!Number.isFinite(value.completed) || !Number.isFinite(value.total) || value.total < 1) return null;
    return { ...value, completed: Math.max(0, Math.min(value.total, value.completed)) };
  } catch { return null; }
}

export function matchingTrackingEvidence(tracking, moment) {
  const key = String(moment?.trackingSourceId || moment?.id || "");
  const evidence = tracking?.moments?.[key] || tracking?.moments?.[moment?.id];
  if (!evidence) return undefined;
  const start = Number(evidence.sourceStartTime), end = Number(evidence.sourceEndTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  if (Math.abs(start - Number(moment.startTime)) > .041) return undefined;
  const reaction = moment.eventType === "celebration";
  if (reaction ? Number(moment.endTime) > end + .041 : Math.abs(end - Number(moment.endTime)) > .041) return undefined;
  return evidence;
}

export function summarizeTracking(moments) {
  const entries = Object.values(moments || {});
  const sampledFrames = entries.reduce((n,m) => n + Number(m.sampledFrames || 0),0);
  const fields = ["ballDetectionCoverage","playerDetectionCoverage","jointVisibilityCoverage","jointFitCoverage","subjectLockCoverage","highlightCoverage"];
  return { sampledFrames, ...Object.fromEntries(fields.map(field => [field,
    entries.reduce((n,m) => n + Number(m[field] || 0) * Number(m.sampledFrames || 0),0) / Math.max(1,sampledFrames)])) };
}

export function localRepairPriority(moment, evidence) {
  if (!evidence || moment.semanticVerified !== true) return -1;
  // More detector samples cannot fix a source-geometry contradiction or a scene
  // with no observed contact. Spend the bounded CPU repair on near-complete paths.
  const p = evidence.phaseEvidence;
  const recoverableGoal = moment.eventType === "goal"
    && Number(p?.setup?.directJointCoverage || 0) >= .45
    && Number(p?.contact?.directJointCoverage || 0) >= .35
    && Number(evidence.goalPayoffCoverage || 0) >= .50;
  if (p?.version !== 1 || Number(evidence.cameraMaxStep || 0) > .08
      || Number(p.setup?.jointCoverage || 0) < (recoverableGoal ? .45 : .60)
      || Number(p.contact?.directJointCoverage || 0) < .20
      || (p.flight?.samples > 0 && Number(p.flight.ballCoverage || 0) < .50)) return -1;
  return (moment.eventType === "goal" ? 100 : 0) + Number(p.setup.jointCoverage) * 10
    + Number(p.contact.directJointCoverage) * 10;
}

export function restoreContentBeatOrder(moments, contentBeats) {
  // The alignment has already validated incident order. Normalize narration in
  // place; sorting silent support by beat ID used to detach goal celebrations.
  const beats = Array.isArray(contentBeats) ? contentBeats : [];
  if (!beats.length) return moments;
  const normalize = text => String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  const byId = new Map(beats.map(beat => [String(beat.beatId), beat]));
  const byText = new Map(beats.filter(beat => normalize(beat.narration)).map(beat => [normalize(beat.narration), beat]));
  const used = new Set();
  const ordered = moments.filter(moment => moment.selectedForFinalVideo)
    .sort((a,b) => Number(a.editOrder) - Number(b.editOrder))
    .map((moment, editOrder) => {
      const text = normalize(moment.commentary);
      const beat = byText.get(text) || byId.get(String(moment.beatId || ""));
      if (!text || !beat || used.has(beat.beatId)) return { ...moment, editOrder, commentary: undefined };
      used.add(beat.beatId);
      return { ...moment, editOrder, beatId: beat.beatId, role: beat.role,
        commentary: beat.narration, onScreenText: moment.onScreenText || beat.captionText };
    });
  const byMoment = new Map(ordered.map(moment => [moment.id,moment]));
  return moments.map(moment => byMoment.get(moment.id) || {...moment,selectedForFinalVideo:false});
}
