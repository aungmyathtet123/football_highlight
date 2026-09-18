import test from "node:test";
import assert from "node:assert/strict";
import { stableSignature, semanticSignature, needsSemanticReview, mergeSemanticReview, incidentManifest, rankIncidentGroups, evidenceReport, parseTrackingProgress, matchingTrackingEvidence, summarizeTracking, localRepairPriority } from "../local-processor/pipeline-state.mjs";
import { selectDirectorCandidates } from "../local-processor/editorial-policy.mjs";
import { naturalStoryCapacity, validateAutomaticStory } from "../local-processor/automatic-duration.mjs";
import { createJobQueue } from "../local-processor/job-queue.mjs";
import { restoreContentBeatOrder } from "../local-processor/pipeline-state.mjs";
import { highlightSequenceProblems } from "../local-processor/editorial-policy.mjs";
import { assertIncidentCoverage, incidentCoverage } from "../local-processor/incident-coverage.mjs";
import { tacticalFreezeAnchor } from "../local-processor/tactical-plan.mjs";

test("confirmed goal with partially visible setup receives repair without accepting absent contact", () => {
  const moment = {eventType:"goal",semanticVerified:true};
  const evidence = {cameraMaxStep:.022,goalPayoffCoverage:.91,phaseEvidence:{version:1,
    setup:{jointCoverage:.5714,directJointCoverage:.5476},contact:{directJointCoverage:.6667},flight:{samples:0}}};
  assert.ok(localRepairPriority(moment,evidence) >= 100);
  assert.equal(localRepairPriority({...moment,semanticVerified:false},evidence),-1);
  assert.equal(localRepairPriority(moment,{...evidence,phaseEvidence:{...evidence.phaseEvidence,contact:{directJointCoverage:0}}}),-1);
});

test("tactical freeze only moves within the verified contact neighborhood", () => {
  const moment={effect:"freeze_analysis",tacticalDrawing:"ball",trackingBrief:{contactTime:10.7}};
  const evidence={sourceStartTime:10,sourceRecords:[.8,.88,.96].map(time=>({time,direct_ball:true,joint_fit:true,subject_confidence:.95}))};
  assert.equal(tacticalFreezeAnchor(moment,evidence),10.8);
  assert.equal(tacticalFreezeAnchor({...moment,trackingBrief:{contactTime:10}},evidence),undefined);
});

test("calibrated tactical map uses the same verified freeze neighborhood", () => {
  const moment={effect:"freeze_analysis",tacticalDrawing:"map",trackingBrief:{contactTime:10.7}};
  const evidence={sourceStartTime:10,sourceRecords:[.8,.88,.96].map(time=>({time,direct_ball:true,joint_fit:true,subject_confidence:.95}))};
  assert.equal(tacticalFreezeAnchor(moment,evidence),10.8);
});

test("all five goals are mandatory and a replay cannot replace a missing incident", () => {
  const goals=Array.from({length:5},(_,i)=>({id:`g${i}`,storyId:`s${i}`,eventType:"goal",semanticVerified:true,
    actionComplete:true,trackingDecision:"verified_minimum_motion",keepDecision:"keep"}));
  const replay={...goals[0],id:"replay",isReplay:true};
  assert.equal(assertIncidentCoverage([...goals,replay],goals).required,5);
  assert.throws(()=>assertIncidentCoverage([...goals,replay],[...goals.slice(0,4),replay]),/missing 1/);
  assert.throws(()=>assertIncidentCoverage(goals,[...goals.slice(0,4),{...goals[4],eventType:"celebration"}]),/missing 1/);
});
test("a sole verified source replay can cover an incident only after tracking passes", () => {
  const replay={id:"only-replay",storyId:"goal-only-in-replay",eventType:"goal",semanticVerified:true,actionComplete:true,
    isReplay:true,storyPhase:"replay",keepDecision:"replay",chosenIncidentAngle:true,trackingDecision:"phase_verified_goal"};
  assert.equal(assertIncidentCoverage([replay],[replay]).covered,1);
  assert.throws(()=>assertIncidentCoverage([replay],[{...replay,trackingDecision:"incomplete_goal_action"}]),/missing 1/);
});
test("a complete native full-frame semantic action covers its incident without invented tracking markers", () => {
  const goal={id:"native",storyId:"goal-native",eventType:"goal",semanticVerified:true,actionComplete:true,
    keepDecision:"keep",trackingDecision:"native_semantic_complete_action",nativeFullFrameEvidence:true,playerHighlight:false};
  assert.equal(assertIncidentCoverage([goal],[goal]).covered,1);
});
test("a complete locally tracked replay may be the chosen angle for its own incident", () => {
  const live={id:"live",storyId:"goal-1",eventType:"goal",semanticVerified:true,keepDecision:"keep",storyPhase:"action",
    actionComplete:true,trackingDecision:"verified_minimum_motion"};
  const replay={...live,id:"replay",isReplay:true,storyPhase:"replay",keepDecision:"replay",actionComplete:true,chosenIncidentAngle:true,trackingDecision:"phase_verified_goal"};
  assert.equal(assertIncidentCoverage([live,replay],[replay]).covered,1);
  assert.throws(()=>assertIncidentCoverage([live,replay],[{...replay,trackingDecision:undefined}]),/missing 1/);
  assert.equal(assertIncidentCoverage([live,replay],[live,replay]).covered,1);
});
test("disallowed goals are covered separately and unverified hypotheses do not invent goals", () => {
  const decision={id:"d",storyId:"decision",eventType:"disallowed_goal",semanticVerified:true,actionComplete:true,
    trackingDecision:"verified_minimum_motion",keepDecision:"keep"};
  const unknown={...decision,id:"u",storyId:"unknown",eventType:"goal",semanticVerified:false};
  assert.equal(incidentCoverage([decision,unknown],[decision]).required,1);
  assert.throws(()=>assertIncidentCoverage([decision],[]),/missing 1/);
  const review={...decision,id:"review",eventType:"var"};
  assert.equal(assertIncidentCoverage([decision,review],[decision]).covered,1);
  assert.equal(assertIncidentCoverage([decision,review],[decision,review]).covered,1);
});

test("silent celebrations remain immediately after their own goals regardless of beat tags", () => {
  const beats=[{beatId:"b1",narration:"A timed finish."},{beatId:"b2",narration:"Space creates the chance."}];
  const scenes=[
    {id:"a",storyId:"a",eventType:"goal",editOrder:0,beatId:"b1",commentary:beats[0].narration},
    {id:"ar",storyId:"a",eventType:"celebration",editOrder:1,beatId:"b2"},
    {id:"b",storyId:"b",eventType:"goal",editOrder:2,beatId:"b2",commentary:beats[1].narration},
    {id:"br",storyId:"b",eventType:"celebration",editOrder:3,beatId:"b1"},
  ].map(m=>({...m,selectedForFinalVideo:true}));
  const result=restoreContentBeatOrder(scenes,beats).sort((a,b)=>a.editOrder-b.editOrder);
  assert.deepEqual(result.map(m=>m.id),["a","ar","b","br"]);
  assert.deepEqual(highlightSequenceProblems(result),[]);
  assert.equal(result[1].commentary,undefined);
  assert.equal(result[2].commentary,beats[1].narration);
});

test("duplicate retry cannot reset a job while its request is still preparing", async () => {
  const queue=createJobQueue();
  let allow, resets=0, runs=0;
  const gate=new Promise(resolve => { allow=resolve; });
  const first=queue.submit("a",async()=>{resets++;await gate;},()=>{runs++;});
  assert.equal(await queue.submit("a",()=>{resets++;},()=>{runs++;}),false);
  allow(); await first; await queue.idle();
  assert.equal(resets,1); assert.equal(runs,1); assert.equal(queue.has("a"),false);
});
test("job queue serializes work and releases reservations after execution failure", async () => {
  const queue=createJobQueue(()=>{}), order=[];
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  await queue.submit("a",()=>true,async()=>{order.push("a");await gate;throw Error("test");});
  await queue.submit("b",()=>true,()=>{order.push("b");});
  assert.equal(await queue.submit("a",()=>true,()=>{}),false);
  assert.equal(queue.has("b"),true);
  release();await queue.idle();
  assert.deepEqual(order,["a","b"]);assert.equal(queue.has("a"),false);
  assert.equal(await queue.submit("a",()=>true,()=>{}),true);await queue.idle();
});
test("failed request validation releases the job reservation without running", async () => {
  const queue=createJobQueue();let runs=0;
  assert.equal(await queue.submit("a",()=>false,()=>{runs++;}),false);
  await assert.rejects(queue.submit("a",()=>{throw Error("invalid");},()=>{runs++;}),/invalid/);
  assert.equal(queue.has("a"),false);assert.equal(runs,0);
});

const goal = { id: "goal", storyId: "incident-a", startTime: 10, endTime: 19, eventType: "goal", description: "Shot enters the net", confidence: .95, keepDecision: "keep", actionComplete: true };
test("bounded detector repairs favor near-complete evidence over impossible camera jumps", () => {
  const evidence={cameraMaxStep:.02,phaseEvidence:{version:1,setup:{jointCoverage:.9},contact:{directJointCoverage:.5},flight:{samples:3,ballCoverage:1}}};
  assert.ok(localRepairPriority({...goal,semanticVerified:true},evidence)>0);
  assert.equal(localRepairPriority({...goal,semanticVerified:true},{...evidence,cameraMaxStep:.3}),-1);
});
test("a reused candidate ID cannot attach tracking from different source seconds", () => {
  const evidence={sourceStartTime:10,sourceEndTime:19};
  const tracking={moments:{goal:evidence}};
  assert.equal(matchingTrackingEvidence(tracking,goal),evidence);
  assert.equal(matchingTrackingEvidence(tracking,{...goal,startTime:100,endTime:109}),undefined);
  assert.equal(matchingTrackingEvidence(tracking,{...goal,endTime:17}),undefined);
  assert.equal(matchingTrackingEvidence(tracking,{...goal,eventType:"celebration",endTime:13}),evidence);
});
test("merged tracking summaries include every incident with frame weighting", () => {
  const result=summarizeTracking({a:{sampledFrames:10,ballDetectionCoverage:1},b:{sampledFrames:30,ballDetectionCoverage:0}});
  assert.equal(result.sampledFrames,40);
  assert.equal(result.ballDetectionCoverage,.25);
});
test("overlapping synthetic reactions cannot inflate evidence duration", () => {
  const reaction = {...goal,id:"reaction",eventType:"celebration",startTime:19,endTime:25};
  const duplicate = {...reaction,id:"synthetic-reaction",endTime:26};
  assert.equal(naturalStoryCapacity([goal,reaction,duplicate]),naturalStoryCapacity([goal,reaction]));
  assert.equal(selectDirectorCandidates([goal,reaction,duplicate]).length,2);
  assert.throws(() => validateAutomaticStory({candidateIds:["goal","reaction","synthetic-reaction"],targetDuration:30},[goal,reaction,duplicate]),/overlapping copies/);
});
test("cached semantic approval preserves a newer framing rejection and edit settings", () => {
  const current = { ...goal, keepDecision:"reject", trackingDecision:"unstable_camera", colorGrade:"clean" };
  const merged = mergeSemanticReview(current, { ...goal, semanticVerified:true, colorGrade:"gold", trackingDecision:"strict" });
  assert.equal(merged.keepDecision,"reject");
  assert.equal(merged.trackingDecision,"unstable_camera");
  assert.equal(merged.colorGrade,"clean");
  assert.equal(mergeSemanticReview(goal, {semanticVerified:false}).keepDecision,"reject");
});
test("signatures ignore JSON key ordering", () => assert.equal(stableSignature({b:2,a:1}), stableSignature({a:1,b:2})));
test("review is reused only for unchanged event evidence", () => {
  const reviewed = {...goal, semanticVerificationVersion:8, semanticSignature:semanticSignature(goal)};
  assert.equal(needsSemanticReview(reviewed), false);
  assert.equal(needsSemanticReview({...reviewed, endTime:18}), true);
  assert.equal(needsSemanticReview({...reviewed, description:"A save"}), true);
  assert.equal(needsSemanticReview({...reviewed, colorGrade:"blue"}), false);
});
test("a semantic rejection cannot enter the director's evidence pool", () => {
  assert.equal(selectDirectorCandidates([{...goal, semanticVerified:false}]).length, 0);
});
test("incidents group replay and reaction without merging unrelated goals", () => {
  const replay = {...goal,id:"replay",isReplay:true};
  const reaction = {...goal,id:"reaction",eventType:"celebration"};
  const another = {...goal,id:"other",storyId:"incident-b"};
  const manifest = incidentManifest([goal,replay,reaction,another]);
  assert.equal(manifest.incidents.length,2);
  assert.equal(manifest.incidents[0].actions.length,1);
  assert.equal(manifest.incidents[0].replays.length,1);
  assert.equal(manifest.incidents[0].reactions.length,1);
});
test("incident priority favors goals and excludes unverified standalone celebrations", () => {
  const groups=rankIncidentGroups([{...goal,id:"save",storyId:"b",eventType:"save",importanceScore:100},goal,
    {...goal,id:"orphan",storyId:"c",eventType:"celebration"}]);
  assert.equal(groups.length,2);
  assert.equal(groups[0][0].id,"goal");
});
test("failure report distinguishes tracking repair from absent source evidence", () => {
  const report=evidenceReport([
    {...goal,keepDecision:"reject",semanticVerified:true,rejectReason:"Local framing verification: unstable_camera"},
    {...goal,id:"opening",keepDecision:"reject",semanticVerified:true,rejectReason:"Local framing verification: keyframe_opening_player_ball_not_locked"},
    {...goal,id:"contact",keepDecision:"reject",semanticVerified:true,rejectReason:"Local framing verification: keyframe_contact_keyframes_incomplete"},
    {...goal,id:"flight",keepDecision:"reject",semanticVerified:true,rejectReason:"Local framing verification: keyframe_ball_flight_keyframes_incomplete"},
  ],28.6,30);
  assert.deepEqual(report.repairable,["goal","opening","contact","flight"]);
  assert.ok(Math.abs(report.shortfall-1.4)<1e-8);
});
test("tracking progress handles chunks, malformed data, and bounded counts", () => {
  assert.equal(parseTrackingProgress("normal log"),null);
  assert.equal(parseTrackingProgress("TRACK_PROGRESS {"),null);
  assert.equal(parseTrackingProgress('TRACK_PROGRESS {"total":0,"completed":1}'),null);
  assert.equal(parseTrackingProgress('TRACK_PROGRESS {"total":3,"completed":9}').completed,3);
});
