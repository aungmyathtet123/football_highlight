export const FRAMING_PREFLIGHT_VERSION = 1;
const goal = scene => ['goal', 'disallowed_goal'].includes(scene.eventType);
const story = scene => String(scene.storyId || scene.id);

// Consume actual crop reviews, not predicted editability or semantic confidence.
// This runs before source selection is locked. A bad angle cannot erase its goal.
export function resolveFramingPreflight(candidates, usable, quality = new Map()) {
  const checked = candidates.filter(scene => scene.selectionLocked === true);
  const required = new Set(checked.filter(goal).map(story));
  const winners = new Map();
  for (const scene of checked.filter(scene => goal(scene) && usable.get(String(scene.id)) === true)) {
    const previous = winners.get(story(scene));
    const rank = value => Number(value.sourceAngleSelected === true) * 1e6 + Number(quality.get(String(value.id)) || 0);
    if (!previous || rank(scene) > rank(previous)) winners.set(story(scene), scene);
  }
  const missing = [...required].filter(id => !winners.has(id));
  const scenes = candidates.map(scene => {
    if (scene.selectionLocked !== true) return { ...scene, selectionLocked: false };
    const passed = usable.get(String(scene.id)) === true;
    const chosen = passed && (!goal(scene) || winners.get(story(scene))?.id === scene.id);
    return { ...scene, selectionLocked: false, sceneSelectionApproved: chosen,
      sourceFramingPreflightVersion: FRAMING_PREFLIGHT_VERSION, sourceFramingVerified: passed,
      sourceFramingRejected: !passed, sourceAngleDeferred: !chosen,
      ...(goal(scene) ? { sourceAngleSelected: chosen, sourceAngleReserved: passed && !chosen,
        chosenIncidentAngle: chosen } : {}),
      selectionDecision: chosen ? 'portrait_verified_before_selection_lock'
        : passed ? 'verified_same_incident_backup' : 'angle_rejected_before_selection_lock' };
  });
  return { candidates: scenes, report: { version: FRAMING_PREFLIGHT_VERSION,
    checked: checked.length, approved: scenes.filter(scene => scene.sceneSelectionApproved).length,
    missingIncidents: missing,
    rejectedAngles: checked.filter(scene => usable.get(String(scene.id)) !== true)
      .map(scene => ({ id: scene.id, storyId: story(scene), reason: scene.trackingRepairError || scene.trackingDecision })) } };
}
