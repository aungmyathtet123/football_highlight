export function assessNativeFrameAction(scene, evidence) {
  const reaction = scene?.eventType === "celebration" || scene?.storyPhase === "reaction" || scene?.role === "reaction";
  if (reaction) return { usable: true, mode: "planned_reaction" };
  // This flag is assigned only after all local repair passes fail and only for
  // a semantically reviewed, complete native-frame incident with a verified
  // visible result. The source pixels remain unchanged; uncertain markers are
  // disabled instead of inventing player/ball coordinates.
  if (scene?.nativeFullFrameEvidence === true
    && scene?.semanticVerified === true
    && scene?.actionComplete === true
    && scene?.ballVisible !== false
    && scene?.mainPlayerVisible !== false
    && scene?.trackingBrief?.payoffEvidence?.verified === true) {
    return { usable: true, mode: "native_semantic_complete_action" };
  }
  if (!evidence?.phaseEvidence || scene?.semanticVerified !== true || scene?.actionComplete === false
    || scene?.ballVisible === false || scene?.mainPlayerVisible === false) {
    return { usable: false, mode: "native_action_evidence_missing" };
  }
  const phase = evidence.phaseEvidence;
  const setup = phase.setup || {};
  const contact = phase.contact || {};
  const flight = phase.flight || {};
  const payoff = phase.payoff || {};
  const setupVisible = Number(setup.samples || 0) > 0
    && Number(setup.ballCoverage || 0) >= .75
    // A native 16:9 frame already contains the whole broadcast composition.
    // During a long buildup the carrier and football can be too far apart for
    // the portrait-oriented joint-fit heuristic even though both are visible.
    && (Number(setup.directJointCoverage || 0) >= .30
      || Number(evidence.playerDetectionCoverage || 0) >= .65);
  const directContactVisible = Number(contact.ballCoverage || 0) >= .75
    && Number(contact.directJointCoverage || 0) >= .40;
  // A shot or sliding finish can hide the ball behind the player's boot or a
  // defender for the few frames labelled contact. Accept that short occlusion
  // only when strong setup ownership hands directly to independently visible
  // flight/goal evidence. This does not permit a player-only scene.
  const verifiedContactHandoff = Number(setup.directJointCoverage || 0) >= .55
    && Number(contact.ballCoverage || 0) >= .25
    && Number(contact.payoffCoverage || 0) >= .40
    && (Number(flight.ballCoverage || 0) >= .35 || Number(flight.payoffCoverage || 0) >= .55);
  const contactVisible = Number(contact.samples || 0) > 0
    && (directContactVisible || verifiedContactHandoff);
  const flightVisible = Number(flight.samples || 0) > 0
    && (Number(flight.ballCoverage || 0) >= .40 || Number(flight.payoffCoverage || 0) >= .50);
  const payoffVisible = Number(payoff.samples || 0) > 0
    && (Number(payoff.payoffCoverage || 0) >= .50 || Number(payoff.ballCoverage || 0) >= .40);
  if (!setupVisible) return { usable: false, mode: "native_setup_evidence_incomplete" };
  if (!contactVisible) return { usable: false, mode: "native_contact_evidence_incomplete" };
  if (!flightVisible) return { usable: false, mode: "native_flight_evidence_incomplete" };
  if (["goal", "shot_on_target", "shot_off_target", "save", "big_chance"].includes(String(scene.eventType)) && !payoffVisible) {
    return { usable: false, mode: "native_payoff_evidence_incomplete" };
  }
  return { usable: true, mode: scene.eventType === "goal" ? "native_frame_verified_goal" : "native_frame_verified_action" };
}

// A locked Step-1 scene in a native 16:9 edit does not depend on a portrait
// crop succeeding. If semantic review already verified the complete action and
// both the ball and main player in the source, keep the scene and suppress only
// detector-driven annotations that could not be proven. Tracking may improve
// presentation after selection, but it must never erase approved footage.
export function canRenderLockedNativeAction(scene) {
  return scene?.selectionLocked === true
    && scene?.semanticVerified === true
    && scene?.actionComplete === true
    && scene?.keepDecision !== "reject"
    && scene?.ballVisible === true
    && scene?.mainPlayerVisible === true;
}

function mapValue(map, id) {
  return map instanceof Map ? map.get(String(id)) : map?.[id];
}

export function recoverNativeFullFrameIncidents(candidates, qualityById, usableById) {
  const source = (Array.isArray(candidates) ? candidates : []).map((moment) => ({ ...moment }));
  const groups = new Map();
  for (const moment of source) {
    if (moment.selectionLocked !== true || !["goal", "disallowed_goal"].includes(String(moment.eventType))) continue;
    const storyId = String(moment.storyId || moment.id);
    if (!groups.has(storyId)) groups.set(storyId, []);
    groups.get(storyId).push(moment);
  }
  const recovered = new Set();
  for (const moments of groups.values()) {
    if (moments.some((moment) => mapValue(usableById, moment.id) === true)) continue;
    const eligible = moments.filter((moment) => moment.semanticVerified === true
      && moment.actionComplete === true
      && moment.ballVisible !== false
      && moment.mainPlayerVisible !== false
      && moment.trackingBrief?.payoffEvidence?.verified === true)
      .sort((left, right) => {
        const leftQuality = Number(mapValue(qualityById, left.id));
        const rightQuality = Number(mapValue(qualityById, right.id));
        return (Number.isFinite(rightQuality) ? rightQuality : -Infinity)
          - (Number.isFinite(leftQuality) ? leftQuality : -Infinity)
          || Number(left.startTime) - Number(right.startTime);
      });
    if (!eligible[0]) continue;
    recovered.add(String(eligible[0].id));
    if (usableById instanceof Map) usableById.set(String(eligible[0].id), true);
    else if (usableById) usableById[eligible[0].id] = true;
  }
  return source.map((moment) => recovered.has(String(moment.id)) ? {
    ...moment,
    nativeFullFrameEvidence: true,
    playerHighlight: false,
    tacticalDrawing: "none",
    trackingPassed: true,
    trackingDecision: "native_semantic_complete_action",
  } : moment);
}
