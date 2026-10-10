// Search missing source intervals as short excerpts. A whole-video second pass
// tends to repeat the same headline goals and miss brief saves or chances.
import { sourceScoreCoverage } from './source-score-ledger.mjs';
import {sourceGoalCountCoverage} from './goal-count-evidence.mjs';
export const GOAL_RECOVERY_LOOKBACK_SECONDS = 90;

export function durationOnlyRecovery(ledger, candidates, expectedGoalTotal=null) {
  return Boolean(ledger?.anchors?.some(anchor => anchor.status !== 'reversed'))
    && sourceScoreCoverage(ledger, candidates).missing.length === 0
    && sourceGoalCountCoverage(candidates,expectedGoalTotal).complete;
}

export function durationRecoveryWindowLimit(missingSeconds) {
  return Math.min(4, Math.max(1, Math.ceil(Math.max(0, Number(missingSeconds) || 0) / 15)));
}

// These are overlapping search previews, not limits on selected action scenes.
// Keep every source second while bounding inline request size.
export function boundedRecoveryWindows(windows, sourceDuration, { maximumSeconds = 42, overlapSeconds = 10 } = {}) {
  const end = Number(sourceDuration);
  if (!Number.isFinite(end) || end <= 0) return [];
  const maximum = Number.isFinite(maximumSeconds) ? Math.max(2, maximumSeconds) : 42;
  const overlap = Number.isFinite(overlapSeconds) ? Math.max(0, Math.min(maximum - 2, overlapSeconds)) : 10;
  const result = new Map();
  for (const window of Array.isArray(windows) ? windows : []) {
    const startTime = Math.max(0, Math.min(end, Number(window.startTime)));
    const endTime = Math.max(0, Math.min(end, Number(window.endTime)));
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime - startTime < 2) continue;
    for (let start = startTime; start < endTime; start += maximum - overlap) {
      const finish = Math.min(endTime, start + maximum);
      result.set(`${start.toFixed(3)}:${finish.toFixed(3)}`, { startTime: start, endTime: finish });
      if (finish === endTime) break;
    }
  }
  return [...result.values()].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
}

export function coverageCandidateState(moment) {
  if (moment.keepDecision === 'reject' || moment.semanticVerified === false) return 'rejected';
  if (moment.semanticVerified === true && moment.actionComplete !== false
    && !moment.sourceAngleDeferred && !moment.sourceSupportDeferred
    && moment.goalOutcomeCrosscheck?.verified !== false) return 'verified';
  return 'pending';
}

export function scenesNeedingCoverageRecovery(rejectedScenes, missingDuration = 0) {
  return (Array.isArray(rejectedScenes) ? rejectedScenes : []).filter(scene =>
    Number(missingDuration) > .05 || ['goal','disallowed_goal'].includes(scene.eventType));
}

export function goalRecoveryWindow(startTime, endTime, sourceDuration, tail = 8) {
  return {startTime:Math.max(0, Number(startTime)-GOAL_RECOVERY_LOOKBACK_SECONDS),
    endTime:Math.min(Number(sourceDuration), Number(endTime)+tail)};
}

// A multi-goal score jump may cover a misclassified chance, not an empty gap.
// Inspect that source context first, even when short prior clips were approved.
// Score context proposes windows only; it never changes an observed outcome.
export function goalCountRecoveryWindows(candidates,ledger,duration,searchedWindows=[],limit=4) {
  const priorities=boundedRecoveryWindows((ledger?.unresolved||[]).map(window=>({
    startTime:Math.max(0,window.startTime-10),endTime:Math.min(duration,window.endTime+10)})),duration);
  const fresh=priorities.filter(window=>{
    let cursor=window.startTime,total=0;
    for(const prior of [...searchedWindows].sort((a,b)=>a.startTime-b.startTime)) {
      const start=Math.max(cursor,prior.startTime),end=Math.min(window.endTime,prior.endTime);
      if(end>start){total+=end-start;cursor=end;}
    }
    return total<(window.endTime-window.startTime)*.85;
  });
  if(fresh.length)return fresh.slice(0,limit);
  return coverageRecoveryWindows(candidates,duration,{limit,minimumGap:4,contextSeconds:2,searchedWindows});
}

export function coverageRecoveryWindows(candidates, duration, { minimumGap = 8, maximumWindow = 42, limit = 4, contextSeconds = 0, searchedWindows = [] } = {}) {
  const end = Math.max(0, Number(duration) || 0);
  const covered = (Array.isArray(candidates) ? candidates : [])
    // A proposal is not coverage. Counting unreviewed/deferred intervals here
    // hid precisely the footage that a duration shortfall needed to inspect.
    .filter(moment => coverageCandidateState(moment) === 'verified')
    .map(moment => ({ startTime: Math.max(0, Number(moment.startTime)), endTime: Math.min(end, Number(moment.endTime)) }))
    .filter(interval => Number.isFinite(interval.startTime) && Number.isFinite(interval.endTime) && interval.endTime > interval.startTime)
    .sort((a, b) => a.startTime - b.startTime);
  const gaps = [];
  const firstCovered=covered[0]?.startTime ?? end;
  const lastCovered=covered.at(-1)?.endTime ?? 0;
  let cursor = 0;
  for (const interval of covered) {
    if (interval.startTime - cursor >= minimumGap) gaps.push({ startTime: cursor, endTime: interval.startTime });
    cursor = Math.max(cursor, interval.endTime);
  }
  if (end - cursor >= minimumGap) gaps.push({ startTime: cursor, endTime: end });
  const windows = gaps.flatMap(gap => {
    const chunks = Math.ceil((gap.endTime - gap.startTime) / maximumWindow);
    const length = (gap.endTime - gap.startTime) / chunks;
    return Array.from({ length: chunks }, (_, index) => ({
      startTime: Math.max(0, gap.startTime + index * length - (index ? 1.5 : 0)),
      endTime: Math.min(end, gap.startTime + (index + 1) * length + (index < chunks - 1 ? 1.5 : 0)),
      uncoveredSeconds: length,
      // Interior gaps are between observed football passages. Do not let a
      // long unobserved full-time/outro tail win solely because it is longer.
      interior:gap.startTime>=firstCovered && gap.endTime<=lastCovered,
      leading:covered.length>0 && gap.startTime<firstCovered,
    }));
  });
  // A completed negative search is evidence too. Do not repeatedly query the
  // same gap just because no new approved scene was returned there.
  const searched = searchedWindows.filter(w => Number.isFinite(w.startTime) && Number.isFinite(w.endTime))
    .sort((a,b)=>a.startTime-b.startTime);
  const fresh = windows.filter(window => {
    let cursor=window.startTime, observed=0;
    for(const previous of searched) {
      const start=Math.max(cursor,previous.startTime), finish=Math.min(window.endTime,previous.endTime);
      if(finish>start) {observed+=finish-start;cursor=finish;}
    }
    return observed < (window.endTime-window.startTime)*.85;
  });
  return fresh.sort((a, b) => Number(b.interior||b.leading)-Number(a.interior||a.leading)
      || b.uncoveredSeconds - a.uncoveredSeconds || a.startTime - b.startTime)
    .slice(0, limit).sort((a, b) => a.startTime - b.startTime)
    .map(({ startTime, endTime }) => ({ startTime:Math.max(0,startTime-Math.max(0,contextSeconds)),
      endTime:Math.min(end,endTime+Math.max(0,contextSeconds)) }));
}

export function isDurationRecoveryAction(scene) {
  return scene?.storyPhase!=='reaction' && ['save','shot_on_target','shot_off_target',
    'big_chance','tackle','normal_play','assist','dribble','skill','free_kick','foul','penalty'].includes(scene?.eventType);
}
