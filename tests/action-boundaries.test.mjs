import test from "node:test";
import assert from "node:assert/strict";
import {alignGoalToShot,linkImmediateGoalReplays,trimToVerifiedActionOrigin} from "../local-processor/action-boundaries.mjs";
const goal={eventType:"goal",startTime:208,endTime:214.5,semanticVerified:true,
  trackingBrief:{originTime:209.8,contactTime:212.2,payoffEndTime:214.2}};
const shots=[{startTime:203.76,endTime:209.68},{startTime:209.68,endTime:214.56}];
test("remove earlier camera segment while retaining complete scoring action",()=>{
  const corrected=alignGoalToShot(goal,shots);
  assert.equal(corrected.startTime,209.68);
  assert.equal(corrected.endTime,214.5);
  assert.equal(corrected.semanticVerified,undefined);
  assert.equal(corrected.keepDecision,"keep");
  assert.equal(alignGoalToShot(corrected,shots),corrected);
});
test("never trim through setup, contact or result",()=>{
  for(const moment of [{...goal,trackingBrief:{...goal.trackingBrief,originTime:209}},
    {...goal,trackingBrief:{...goal.trackingBrief,payoffEndTime:215}}]) assert.equal(alignGoalToShot(moment,shots),moment);
});
test("remove unrelated lead-in within the same source shot",()=>{
  const sameShot={...goal,startTime:433,endTime:440,
    trackingBrief:{originTime:435.6,contactTime:437.8,payoffEndTime:440}};
  const corrected=alignGoalToShot(sameShot,[{startTime:433,endTime:440.1}]);
  assert.equal(corrected.startTime,434.4);
  assert.equal(corrected.boundaryCorrection.reason,"preceding_footage_before_action_origin");
  assert.equal(corrected.semanticVerified,undefined);
});
test("late semantic action origin removes empty pre-roll without unlocking the scene",()=>{
  const locked={...goal,id:"late-origin",startTime:302.6,endTime:315.65,selectionLocked:true,
    trackingDecision:"full_bleed_repaired",trackingBrief:{originTime:313.2,contactTime:315.65,payoffEndTime:315.65}};
  const corrected=trimToVerifiedActionOrigin(locked);
  assert.equal(corrected.startTime,312);
  assert.equal(corrected.endTime,315.65);
  assert.equal(corrected.selectionLocked,true);
  assert.equal(corrected.trackingDecision,undefined);
  assert.equal(corrected.boundaryCorrection.reason,"verified_action_origin_after_semantic_review");
});
test("trim replay to its verified payoff and keep reaction as a separate scene",()=>{
  const replay={...goal,id:"goal-replay",isReplay:true,startTime:217,endTime:226.5,
    trackingBrief:{...goal.trackingBrief,originTime:219.4,contactTime:221.9,payoffEndTime:223.5}};
  const corrected=alignGoalToShot(replay,[{startTime:217,endTime:223.667},{startTime:223.667,endTime:226.5}]);
  assert.equal(corrected.startTime,219.3);
  assert.equal(corrected.endTime,224.15);
  assert.equal(corrected.boundaryCorrection.reason,"preceding_footage_before_action_origin");
  assert.equal(corrected.semanticVerified,undefined);
});test("immediate replay cannot become a second required goal",()=>{
  const live={...goal,id:"live",storyId:"incident-1",startTime:209.68,endTime:214.5,
    semanticVerified:true,keepDecision:"keep",trackingDecision:"phase_verified_goal"};
  const replay={...goal,id:"later-hypothesis",storyId:"hallucinated-incident",startTime:217,endTime:226.5,
    semanticVerified:true,keepDecision:"reject",trackingDecision:"incomplete_goal_action"};
  const linked=linkImmediateGoalReplays([live,replay]);
  assert.equal(linked[1].storyId,"incident-1");
  assert.equal(linked[1].isReplay,true);
  assert.equal(linked[1].storyPhase,"replay");
  assert.equal(linked[1].keepDecision,"reject");
});
test("a later restarted-match goal remains a distinct incident",()=>{
  const live={...goal,id:"live",storyId:"incident-1",semanticVerified:true,keepDecision:"keep"};
  const later={...goal,id:"later",storyId:"incident-2",startTime:225,endTime:230,semanticVerified:true,keepDecision:"keep"};
  assert.equal(linkImmediateGoalReplays([live,later])[1].storyId,"incident-2");
});
test("a cross-chunk replay and its reaction inherit the preceding live goal",()=>{
  const live={...goal,id:"live",storyId:"incident-1",startTime:140,endTime:153.28,
    semanticVerified:true,keepDecision:"keep",trackingDecision:"phase_verified_goal"};
  const reaction={id:"reaction",storyId:"chunk-2-story",eventType:"celebration",storyPhase:"reaction",
    startTime:178.16,endTime:181.16,semanticVerified:true,keepDecision:"support"};
  const replay={...goal,id:"replay",storyId:"chunk-2-story",storyPhase:"replay",isReplay:true,
    startTime:183.32,endTime:189.67,semanticVerified:true,keepDecision:"replay"};
  const linked=linkImmediateGoalReplays([live,reaction,replay]);
  assert.equal(linked.find(moment=>moment.id==="replay").storyId,"incident-1");
  assert.equal(linked.find(moment=>moment.id==="reaction").storyId,"incident-1");
});
test("a replay-only story remains independent when no preceding live goal exists",()=>{
  const replay={...goal,id:"replay",storyId:"earlier-incident",storyPhase:"replay",isReplay:true,
    startTime:20,endTime:28,semanticVerified:true,keepDecision:"replay"};
  assert.equal(linkImmediateGoalReplays([replay])[0].storyId,"earlier-incident");
});
test("aligns one complete action across consecutive broadcast shots",()=>{
  const multiShot={...goal,startTime:100,endTime:111,
    trackingDecision:"keyframe_opening_player_ball_not_locked",
    trackingBrief:{originTime:103,contactTime:105.2,payoffEndTime:109.4}};
  const corrected=alignGoalToShot(multiShot,[
    {startTime:100,endTime:104},{startTime:104,endTime:107},{startTime:107,endTime:111},
  ]);
  assert.equal(corrected.startTime,101.8);
  assert.equal(corrected.endTime,110.55);
  assert.equal(corrected.boundaryCorrection.shotCount,3);
});
test("separates a player-only reaction shot from the following replay action",()=>{
  const replay={...goal,id:"merged-reaction-replay",isReplay:true,storyPhase:"replay",startTime:326.4,endTime:335.88,
    trackingBrief:{originTime:326.4,contactTime:332.5,payoffEndTime:335}};
  const corrected=alignGoalToShot(replay,[
    {startTime:326.4,endTime:330.56},{startTime:330.56,endTime:331.08},
    {startTime:331.08,endTime:331.36},{startTime:331.36,endTime:333.64},{startTime:333.64,endTime:335.88},
  ]);
  assert.equal(corrected.startTime,331.36);
  assert.equal(corrected.trackingBrief.originTime,331.36);
  assert.equal(corrected.boundaryCorrection.reason,"preceding_footage_before_action_origin");
});
