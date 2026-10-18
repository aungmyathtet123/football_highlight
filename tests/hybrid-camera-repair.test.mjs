import assert from 'node:assert/strict';
import test from 'node:test';
import {cameraPlanSignature,hybridRepairScene,repairHybridCamera} from '../local-processor/hybrid-camera-repair.mjs';
import {assessHybridFraming,needsHybridOutcomeComparison,hybridPairedClockProblems,hybridComparisonFrameTimes} from '../local-processor/hybrid-framing.mjs';
import {HYBRID_TRACKING_VERSION} from '../local-processor/hybrid-tracking-policy.mjs';
import {reviewedFramingEvent} from '../local-processor/gemini-framing.mjs';

const scene={id:'any-action',eventType:'save',startTime:100,endTime:107};
const checks=[['setup',2],['contact',3.25],['flight',3.58],['payoff',3.75]].map(([phase,time])=>({phase,time,
  ballVisible:true,playerVisible:true,description:'The moving match ball and relevant player are directly visible.'}));
const review={passed:true,correctSubject:true,stableCamera:true,outcomeVisible:true,ballFollowed:true,
  setupVisible:true,contactVisible:true,ballEnteredGoal:false,keeperContactVisible:true,issues:[],
  observations:checks.map(check=>({time:check.time,description:check.description})),phaseChecks:checks,
  observedOutcome:{type:'keeper_save',time:3.75,description:'The goalkeeper visibly tips the shot over the crossbar.'}};
const evidence={provider:'hybrid-football',hybridTrackingVersion:HYBRID_TRACKING_VERSION,
  sourceStartTime:100,sourceEndTime:107,keyframes:[{time:0,cameraX:.5,cropBox:[.34,0,.66,1]},
    {time:7,cameraX:.5,cropBox:[.34,0,.66,1]}],
  sourceRecords:[{time:0,direct_ball:true,ball_x:.5,ball_y:.5,action_phase:'setup'},
    {time:7,direct_ball:false,action_phase:'payoff'}],renderReview:review};

test('a payoff lead-in cannot erase directly observed final-shot flight',()=>{
  assert.equal(assessHybridFraming(scene,evidence).usable,true);
  const unseen={...evidence,renderReview:{...review,ballFollowed:false}};
  assert.equal(assessHybridFraming(scene,unseen).usable,false);
});

test('penalty appeals and keeper collections need independent source agreement before relabeling',()=>{
  const penalty={...scene,eventType:'penalty'};
  assert.equal(reviewedFramingEvent(penalty,evidence),null);
  const paired={...evidence,outcomeComparison:{version:1,sameActionVerified:true,sourceSceneStartTime:100,
    sourceSceneEndTime:107,sourceOutcome:{eventType:'save',observedOutcome:'keeper_save',actionComplete:true,
      actionDescription:'The source shows a shot saved by the goalkeeper, with no penalty decision.'}}};
  assert.equal(reviewedFramingEvent(penalty,paired),'save');
  paired.renderReview={...review,passed:false};
  assert.equal(reviewedFramingEvent(penalty,paired),null);
});

test('a positive crop cannot contradict an independently complete source outcome',()=>{
  const paired={...evidence,outcomeComparison:{sameActionVerified:true,sourceOutcome:{actionComplete:true,observedOutcome:'wide'}}};
  assert.ok(assessHybridFraming(scene,paired).issues.includes('source_crop_outcome_disagreement'));
  assert.equal(needsHybridOutcomeComparison({eventType:'penalty'},{...review,passed:false,correctSubject:false}),true);
  assert.equal(needsHybridOutcomeComparison({eventType:'shot_off_target'},review),true);
});

test('a confident second reviewer cannot approve a different action clock',()=>{
  const conflicting={...review,phaseChecks:review.phaseChecks.map(check=>({...check,time:check.time-1.5}))};
  const problems=hybridPairedClockProblems(review,conflicting);
  assert.deepEqual(problems,['independent_contact_clock_disagreement','independent_payoff_clock_disagreement']);
  const paired={...evidence,renderReview:conflicting,outcomeComparison:{clockProblems:problems}};
  assert.equal(assessHybridFraming(scene,paired).usable,false);
});

test('independent contact stills show both disputed touches on the decoded scene clock',()=>{
  const times=hybridComparisonFrameTimes({...scene,trackingBrief:{contactTime:101.5}},review);
  assert.ok(times.includes(1.5));
  assert.ok(times.includes(3.25));
  assert.ok(times.includes(3.75));
  assert.ok(times.every(time=>time>=0&&time<7&&Math.abs(time*24-Math.round(time*24))<1e-8));
  assert.ok(hybridComparisonFrameTimes({...scene,endTime:103.76},review).every(time=>time<3.76-1/24));
});

test('repair uses observed phase times while excluding every semantic coordinate rectangle',()=>{
  const prepared=hybridRepairScene({...scene,trackingBrief:{contactTime:106,flightStartTime:101,
    actionGuide:{anchors:[{ball:[0,0,100,100]}]},goalFocusX:.9}},evidence);
  assert.equal(prepared.startTime,100);assert.equal(prepared.endTime,107);
  assert.equal(prepared.trackingBrief.contactTime,103.25);
  assert.equal(prepared.trackingBrief.flightStartTime,103.25);
  assert.equal(prepared.trackingBrief.actionGuide,undefined);
  assert.equal(prepared.trackingBrief.goalFocusX,null);
});

test('a disputed reviewer clock cannot guide the next camera repair',()=>{
  const conflicting={...review,phaseChecks:review.phaseChecks.map(check=>({...check,time:check.time-1}))};
  const prepared=hybridRepairScene(scene,{...evidence,renderReview:conflicting,initialRenderReview:review,
    outcomeComparison:{clockProblems:['independent_contact_clock_disagreement']}});
  assert.equal(prepared.trackingBrief.contactTime,103.25);
});

test('identical delivered camera paths are not rereviewed at a denser sample rate',async()=>{
  const rejected={...evidence,renderReview:{...review,passed:false}};
  let nativeCalls=0,reviewCalls=0;
  const dependencies={assess:()=>({usable:false}),track:async()=>{nativeCalls++;return {...rejected,
    keyframes:Array.from({length:71},(_,index)=>({time:index/10,cameraX:.5}))};},
    review:async()=>{reviewCalls++;throw new Error('An unchanged camera must not be rereviewed');},checkpoint:async()=>{}};
  const first=await repairHybridCamera(scene,rejected,dependencies);
  assert.equal(nativeCalls,2);assert.equal(reviewCalls,0);
  await repairHybridCamera(scene,first.evidence,dependencies);
  assert.equal(nativeCalls,2);
  assert.equal(cameraPlanSignature(scene,evidence),cameraPlanSignature(scene,await dependencies.track()));
});

test('a changed native camera needs a fresh passing review and then stops repairing',async()=>{
  let nativeCalls=0,reviewCalls=0;
  const rejected={...evidence,renderReview:{...review,passed:false}};
  const result=await repairHybridCamera(scene,rejected,{assess:(_scene,value)=>({usable:value?.renderReview?.passed===true}),
    track:async()=>{nativeCalls++;return {...evidence,keyframes:[{time:0,cameraX:.5},{time:7,cameraX:.6}]};},
    review:async(_scene,value)=>{reviewCalls++;return {...value,renderReview:review};},checkpoint:async()=>{}});
  assert.equal(result.assessment.usable,true);assert.equal(nativeCalls,1);assert.equal(reviewCalls,1);
  assert.equal(result.evidence.cameraRepairHistory[0].status,'verified');
});

test('incomplete source action stays unverified instead of looping or inventing pixels',async()=>{
  let calls=0;
  const result=await repairHybridCamera(scene,{...evidence,renderReview:{...review,passed:false},
    outcomeComparison:{sourceOutcome:{actionComplete:false}}},{assess:()=>({usable:false}),
    track:async()=>{calls++;},review:async()=>{},checkpoint:async()=>{}});
  assert.equal(calls,0);assert.equal(result.assessment.usable,false);
  assert.equal(result.reason,'source_action_unresolved');
});
