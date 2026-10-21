// An incident's outcome is not necessarily the content of every camera angle.
// Only an already visually verified, explicitly support-only brief may change
// a disallowed-goal label to a VAR decision. Never infer this from prose alone.
export function normalizeDecisionOnlyScene(scene) {
  const brief = scene?.trackingBrief;
  const phases = brief?.requiredSubjectsByPhase;
  if (scene?.eventType !== "disallowed_goal" || scene.semanticVerified !== true
    || scene.actionComplete !== true
    || !["reaction", "decision", "referee"].includes(brief?.cameraMode)
    || brief?.payoffEvidence != null
    || !Array.isArray(phases) || !phases.length
    || phases.some(item => !["reaction", "decision"].includes(item.phase)
      || !Array.isArray(item.subjects) || !item.subjects.length
      || item.subjects.some(subject => ["ball", "goal_mouth", "receiver", "goalkeeper"].includes(subject)))
    || !scene.semanticNarrationFacts?.some(fact => /\b(?:referee|VAR|offside|monitor)\b/i.test(String(fact)))) return scene;
  return { ...scene, eventType: "var", storyPhase: "reaction",
    semanticReclassification: { originalEventType: "disallowed_goal", reason: "verified_decision_only_angle" } };
}

export function isDecisionScene(scene) {
  return scene?.eventType === "var" || (scene?.eventType === "offside"
    && ["decision", "referee"].includes(scene?.trackingBrief?.cameraMode));
}

export function assessDecisionFraming(scene, evidence) {
  if (!isDecisionScene(scene)) return null;
  return scene.semanticVerified === true && scene.actionComplete !== false
    && evidence?.decisionFraming?.verified === true
    && Number(evidence.decisionFraming.subjectCoverage) >= 0.8
    ? { usable: true, mode: "verified_decision_framing" }
    : { usable: false, mode: "decision_subject_framing_incomplete" };
}

// Stable subject framing for decision-only shots, never gameplay.
export function repairDecisionFraming(scene, evidence, media) {
  if (!isDecisionScene(scene) || !evidence?.sourceRecords?.length) return evidence;
  const width = Math.min(1, Number(media.viewportRatio || 9 / 16) / (Number(media.width) / Number(media.height)));
  if (!(width > 0)) return evidence;
  const shots = [];
  for (const record of evidence.sourceRecords) {
    if (!shots.length || record.scene_cut) shots.push([]);
    shots.at(-1).push(record);
  }
  const frames = [];
  let visible = 0;
  for (const records of shots) {
    const tracks = new Map();
    for (const record of records) for (const person of record.players || []) {
      if (person.trackId == null || ![person.x1, person.x2, person.y1, person.y2].every(Number.isFinite)) continue;
      const track = tracks.get(person.trackId) || [];
      track.push(person); tracks.set(person.trackId, track);
    }
    const dominant = [...tracks.values()].sort((a, b) => b.length - a.length
      || (b[0].y2 - b[0].y1) - (a[0].y2 - a[0].y1))[0];
    if (!dominant?.length) return { ...evidence, decisionFraming: { verified: false, subjectCoverage: 0 } };
    const centers = dominant.map(person => (person.x1 + person.x2) / 2).sort((a, b) => a - b);
    const center = Math.max(width / 2, Math.min(1 - width / 2, centers[Math.floor(centers.length / 2)]));
    for (const [index, record] of records.entries()) {
      const subject = (record.players || []).find(person => person.trackId === dominant[0].trackId);
      const inFrame = !!subject && subject.x1 >= center - width / 2 + 0.005
        && subject.x2 <= center + width / 2 - 0.005 && subject.y1 >= 0 && subject.y2 <= 1;
      if (inFrame) visible++;
      frames.push({ time: record.time, cameraX: center, cameraY: 0.5,
        sceneCut: index === 0 ? 1 : 0, cameraCut: index === 0 ? 1 : 0,
        playerInFrame: inFrame, ballInFrame: false, directBall: false, jointFit: false });
    }
  }
  const coverage = visible / frames.length;
  return { ...evidence, keyframes: frames, annotation: [], zoom: 1, requiresJointFraming: false,
    decisionFraming: { verified: coverage >= 0.8, subjectCoverage: coverage }, cameraStepP95: 0, cameraJerkP95: 0 };
}
