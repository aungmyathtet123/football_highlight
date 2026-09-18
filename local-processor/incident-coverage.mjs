// Coverage is about distinct source incidents, not the number of replay clips.
export function incidentCoverage(candidates, selected = candidates.filter(m => m.keepDecision !== "reject")) {
  const verifiedTrackingDecisions = new Set([
    "phase_verified_goal",
    "native_frame_verified_goal",
    "native_frame_verified_action",
    "native_semantic_complete_action",
    "full_bleed_repaired",
    "verified_minimum_motion",
  ]);
  const required = new Map();
  for (const m of candidates) {
    if (m.semanticVerified !== true || !["goal", "var", "offside", "disallowed_goal"].includes(m.eventType)) continue;
    const id = String(m.storyId || m.id);
    if (!required.has(id)) required.set(id, {id, eventType:m.eventType, eventTypes:[], candidates:[], covered:false});
    if (!required.get(id).eventTypes.includes(m.eventType)) required.get(id).eventTypes.push(m.eventType);
    required.get(id).candidates.push(m.id);
  }
  for (const incident of required.values()) {
    const incidentCandidates = candidates.filter(m => String(m.storyId || m.id) === incident.id);
    const selectedIncident = selected.filter(m => String(m.storyId || m.id) === incident.id
      && m.semanticVerified === true
      && m.keepDecision !== "reject"
      && m.selectedForFinalVideo !== false);
    if (incident.eventTypes.includes("goal")) {
      incident.covered = selectedIncident.some(m => m.eventType === "goal"
        && m.actionComplete === true
        && verifiedTrackingDecisions.has(String(m.trackingDecision))
        && ((!m.isReplay && m.storyPhase !== "replay") || m.chosenIncidentAngle === true));
    } else if (incident.eventTypes.includes("disallowed_goal")) {
      // Offside/VAR labels are decision evidence belonging to the same
      // disallowed-goal incident, not additional incidents that each require a
      // separate selected clip. One complete verified disallowed-goal scene
      // covers the action, finish and decision.
      incident.covered = selectedIncident.some(m => m.eventType === "disallowed_goal"
        && m.actionComplete === true
        && verifiedTrackingDecisions.has(String(m.trackingDecision)));
    } else {
      incident.covered = selectedIncident.some(m => ["offside", "var"].includes(m.eventType)
        && m.actionComplete !== false);
    }
  }
  const incidents = [...required.values()];
  return {version:1, required:incidents.length, covered:incidents.filter(i=>i.covered).length,
    missing:incidents.filter(i=>!i.covered), incidents};
}

export function assertIncidentCoverage(candidates, selected) {
  const report = incidentCoverage(candidates, selected.map(m=>({...m,selectedForFinalVideo:true})));
  if (report.missing.length) throw new Error(`Complete-match coverage is missing ${report.missing.length} verified incident(s): ${report.missing.map(m=>m.id).join(", ")}. Do not omit goals to meet a duration estimate.`);
  return report;
}
