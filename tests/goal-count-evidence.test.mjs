import assert from "node:assert/strict";
import test from "node:test";
import { filterUnprovedRecoveryGoals, goalTotalFromFilename, liveGoalStoryCount,sourceGoalCountCoverage } from "../local-processor/goal-count-evidence.mjs";

test("parses explicit match scores but not dates or unlabeled numbers", () => {
  assert.equal(goalTotalFromFilename("YTDown.com_YouTube_Brentford-3-0-Chelsea-DERBY-DAY-DELIGHT.mp4"), 3);
  assert.equal(goalTotalFromFilename("Chelsea-2-2-Hull-City-HIGHLIGHTS.mp4"), 4);
  assert.equal(goalTotalFromFilename("match-2026-09-28.mp4"), null);
});

test('goal-count completeness requires source evidence, not pending labels or enough seconds',()=>{
  const goals=[1,2,3].map(n=>({id:`g${n}`,storyId:`story${n}`,eventType:'goal',semanticVerified:true,actionComplete:true}));
  assert.deepEqual(sourceGoalCountCoverage(goals,4),{expected:4,observed:3,missing:1,excess:0,complete:false});
  for(const patch of [{semanticVerified:undefined},{actionComplete:false},{sourceAngleDeferred:true},
    {goalOutcomeCrosscheck:{verified:false}},{isReplay:true}]) {
    assert.equal(sourceGoalCountCoverage([...goals,{...goals[0],id:'four',storyId:'four',...patch}],4).complete,false);
  }
  assert.equal(sourceGoalCountCoverage([...goals,{...goals[0],id:'four',storyId:'four'}],4).complete,true);
  assert.equal(sourceGoalCountCoverage([...goals,{...goals[0],id:'copy'}],4).observed,3);
  assert.equal(sourceGoalCountCoverage(goals,null).complete,true);
});

test("duration recovery cannot add a fourth goal after three live goals already match the title", () => {
  const existing = [1, 2, 3].map(n => ({ id: `goal-${n}`, storyId: `story-${n}`, eventType: "goal", semanticVerified: true, keepDecision: "keep" }));
  const recovered = [
    { id: "extra-goal", storyId: "story-4", eventType: "goal" },
    { id: "early-save", storyId: "save-1", eventType: "save" },
    { id: "known-goal-replay", storyId: "story-3", eventType: "goal", isReplay: true },
  ];
  assert.equal(liveGoalStoryCount(existing), 3);
  assert.deepEqual(filterUnprovedRecoveryGoals(existing, recovered, 3).map(moment => moment.id), ["early-save", "known-goal-replay"]);
  assert.equal(filterUnprovedRecoveryGoals(existing.slice(0, 2), recovered, 3).length, 3);
});
