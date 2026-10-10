// Automatic/adaptive edits use the natural verified evidence capacity. A short
// source must not fail merely because it cannot reach an arbitrary floor.
export const AUTO_MINIMUM_SECONDS = 0;
// Full match recaps need at least a minute of complete, distinct action.
// Step 1 must discover this evidence before tracking or voice production.
export const COMPLETE_RECAP_MINIMUM_SECONDS = 60;
export const COMPLETE_RECAP_MAXIMUM_SECONDS = Infinity;
import { assertIncidentCoverage } from "./incident-coverage.mjs";

export function automaticDurationSettings() {
  return { durationMode: "auto", targetDuration: AUTO_MINIMUM_SECONDS, durationMin: AUTO_MINIMUM_SECONDS };
}

export function adaptiveHighlightDurationBounds(sourceDuration) {
  const seconds = Math.max(0, Number(sourceDuration) || 0);
  if (seconds <= 300) return { minimum: Math.min(AUTO_MINIMUM_SECONDS, seconds), maximum: Math.min(90, seconds) };
  if (seconds <= 420) return { minimum: AUTO_MINIMUM_SECONDS, maximum: 120 };
  if (seconds <= 900) return { minimum: AUTO_MINIMUM_SECONDS, maximum: 240 };
  return { minimum: AUTO_MINIMUM_SECONDS, maximum: 300 };
}

export function completeRecapDurationBounds(sourceDuration) {
  const seconds = Math.max(0, Number(sourceDuration) || 0);
  if (!(seconds > 0)) return { minimum: COMPLETE_RECAP_MINIMUM_SECONDS, maximum: COMPLETE_RECAP_MAXIMUM_SECONDS };
  return {
    minimum: COMPLETE_RECAP_MINIMUM_SECONDS,
    maximum: Math.max(COMPLETE_RECAP_MINIMUM_SECONDS, seconds),
  };
}

// Overlapping discovery excerpts can give the same shot different story IDs
// and slightly different buildup/reaction boundaries. Compare independently
// observed contact and result clocks, not draft labels or story names. Nearby
// but distinct touches, replays at different source times and unverified
// guesses must remain separate candidates.
export function sameObservedSourceAction(a, b) {
  if (a?.semanticVerified !== true || b?.semanticVerified !== true
    || a.actionComplete !== true || b.actionComplete !== true
    || [a,b].some(scene => scene.storyPhase === 'reaction' || scene.eventType === 'celebration')) return false;
  const ranges = [a,b].map(scene => [Number(scene.startTime),Number(scene.endTime)]);
  if (ranges.some(([start,end]) => !Number.isFinite(start) || !Number.isFinite(end) || end<=start)) return false;
  const overlap = Math.min(ranges[0][1],ranges[1][1])-Math.max(ranges[0][0],ranges[1][0]);
  if (overlap < Math.min(...ranges.map(([start,end]) => end-start))*.35) return false;
  const clocks = [a,b].map((scene,index) => {
    const payoff = scene.trackingBrief?.payoffEvidence;
    const contact = scene.trackingBrief?.contactTime;
    if (payoff?.verified !== true || typeof contact !== 'number'
      || typeof payoff.startTime !== 'number' || typeof payoff.endTime !== 'number') return null;
    const [start,end] = ranges[index];
    if (![contact,payoff.startTime,payoff.endTime].every(Number.isFinite)
      || contact<start || contact>end || payoff.startTime<contact
      || payoff.endTime<payoff.startTime || payoff.endTime>end) return null;
    return {contact,start:payoff.startTime,end:payoff.endTime};
  });
  if (clocks.some(clock => !clock)) return false;
  return Math.abs(clocks[0].contact-clocks[1].contact)<=.35
    && Math.min(clocks[0].end,clocks[1].end)>=Math.max(clocks[0].start,clocks[1].start)
    && Math.abs(clocks[0].start-clocks[1].start)<=.5;
}

export function uniqueEvidenceCandidates(candidates) {
  const kept = [];
  const reaction = m => m.eventType === "celebration" || m.storyPhase === "reaction";
  const interval = m => [Number(m.startTime), reaction(m) ? Math.min(Number(m.endTime), Number(m.startTime) + 3) : Number(m.endTime)];
  // A fresh high-scoring proposal must not evict an independently reviewed
  // complete source action on retry. Importance is editorial, not evidence.
  const reviewed=m=>m.semanticVerified===true&&m.actionComplete!==false&&m.keepDecision!=='reject';
  for (const candidate of [...candidates].sort((a,b) => Number(reviewed(b))-Number(reviewed(a))
      || Number(a.semanticVerified===false)-Number(b.semanticVerified===false)
      || Number(b.importanceScore || 0) - Number(a.importanceScore || 0)
      || (b.endTime-b.startTime) - (a.endTime-a.startTime))) {
    const [start,end] = interval(candidate);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) { kept.push(candidate); continue; }
    const duplicate = kept.some(previous => {
      if (reaction(previous) !== reaction(candidate)) return false;
      if (sameObservedSourceAction(previous,candidate)) return true;
      const [a,b] = interval(previous);
      return Math.max(0, Math.min(end,b) - Math.max(start,a)) >= Math.min(end-start,b-a) * .8;
    });
    if (!duplicate) kept.push(candidate);
  }
  const ids = new Set(kept.map(m => m.id));
  return candidates.filter(m => ids.has(m.id));
}

// Capacity of unique scenes only: no synthetic replay or repeated-frame padding.
export function naturalStoryCapacity(candidates) {
  return uniqueEvidenceCandidates(candidates).reduce((total, candidate) => {
    const length = Math.max(0, Number(candidate.endTime) - Number(candidate.startTime));
    if (!Number.isFinite(length) || length <= 0) return total;
    const reaction = candidate.eventType === "celebration" || candidate.storyPhase === "reaction";
    return total + (reaction ? Math.min(3, length) : Math.min(12, length / 0.72) + 1);
  }, 0);
}

export function automaticStoryPrompt(maximumDuration = Infinity, minimumDuration = AUTO_MINIMUM_SECONDS) {
  const floorGuidance = minimumDuration > 0
    ? `Keep the finished story at or above ${minimumDuration} seconds when the evidence supports it.`
    : "Do not pad the story to reach an artificial minimum; finish at the natural length of verified evidence.";
  return [
    "Read the complete verified football observation timeline before choosing the strongest highlight story.",
    "The user has NOT chosen a duration. Choose a natural length from the best complete actions. The requested duration is a creative guide, not an exact delivery target.",
    "Prioritize complete goals, then shots on target and saves, then clear chances. Preserve setup, initiating player and ball, contact, flight, goalkeeper or goalmouth result, and same-story celebration. Finish each incident before switching stories.",
    "Choose only supplied candidateIds, without duplicates, and return them in chronological match order. Cover EVERY distinct verified goal and disallowed-goal/offside/VAR incident present in this upload. Group replay angles under their original storyId, not as extra goals. Include the same-story reaction after each valid goal. A score of 2-3 requires five distinct valid goals only if those goals are present in the upload; never fabricate absent footage.",
    Number.isFinite(maximumDuration) ? `The finished highlight must not exceed ${maximumDuration} seconds. Compress by removing downtime and redundant replay angles, never by omitting a verified goal.` : "There is no fixed maximum beyond the verified evidence capacity.",
    "Estimate the natural finished duration from the selected source intervals and concise male analysis narration. Allow purposeful contact freezes and analytical slow motion, but never static ending padding, repeated filler or unrelated play to reach a number.",
    floorGuidance,
    "Extend only when needed to cover complete mandatory incidents. Omit ordinary possession and redundant replay angles, keep celebrations concise, and complete each incident before moving to the next. Explain disallowed goals separately and do not count them toward the score. Never invent an offside verdict from an approximate drawing.",
    'Return JSON only: {candidateIds:["id"], targetDuration: number, rationale:"why these are the strongest complete actions and why this length fits"}.',
  ].join(" ");
}

export function validateAutomaticStory(raw, candidates, capacityFor = naturalStoryCapacity, maximumDuration = Infinity, minimumDuration = AUTO_MINIMUM_SECONDS) {
  const ids = Array.isArray(raw?.candidateIds) ? raw.candidateIds.map(String) : [];
  const byId = new Map(candidates.map((candidate) => [String(candidate.id), candidate]));
  if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) {
    throw new Error("Choose distinct verified candidate IDs from the supplied timeline.");
  }
  const selected = ids.map((id) => byId.get(id));
  if (selected.some((moment, index) => index > 0 && Number(moment.startTime) < Number(selected[index - 1].startTime))) {
    throw new Error("Choose candidate IDs in chronological match order.");
  }
  assertIncidentCoverage(candidates, selected);
  if (uniqueEvidenceCandidates(selected).length !== selected.length) throw new Error("Choose unique source passages; overlapping copies of one reaction or action cannot count twice.");
  const capacity = capacityFor(selected);
  const targetDuration = Number(raw.targetDuration);
  if (!Number.isFinite(targetDuration) || targetDuration < minimumDuration || targetDuration > capacity + 0.01 || targetDuration > maximumDuration + 0.01) {
    throw new Error(`Choose a natural duration of at least ${minimumDuration} seconds within the selected evidence capacity (${capacity.toFixed(1)} seconds). Select more complete actions when necessary.`);
  }
  return { candidates: selected, targetDuration: Math.round(targetDuration * 10) / 10, rationale: String(raw.rationale || "AI-selected complete highlights").slice(0, 1200) };
}
