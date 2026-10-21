// A score embedded between two team names is useful independent evidence for
// a complete-match upload. Do not interpret dates or free-floating numbers as
// scores. Missing/unreliable filenames return null and add no constraint.
export function goalTotalFromFilename(name) {
  const match = String(name || "").match(/(?:^|[\s_.-])([\p{L}][\p{L}\p{N}]+)[\s_-]+(\d{1,2})[\s_-]+(\d{1,2})[\s_-]+([\p{L}][\p{L}\p{N}]+)/u);
  if (!match) return null;
  const home = Number(match[2]), away = Number(match[3]);
  return home <= 15 && away <= 15 ? home + away : null;
}

// A source replay can be the clearest main view of one observed goal. Keep its
// replay provenance, but do not lose that incident's research/narration identity
// after the portrait editor chooses it instead of the difficult live view.
export function verifiedPrimaryReplayGoal(moment) {
  return moment?.eventType==='goal' && moment.chosenIncidentAngle===true
    && (Boolean(moment.sourceScoreAnchorId)||moment.sourceSelectionEvidence?.provider==='gemini_initial_section_video') && moment.semanticVerified===true
    && moment.actionComplete===true && moment.trackingPassed===true && moment.keepDecision!=='reject';
}

export function liveGoalStoryCount(candidates, { lockedOnly = false, verifiedOnly = false } = {}) {
  return new Set((Array.isArray(candidates) ? candidates : [])
    .filter(moment => moment.eventType === "goal" && moment.keepDecision !== "reject"
      && ((!moment.isReplay && moment.storyPhase !== "replay")
        || moment.sourceAngleSelected === true && moment.semanticVerified === true
          && (moment.sourceScoreAnchorId||moment.sourceSelectionEvidence?.provider==='gemini_initial_section_video'))
      && (!lockedOnly || moment.selectionLocked === true)
      && (!verifiedOnly || moment.semanticVerified === true && moment.actionComplete === true
        && !moment.sourceAngleDeferred && !moment.sourceSupportDeferred
        && moment.goalOutcomeCrosscheck?.verified !== false))
    .map(moment => String(moment.storyId || moment.id))).size;
}

// A partial scorebug ledger locates some goals; it does not prove that all
// goals from an explicitly scored upload were discovered. Draft labels never
// satisfy this gate. Evaluate it before committing the immutable Step-2 lock.
export function sourceGoalCountCoverage(candidates, expected) {
  const observed = liveGoalStoryCount(candidates, {verifiedOnly:true});
  return {expected,observed,missing:expected==null?0:Math.max(0,expected-observed),
    excess:expected==null?0:Math.max(0,observed-expected),complete:expected==null||observed===expected};
}

export function filterUnprovedRecoveryGoals(existing, recovered, expectedGoalTotal) {
  const existingGoalStories = new Set((Array.isArray(existing) ? existing : [])
    .filter(moment => moment.eventType === "goal" && moment.keepDecision !== "reject"
      && moment.semanticVerified === true && !moment.isReplay && moment.storyPhase !== "replay")
    .map(moment => String(moment.storyId || moment.id)));
  if (expectedGoalTotal == null || existingGoalStories.size < expectedGoalTotal) return recovered;
  return (Array.isArray(recovered) ? recovered : []).filter(moment => moment.eventType !== "goal"
    || existingGoalStories.has(String(moment.storyId || moment.id)));
}
