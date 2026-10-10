import { narrationSlotBudgets } from './completed-video-narration.mjs';

// One authoritative, output-clock writing packet. Detector boxes, confidence
// rows, research URLs, duplicate discovery descriptions and overlay settings
// do not help a writer and must not compete with approved crop observations.
export function compactNarrationEvidence(manifest, contract, identityBindings = []) {
  const reviewed = new Map((manifest.moments || []).map(scene => [String(scene.candidateId), scene]));
  const budgets = new Map(narrationSlotBudgets(contract).map(slot => [slot.candidateId, slot]));
  const identities = new Map(identityBindings.map(binding => [String(binding.storyId), binding]));
  return {
    version: 1,
    selectedDuration: contract.selectedDuration,
    clockSource: manifest.clockSource || 'rendered_video',
    completedVideoRendered: Boolean(manifest.completedVideoRendered),
    timingRule: 'Output windows are exact. Word budgets are guidance, not targets to pad. Never change pictures, timing, scene IDs or order.',
    moments: contract.slots.map(slot => {
      const scene = reviewed.get(slot.candidateId);
      if (!scene) throw new Error(`Missing reviewed narration scene ${slot.candidateId}.`);
      const budget = budgets.get(slot.candidateId);
      const identity = scene.verifiedIdentity || identities.get(String(scene.storyId));
      const verifiedIdentity = identity ? Object.fromEntries(
        ['scorer', 'assister', 'goalkeeper', 'team', 'opponentTeam'].filter(key =>
          typeof identity[key] === 'string' && identity[key].trim()).map(key => [key, identity[key]])) : null;
      const seen = new Set();
      const observations = (scene.cropObservations || []).filter(observation => {
        const key = JSON.stringify([observation.phase, observation.sceneLocalTime, observation.description]);
        if (seen.has(key)) return false;
        seen.add(key); return true;
      }).map(({ phase, sceneLocalTime, description, timingUnspecified }) =>
        ({ phase, sceneLocalTime, description, ...(timingUnspecified ? { timingUnspecified: true } : {}) }));
      return {
        candidateId: slot.candidateId, storyId: scene.storyId, role: slot.role, eventType: scene.eventType,
        source: scene.source, output: { startTime: slot.startTime, endTime: slot.endTime },
        suggestedWords: budget.suggestedWords, maximumSuggestedWords: budget.maximumSuggestedWords,
        phaseMap: scene.phaseMap,
        verifiedIdentity: verifiedIdentity && Object.keys(verifiedIdentity).length ? verifiedIdentity : null,
        identityPolicy: 'use_only_this_binding_otherwise_role_only',
        ...(observations.length ? { cropObservations: observations } : { visualClaim: scene.visualClaim }),
        narrationEvidencePolicy: scene.narrationEvidencePolicy,
        ...(scene.outcomeNarrationPolicy ? { outcomeNarrationPolicy: scene.outcomeNarrationPolicy } : {}),
      };
    }),
  };
}
