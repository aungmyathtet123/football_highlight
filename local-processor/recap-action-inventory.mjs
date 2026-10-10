import {SCORE_ACTION_SCHEMA,validScoreActionDraft} from './score-action-schema.mjs';
export const RECAP_ACTION_INVENTORY_VERSION=5;
export const RECAP_EXTRA_EVENTS=['save','shot_on_target','shot_off_target','big_chance','tackle','free_kick','normal_play','assist','dribble'];
// Independent review can honestly correct a provisional "save" to a useful
// completed passing passage. Keep that observed buildup eligible as a reserve
// instead of silently discarding it solely because its event label changed.
export function verifiedRecapBuildUp(scene) {
  const brief=scene?.trackingBrief,phases=brief?.requiredSubjectsByPhase;
  return scene?.sourceAdditionalAction===true && ['normal_play','assist','dribble'].includes(scene.eventType)
    && scene.semanticVerified===true && scene.actionComplete===true && scene.keepDecision!=='reject'
    && scene.ballVisible!==false && scene.mainPlayerVisible!==false
    && Number(scene.visualClarity||0)>=70
    && Array.isArray(scene.semanticNarrationFacts)&&scene.semanticNarrationFacts.length>=2
    // Some honest observers describe a set-piece release under flight rather
    // than adding a duplicate contact entry. The observed contact CLOCK is
    // mandatory; the phase-array spelling must not discard a complete action.
    && Array.isArray(phases)&&['setup','payoff'].every(phase=>phases.some(value=>value.phase===phase
      && value.subjects?.includes('ball')))
    && ['originTime','contactTime','payoffEndTime'].every(key=>Number.isFinite(brief[key])
      && brief[key]>=scene.startTime&&brief[key]<=scene.endTime)
    && brief.originTime<brief.contactTime&&brief.contactTime<brief.payoffEndTime;
}
export const RECAP_EXTRA_SCHEMA=structuredClone(SCORE_ACTION_SCHEMA);
const item=RECAP_EXTRA_SCHEMA.properties.moments.items;
item.properties.eventType.enum=RECAP_EXTRA_EVENTS;
item.properties.storyId={type:'string'};
item.properties.visualClarity={type:'number',minimum:0,maximum:100};
item.properties.narrativeCompleteness={type:'number',minimum:0,maximum:100};
item.required.push('storyId','visualClarity','narrativeCompleteness');

export function validRecapExtraDraft(draft,duration) {
  return validScoreActionDraft(draft,duration) && draft.moments.every(scene=>
    RECAP_EXTRA_EVENTS.includes(scene.eventType) && typeof scene.storyId==='string' && scene.storyId.trim()
    && typeof scene.actionComplete==='boolean' && typeof scene.isReplay==='boolean');
}
export function normalizeRecapExtraDraft(draft) {
  return Array.isArray(draft)&&draft.length===1?draft[0]:draft;
}
export function recapExtraDraftProblems(draft,duration) {
  if(!Array.isArray(draft?.moments)||!Array.isArray(draft?.uncertainties)) return ['missing_inventory_object'];
  return draft.moments.flatMap((scene,index)=>{
    const prefix=`scene-${index+1}`;
    const issues=[];
    if(!Number.isFinite(scene.startTime)||!Number.isFinite(scene.endTime)||scene.startTime<0
      ||scene.endTime<=scene.startTime||scene.endTime>duration+.05) issues.push(`${prefix}:invalid_excerpt_local_clock`);
    if(!validRecapExtraDraft({moments:[scene],uncertainties:[]},duration)) issues.push(`${prefix}:invalid_scene_metadata`);
    return issues;
  });
}

export function recapExtraPrompt(excerpt,shots,knownIncidents=[],budget=null) {
  return [
    `Watch this complete football excerpt for DISTINCT NON-GOAL opportunities. Source ${excerpt.startTime}-${excerpt.startTime+excerpt.duration}s. Read the burnt-in excerpt LOCAL clock, not the broadcast match clock. All returned times, including trackingBrief times, are excerpt-local seconds 0-${excerpt.duration}.`,
    'Find the strongest shots on target, important goalkeeper saves, big chances, close misses, shot-blocking tackles and last-ditch stops. Include complete attacking combinations, progressive carries, defended attacks and set-piece clearances when they support a specific tactical explanation. Idle possession, repeated replays and long VAR discussions are not useful extra actions.',
    'For each incident choose ONE clearest complete source camera view, live or a genuine replay, not both. Prefer a stable uninterrupted wide view showing the initiating player AND football, pass/shot contact, moving ball and completed keeper/goal-mouth/defensive result. Do not invent a save or describe a goal as a saved shot. Never cut before the result, and never return a celebration as action.',
    'Build a broad inventory for a match recap of AT LEAST 60 seconds after ALL excerpts are combined. Inventory every useful distinct completed action in this excerpt, not eight angles of one incident; there is no eight-incident ceiling. Do not demand 60 seconds from each excerpt. Include useful attacking combinations, dangerous defended attacks and close chances as well as spectacular saves. Preserve the meaningful buildup through the result, rather than extracting only the final kick. Return fewer or zero when the pixels do not support them. Keep each chosen passage at its natural normal-speed duration; no padding or artificial 5-second cut.',
    budget?`All-source planning target ${budget.plannedSeconds.toFixed(1)} seconds including a verification reserve. This section's proportional observation budget is ${Number(excerpt.requestedSeconds||0).toFixed(1)} seconds. Count its known goals toward the budget, then inventory enough other complete actions when available. This is NOT a hard quota: sections with more useful action may supply more; sections with no action may supply zero. Scan every measured camera shot before returning.`: '',
    'Use a shared storyId for alternatives of the SAME chance, and different storyIds for different chances. Mark genuine replays accurately. A saved shot is one incident, not a separate shot plus separate save. No player/team names; identities are researched later.',
    `Already-discovered scoring/overturned incidents in excerpt-local time: ${JSON.stringify(knownIncidents)}. Do NOT return these goals, their buildup, replays or overturned finish under a non-goal label.`,
    `Measured source camera shots in excerpt-local time: ${JSON.stringify(shots)}. Choose clear complete views; timestamps must remain inside the shown footage.`,
    'Return the supplied JSON schema. actionComplete is true only when setup, contact, flight/continuation and outcome are visible. trackingBrief must describe those phases and a verified payoffEvidence from the actual pixels. Add uncertainties rather than inventing unobserved action. importanceScore and visualClarity are 0-100; confidence is numeric 0-1.',
  ].join(' ');
}

// Broaden distinct verified action selection when a duration request needs it;
// never satisfy that request with uncertain footage or overlapping copies.
export function selectRecapExtraActions(candidates,maximum=12,minimumSeconds=0) {
  const extra=candidates.filter(scene=>scene.sourceAdditionalAction===true && scene.sourceAngleSelected===true
    && scene.semanticVerified===true && scene.actionComplete===true && scene.keepDecision!=='reject'
    && (RECAP_EXTRA_EVENTS.includes(scene.eventType)||verifiedRecapBuildUp(scene))
    && Number(scene.visualClarity||scene.importanceScore||0)>=55);
  const priority=scene=>({save:5,shot_on_target:5,big_chance:4,tackle:3,shot_off_target:2}[scene.eventType]||0);
  extra.sort((a,b)=>priority(b)-priority(a)
    || Number(b.visualClarity||0)-Number(a.visualClarity||0)
    || Number(b.importanceScore||0)-Number(a.importanceScore||0)
    || Number(a.startTime)-Number(b.startTime));
  const selected=new Set();
  const intervals=[];
  const addInterval=scene=>{
    const start=Number(scene.startTime),end=Number(scene.endTime);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start) return;
    intervals.push([start,end]);
  };
  const coveredSeconds=()=>{
    const sorted=[...intervals].sort((a,b)=>a[0]-b[0]);
    let total=0,end=-Infinity;
    for(const [start,finish] of sorted) {
      total+=Math.max(0,finish-Math.max(start,end));end=Math.max(end,finish);
    }
    return total;
  };
  candidates.filter(scene=>scene.sourceAdditionalAction!==true && scene.semanticVerified===true
    && scene.keepDecision!=='reject' && !scene.sourceAngleDeferred && !scene.sourceSupportDeferred).forEach(addInterval);
  for(const scene of extra) {
    if(selected.size>=maximum && coveredSeconds()>=minimumSeconds) break;
    selected.add(scene.id);addInterval(scene);
  }
  return candidates.map(scene=>scene.sourceAdditionalAction!==true?scene:{...scene,
    sourceExtraSelected:selected.has(scene.id),sourceAngleDeferred:!selected.has(scene.id)});
}
