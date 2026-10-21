// Independent discovery/decision context, NEVER proof of contact or ball position.
// Sample timing locates a search window; the complete action still needs pixels.
export const SCORE_LEDGER_VERSION = 2;
export const SCORE_BINDING_VERSION = 1;
const validScore = value => Number.isInteger(value) && value >= 0 && value <= 20;
const scoreKey = sample => `${sample.homeGoals}:${sample.awayGoals}`;
const ledgerOwnershipKey=ledger=>JSON.stringify((ledger?.anchors||[]).map(anchor=>
  ({id:anchor.id,status:anchor.status,before:anchor.before,after:anchor.after})));
export function normalizeScoreSamples(samples, expectedIds) {
  if (!Array.isArray(samples) || samples.length !== expectedIds.length
    || new Set(samples.map(sample=>String(sample.sampleId))).size !== expectedIds.length
    || samples.some(sample=>!expectedIds.includes(String(sample.sampleId))))
    throw new Error('Source score observation did not cover the exact sample IDs.');
  return expectedIds.map(sampleId=>{
    const sample=samples.find(item=>String(item.sampleId)===sampleId);
    const readable=sample.readable===true && validScore(sample.homeGoals) && validScore(sample.awayGoals)
      && typeof sample.homeLabel==='string' && sample.homeLabel.trim()
      && typeof sample.awayLabel==='string' && sample.awayLabel.trim();
    return {sampleId,readable:Boolean(readable),homeGoals:readable?sample.homeGoals:null,
      awayGoals:readable?sample.awayGoals:null,homeLabel:String(sample.homeLabel||''),
      awayLabel:String(sample.awayLabel||''),matchClock:String(sample.matchClock||'')};
  });
}
function clockSeconds(text) {
  const match=String(text).match(/^(\d{1,3}):(\d{2})(?:\s*\+\s*(\d{1,2})(?::(\d{2}))?)?$/);
  return match?Number(match[1])*60+Number(match[2])+(Number(match[3])||0)*60+(Number(match[4])||0):null;
}
export function buildSourceScoreLedger(samples,duration,interval=10) {
  const readable=[];
  for (const sample of samples) {
    if (!sample.readable || !validScore(sample.homeGoals) || !validScore(sample.awayGoals)) continue;
    const time=sample.time ?? (Number(sample.sampleId)-1)*interval;
    if (!Number.isFinite(time)||time<0||time>duration) continue;
    const clock=clockSeconds(sample.matchClock),previous=readable.at(-1);
    // Replayed earlier scorebugs must not undo the actual live score.
    if (clock!=null && previous?.clock!=null && clock<previous.clock-2) continue;
    readable.push({...sample,time,clock});
  }
  const anchors=[],unresolved=[];
  for (let index=1;index<readable.length;index++) {
    const before=readable[index-1],after=readable[index];
    if (scoreKey(before)===scoreKey(after)) continue;
    const home=after.homeGoals-before.homeGoals,away=after.awayGoals-before.awayGoals;
    if ((home===1&&away===0)||(away===1&&home===0)) {
      anchors.push({id:`score-incident-${anchors.length+1}`,side:home?'home':'away',
        status:'provisional',before:{time:before.time,homeGoals:before.homeGoals,awayGoals:before.awayGoals},
        after:{time:after.time,homeGoals:after.homeGoals,awayGoals:after.awayGoals},
        startTime:Math.max(0,before.time-20),endTime:Math.min(duration,after.time+20)});
    } else if ((home===-1&&away===0)||(away===-1&&home===0)) {
      const prior=[...anchors].reverse().find(anchor=>anchor.status!=='reversed'
        && anchor.side===(home===-1?'home':'away')
        && anchor.after.homeGoals===before.homeGoals&&anchor.after.awayGoals===before.awayGoals);
      if (prior) {prior.status='reversed';prior.reversalTime=after.time;
        prior.endTime=Math.min(duration,after.time+10);}
      else unresolved.push({startTime:before.time,endTime:after.time,reason:'unmatched_score_reversal'});
    } else unresolved.push({startTime:before.time,endTime:after.time,reason:'multiple_or_inconsistent_score_change'});
  }
  // No zero-score opening => this may be an excerpt. Do not infer missing goals.
  const startsAtZero=readable.length>=3 && readable[0].homeGoals===0&&readable[0].awayGoals===0;
  return {version:SCORE_LEDGER_VERSION,duration,interval,readable,anchors,unresolved,
    completeScoreHistory:startsAtZero&&unresolved.length===0,
    finalObservedScore:readable.length?{home:readable.at(-1).homeGoals,away:readable.at(-1).awayGoals}:null};
}
export function scoreAnchorForScene(scene,ledger) {
  // Search windows deliberately overlap so discovery does not miss buildup.
  // They are NOT incident ownership boundaries. In short highlight uploads a
  // new goal's setup can start inside the previous goal's search window.
  const anchors=[...(ledger?.anchors||[])].filter(anchor=>Number.isFinite(anchor?.before?.time)
    && Number.isFinite(anchor?.after?.time)).sort((a,b)=>a.after.time-b.after.time);
  if (!anchors.length) return undefined;
  const ownership=scene.sourceScoreOwnershipEvidence;
  if(ownership?.version===1&&ownership.ledgerKey===ledgerOwnershipKey(ledger)
    && ownership.anchorId===scene.sourceScoreAnchorId&&scene.semanticVerified===true
    &&scene.actionComplete===true&&scene.eventType==='goal'&&!scene.isReplay&&scene.storyPhase!=='replay'
    &&ownership.sourceStartTime===scene.startTime&&ownership.sourceEndTime===scene.endTime) {
    const owned=anchors.find(anchor=>anchor.id===ownership.anchorId&&anchor.status!=='reversed');
    if(owned) return owned;
  }
  if (scene.sourceScoreObservation === true && scene.sourceScoreAnchorId
    && (scene.isReplay === true || scene.storyPhase === 'replay')) {
    const linked=anchors.find(anchor=>anchor.id===scene.sourceScoreAnchorId
      && scene.startTime>=anchor.startTime&&scene.endTime<=anchor.endTime+.05);
    if (linked) return linked;
  }
  if (scene.isReplay === true || scene.storyPhase === 'replay') return undefined;
  const start=Number(scene.startTime),end=Number(scene.endTime);
  const payoff=scene.trackingBrief?.payoffEvidence;
  const clocks=[payoff?.verified===true?payoff.startTime:undefined,
    scene.semanticVerified===true?scene.trackingBrief?.payoffStartTime:undefined,
    scene.trackingBrief?.contactTime];
  const clock=clocks.find(value=>typeof value==='number'&&Number.isFinite(value)&&value>=start&&value<=end);
  const matches=anchors.filter((anchor,index)=>{
    const previous=anchors[index-1];
    const searchStart=Number.isFinite(anchor.startTime)?anchor.startTime:Math.max(0,anchor.before.time-20);
    const lower=Math.max(searchStart,previous?.after.time??-Infinity);
    // A score already read at the previous sample belongs to that previous
    // incident. A later observed finish cannot be reassigned backwards merely
    // because its setup overlaps. Allow only floating-point clock noise.
    if (clock!==undefined) return clock>=lower && (!previous||clock>previous.after.time+.001)
      && clock<=anchor.after.time+.001;
    // No phase clock: accept only an unambiguous interval wholly inside one
    // ownership window. Broad crossing intervals require source observation.
    return start>=lower && end<=anchor.after.time+.001;
  });
  return matches.length===1?matches[0]:undefined;
}

// Coarse scoreboard samples are search context, not exact goal-line clocks.
// When a complete coherent score history and all distinct pixel-verified live
// goals agree, match those actual incidents one-to-one in source order. This
// resolves a finish exactly on a sample without assigning two goals to one
// change. Never create an incident from score/count alone or fill missing goals.
export function verifiedLiveGoalOwnership(candidates,ledger) {
  const anchors=[...(ledger?.anchors||[])].sort((a,b)=>a.after.time-b.after.time);
  if(ledger?.completeScoreHistory!==true||!anchors.length||anchors.some(anchor=>anchor.status==='reversed')) return new Map();
  const goals=candidates.filter(scene=>scene.selectionLocked!==true&&scene.eventType==='goal'
    &&scene.semanticVerified===true&&scene.actionComplete===true&&scene.keepDecision!=='reject'
    &&!scene.isReplay&&scene.storyPhase!=='replay'
    &&scene.trackingBrief?.payoffEvidence?.verified===true
    &&Number.isFinite(scene.trackingBrief.payoffEvidence.startTime)
    &&scene.trackingBrief.payoffEvidence.startTime>=scene.startTime
    &&scene.trackingBrief.payoffEvidence.startTime<=scene.endTime)
    .sort((a,b)=>a.startTime-b.startTime);
  const groups=[];
  for(const goal of goals) {
    const group=groups.find(values=>values.some(other=>
      Math.min(goal.endTime,other.endTime)-Math.max(goal.startTime,other.startTime)>.1));
    if(group) group.push(goal);else groups.push([goal]);
  }
  if(groups.length!==anchors.length) return new Map();
  const assignments=new Map(),ledgerKey=ledgerOwnershipKey(ledger);
  for(let index=0;index<groups.length;index++) {
    const anchor=anchors[index],group=groups[index];
    if(group.some(scene=>scene.trackingBrief.payoffEvidence.startTime<anchor.startTime
      ||scene.trackingBrief.payoffEvidence.startTime>anchor.endTime)) return new Map();
    for(const scene of group) assignments.set(scene.id,{anchor,evidence:{version:1,ledgerKey,
      anchorId:anchor.id,anchorOrder:index,verifiedLiveGoalCount:groups.length,
      sourceStartTime:scene.startTime,sourceEndTime:scene.endTime,
      sourcePayoffTime:scene.trackingBrief.payoffEvidence.startTime}});
  }
  return assignments;
}

// Rebind the complete inventory BEFORE ranking/removing alternate views.
// Replay source time is not match time: use its linked/preceding observed live
// action, never the score printed while the replay happens to be shown.
export function bindSourceScoreCandidates(candidates,ledger) {
  if (!ledger?.anchors?.length) return candidates;
  candidates=candidates.map(scene=>scene.selectionLocked!==true
    && scene.sourceScoreBindingVersion===SCORE_BINDING_VERSION
    && scene.semanticVerified===true && scene.actionComplete===true
    && scene.goalOutcomeCrosscheck?.corrected===true
    && ['save','shot_on_target','shot_off_target','big_chance'].includes(scene.eventType)
    ? {...scene,storyId:`source-chance-${scene.id}`,sourceAdditionalAction:true,
      sourceScoreObservation:false,sourceScoreAnchorId:undefined,sourceScoreBindingVersion:undefined,
      correctedSourceScoreAnchorId:scene.sourceScoreAnchorId,
      sourceAngleSelected:undefined,sourceAngleDeferred:false,sourceExtraSelected:undefined}
    : scene);
  const apply=(scene,anchor)=>{
    if (!anchor) return scene;
    const changed=scene.sourceScoreAnchorId!==anchor.id || scene.storyId!==anchor.id;
    const duplicateReject=changed && scene.semanticVerified===true
      && scene.selectionDecision==='removed_duplicate_incident_view';
    const eventType=['goal','disallowed_goal'].includes(scene.eventType)&&anchor.status==='reversed'
      ?'disallowed_goal':scene.eventType;
    return {...scene,storyId:anchor.id,sourceScoreAnchorId:anchor.id,sourceScoreBindingVersion:SCORE_BINDING_VERSION,eventType,
      ...(duplicateReject?{keepDecision:scene.isReplay?'replay':'keep',rejectReason:undefined,
        selectionDecision:undefined,sceneSelectionApproved:false,selectionLocked:false}:{}),
      ...(scene.trackingBrief?{trackingBrief:{...scene.trackingBrief,
        ...(scene.trackingBrief.payoffEvidence?{payoffEvidence:{...scene.trackingBrief.payoffEvidence,eventType}}:{})}}:{})};
  };
  const owned=verifiedLiveGoalOwnership(candidates,ledger);
  const live=candidates.map(scene=>['goal','disallowed_goal'].includes(scene.eventType)
    && !scene.isReplay&&scene.storyPhase!=='replay'
    ? owned.has(scene.id)?{...apply(scene,owned.get(scene.id).anchor),sourceScoreOwnershipEvidence:owned.get(scene.id).evidence}
      :apply(scene,scoreAnchorForScene(scene,ledger)):scene);
  const observed=live.filter(scene=>['goal','disallowed_goal'].includes(scene.eventType)
    && !scene.isReplay&&scene.storyPhase!=='replay'&&scene.semanticVerified===true&&scene.actionComplete===true
    && scene.keepDecision!=='reject'&&scene.sourceScoreBindingVersion===SCORE_BINDING_VERSION)
    .sort((a,b)=>a.startTime-b.startTime);
  return live.map(scene=>{
    const replay=scene.isReplay===true||scene.storyPhase==='replay';
    const reaction=scene.eventType==='celebration'||scene.storyPhase==='reaction';
    if (!replay&&!reaction) return scene;
    const explicit=observed.find(goal=>goal.id===scene.linkedGoalCandidateId);
    const nearby=[...observed].reverse().find(goal=>scene.startTime>=goal.endTime-(reaction?.5:.1)
      && scene.startTime-goal.endTime<=12);
    const goal=nearby||explicit;
    if (!goal) return scene;
    const anchor=ledger.anchors.find(item=>item.id===goal.sourceScoreAnchorId);
    return {...apply(scene,anchor),...(replay?{linkedGoalCandidateId:goal.id}:{}),
      sourceScoreLinkedCandidateId:goal.id};
  });
}
export function contradictsStableLiveScore(scene,ledger) {
  if (!ledger?.completeScoreHistory || scene.isReplay || scene.storyPhase==='replay'
    || scene.eventType!=='goal' || scoreAnchorForScene(scene,ledger)) return false;
  const before=[...ledger.readable].reverse().find(sample=>sample.time<=scene.startTime);
  const after=ledger.readable.find(sample=>sample.time>=scene.endTime);
  return Boolean(before&&after&&scene.startTime-before.time<=25&&after.time-scene.endTime<=25
    && before.clock!=null&&after.clock!=null&&after.clock>before.clock&&scoreKey(before)===scoreKey(after));
}

// Negative scoreboard context helps an independent observer distinguish a
// miss/save from a phantom goal. It never supplies a ball path or a verdict.
export function stableLiveScoreContext(scene,ledger,{minimumAfterGap=0}={}) {
  if (!ledger?.completeScoreHistory || scene.isReplay || scene.storyPhase==='replay') return null;
  // A sample just inside the setup is still useful negative context when the
  // last pre-boundary scorebug was unreadable. It is NOT a rejection verdict.
  const contact=Number(scene.trackingBrief?.contactTime);
  const setupEnd=Number.isFinite(contact) && contact>scene.startTime
    ? Math.min(scene.startTime+1,contact-.25) : scene.startTime;
  const before=[...ledger.readable].reverse().find(sample=>sample.time<=setupEnd);
  // The discovery search can overlap an earlier missed chance. Inspect its
  // own nearby score context even if the broad search supplied a later anchor.
  // A caller may allow a scoreboard-update delay after a genuine finish.
  const after=ledger.readable.find(sample=>sample.time>=scene.endTime+minimumAfterGap);
  if (!before || !after || scene.startTime-before.time>25 || after.time-scene.endTime>25
    || before.clock==null || after.clock==null || after.clock<=before.clock
    || scoreKey(before)!==scoreKey(after)) return null;
  return {status:'unchanged',before,after,
    evidencePolicy:'Unchanged score is context only. Reobserve the real ball; do not invent a save or disallowed-goal reason.'};
}
export function sourceScoreCoverage(ledger,candidates) {
  const incidents=(ledger?.anchors||[]).map(anchor=>{
    const matches=candidates.filter(scene=>scene.semanticVerified===true&&scene.actionComplete===true
      && scene.keepDecision!=='reject'
      && ((!scene.isReplay&&scene.storyPhase!=='replay') || scene.sourceAngleSelected===true)
      && ['goal','disallowed_goal'].includes(scene.eventType)
      && scoreAnchorForScene(scene,ledger)?.id===anchor.id);
    const requiredType=anchor.status==='reversed'?'disallowed_goal':'goal';
    return {id:anchor.id,requiredType,required:anchor.status!=='reversed',covered:matches.some(scene=>scene.eventType===requiredType),
      candidateIds:matches.map(scene=>scene.id),startTime:anchor.startTime,endTime:anchor.endTime};
  });
  return {version:SCORE_LEDGER_VERSION,incidents,
    missing:incidents.filter(incident=>incident.required&&!incident.covered),
    optionalMissing:incidents.filter(incident=>!incident.required&&!incident.covered)};
}
