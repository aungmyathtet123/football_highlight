// Narrow disputed physical detail, not the selected footage or goal coverage.
// A post strike and keeper save agree on a missed chance, not its mechanism.
export function narrationOutcomePolicy(moment,evidence) {
  const source=moment?.goalOutcomeCrosscheck?.review;
  const crop=evidence?.renderReview;
  const outcome=crop?.observedOutcome;
  if(!source || source.goalScored!==false || crop?.passed!==true
    || crop.ballEnteredGoal!==false || !outcome
    || ['goal','disallowed_goal'].includes(moment.eventType)) return null;
  const sourceType={save:'keeper_save',shot_off_target:'miss',shot_on_target:'on_target',big_chance:'chance'}[source.eventType];
  const cropType={keeper_save:'keeper_save',wide:'miss',over:'miss',woodwork:'woodwork',blocked:'blocked'}[outcome.type];
  if(!sourceType || !cropType || sourceType===cropType) return null;
  return {type:'non_goal_chance_result_detail_disputed',
    confirmedFacts:['An attacker takes a shot towards goal.','This chance does not produce a goal.'],
    prohibitedClaims:['keeper save','keeper touch','woodwork','post','crossbar','block','corner','exact score at this chance'],
    reason:'Independent source and crop reviews agree this is a non-goal chance but disagree on its precise mechanism.'};
}

export function outcomeNarrationProblems(beats,manifest) {
  const policies=new Map((manifest?.moments||[]).filter(moment=>moment.outcomeNarrationPolicy)
    .map(moment=>[String(moment.candidateId),moment.outcomeNarrationPolicy]));
  return (beats||[]).flatMap(beat=>{
    if(!policies.has(String(beat.evidenceNeed))) return [];
    const text=[beat.narration,beat.captionText].filter(Boolean).join(' ');
    const unsupported=/\b(?:sav(?:e[sd]?|ing)|goalposts?|posts?|crossbar|woodwork|block(?:ed|s|ing)?|corners?)\b/i.test(text)
      || /\b(?:keep[st]?|kept|remain[s]?|stays?|still|at)\s+(?:(?:it|the score|things)\s+)?\d+\s*[-–:]\s*\d+/i.test(text);
    return unsupported?[`unverified_outcome_detail:${beat.beatId}`]:[];
  });
}
