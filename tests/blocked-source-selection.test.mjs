import test from 'node:test';
import assert from 'node:assert/strict';
import {applyBlockedSelection,blockedSelectionScenes,blockedSelectionWindow,sourceCorrectionBounds,sourceAlternateReplayBounds} from '../local-processor/blocked-source-selection.mjs';
import {fixedSceneQueue,sourceTimelineStart} from '../local-processor/fixed-scene-queue.mjs';
import {selectGuidedSourceAction} from '../local-processor/source-action-selection.mjs';
import {assessPlannedSceneTracking} from '../local-processor/editorial-policy.mjs';

const box=[100,100,140,140];
const anchor=(time,phase)=>({time,phase,ball:box,player:[200,200,500,400],
  goalmouth:[100,50,450,350],description:`Visible ${phase} with moving match ball`});
const scene={id:'goal-1',storyId:'same-goal',startTime:10,endTime:15,eventType:'goal',
  selectionLocked:true,sceneSelectionApproved:true,fixedSceneQueueVersion:1,
  semanticVerified:true,actionComplete:true,chosenIncidentAngle:true};
const replay={selectionStart:20,selectionEnd:24,selectionReason:'Replay shows the same header and goal line crossing.',
  selectedReplay:true,sameIncidentVerified:true,
  guide:{sourceType:'broadcast',outcome:'goal',uncertainties:[],anchors:[
    anchor(20.2,'setup'),anchor(21,'contact'),anchor(21.7,'flight'),anchor(23,'payoff')]}};
const context={model:'vision',sourceFingerprint:{size:123,hash:'test'}};

test('blocked goal search includes its immediate replay',()=>{
  const window=blockedSelectionWindow(scene,[{startTime:9,endTime:15},{startTime:20,endTime:24}],100);
  assert.equal(window.startTime,8);
  assert.equal(window.endTime,45);
});

test('coordinate correction reviews only the proposed action with context',()=>{
  const window={startTime:330,endTime:372};
  assert.deepEqual(sourceCorrectionBounds(window,{selectionStart:28.25,selectionEnd:31.75}),
    {startTime:27.75,endTime:32.25});
  assert.equal(sourceCorrectionBounds(window,{selectionStart:null,selectionEnd:31.75}),null);
});

test('a repeated goal replay is excluded from the next camera search',()=>{
  const prior={...scene,startTime:358.25,endTime:361.75,
    sourceReselection:{selectedReplay:true,previousStart:336.5,previousEnd:341.608}};
  const bounds=sourceAlternateReplayBounds(prior,{startTime:334.5,endTime:371.608});
  assert.equal(bounds.startTime,27.75);
  assert.ok(Math.abs(bounds.endTime-37.108)<1e-6);
});

test('a complete matched replay preserves the goal incident and its original edit order',()=>{
  const replacement=applyBlockedSelection(scene,{startTime:0,endTime:40},replay,context);
  assert.equal(replacement.eventType,'goal');
  assert.equal(replacement.isReplay,true);
  assert.equal(replacement.storyId,scene.storyId);
  assert.equal(replacement.sourceReselection.previousStart,10);
  assert.equal(sourceTimelineStart(replacement),10);
  const reaction={id:'reaction-1',storyId:'same-goal',startTime:15,endTime:18,
    eventType:'celebration',selectionLocked:true,fixedSceneQueueVersion:1};
  assert.deepEqual(fixedSceneQueue([reaction,replacement]).scenes.map(item=>item.id),['goal-1','reaction-1']);
});

test('a replay cannot silently replace a different goal',()=>{
  assert.throws(()=>applyBlockedSelection(scene,{startTime:0,endTime:40},
    {...replay,sameIncidentVerified:false},context),/independently match/);
  assert.throws(()=>applyBlockedSelection(scene,{startTime:0,endTime:55},
    {...replay,selectionStart:48,selectionEnd:52,guide:{...replay.guide,
      anchors:replay.guide.anchors.map(item=>({...item,time:item.time+28}))}},context),/immediately after/);
});

test('reselecting a failed replay searches from the original live incident and keeps edit order',()=>{
  const first=applyBlockedSelection(scene,{startTime:0,endTime:40},replay,context);
  const window=blockedSelectionWindow(first,[{startTime:9,endTime:15},
    {startTime:20,endTime:24},{startTime:25,endTime:28}],100);
  assert.equal(window.startTime,8);
  assert.equal(window.endTime,45);
  const identical={...replay,selectionStart:12,selectionEnd:16,
    guide:{...replay.guide,anchors:replay.guide.anchors.map(item=>({...item,time:item.time-8}))}};
  assert.throws(()=>applyBlockedSelection(first,window,identical,context),/repeats the independently rejected/);
  const tinyShift={...replay,selectionStart:12.125,selectionEnd:16.25,
    guide:{...replay.guide,anchors:replay.guide.anchors.map(item=>({...item,time:item.time-7.875}))}};
  assert.throws(()=>applyBlockedSelection(first,window,tinyShift,context),/repeats the independently rejected/);
  const next={...replay,selectionStart:17,selectionEnd:20,
    guide:{...replay.guide,anchors:replay.guide.anchors.map(item=>({...item,time:item.time-3}))}};
  const replacement=applyBlockedSelection(first,window,next,context);
  assert.equal(replacement.sourceReselection.previousStart,10);
  assert.equal(sourceTimelineStart(replacement),10);
  const mislabeled=applyBlockedSelection(first,window,{...next,selectedReplay:false},context);
  assert.equal(mislabeled.isReplay,true);
  assert.equal(mislabeled.sourceReselection.replayInferredFromVerifiedTimeline,true);
  assert.equal(mislabeled.sourceReselection.selectedReplayClaim,false);
});

test('a keeper collecting a pass cannot be certified as a shot save',()=>{
  const old={...scene,id:'pass-1',eventType:'save'};
  const guide={sourceType:'broadcast',outcome:'save',uncertainties:[],anchors:[
    anchor(.5,'setup'),{...anchor(1,'contact'),description:'Player crosses the ball into the area.'},
    anchor(2,'flight'),{...anchor(3,'payoff'),description:'Goalkeeper gathers the through pass ahead of the striker.'}]};
  assert.throws(()=>applyBlockedSelection(old,{startTime:10,endTime:20},{
    selectionStart:0,selectionEnd:5,selectionReason:'The original through pass is fully visible.',
    selectedReplay:false,sameIncidentVerified:false,guide},context),
  /claims a shot save without observed shooting contact/);
});

test('a goalkeeper collection alone cannot establish a shot save',()=>{
  const old={...scene,id:'keeper-collection',eventType:'save'};
  const guide={sourceType:'broadcast',outcome:'save',uncertainties:[],anchors:[
    anchor(.5,'setup'),{...anchor(1,'contact'),description:'Goalkeeper dives to collect the loose ball.'},
    anchor(2,'flight'),{...anchor(3,'payoff'),description:'Goalkeeper smothers and holds the ball.'}]};
  assert.throws(()=>applyBlockedSelection(old,{startTime:10,endTime:20},{
    selectionStart:0,selectionEnd:5,selectionReason:'The keeper collection is fully visible.',
    selectedReplay:false,sameIncidentVerified:false,guide},context),
  /claims a shot save without observed shooting contact/);
});

test('a saved crop cannot approve a source guide that contradicts its save label',()=>{
  const pass={...scene,id:'pass-locked',eventType:'save',actionGuidance:{guide:{
    sourceType:'broadcast',outcome:'save',uncertainties:[],anchors:[
      anchor(.5,'setup'),{...anchor(1,'contact'),description:'Player passes the ball into the box.'},
      anchor(2,'flight'),{...anchor(3,'payoff'),description:'Goalkeeper gathers the ball before a shot.'}]}}};
  const evidence={finalCropVerified:true,geometryVerified:true,sourceStartTime:10,sourceEndTime:15};
  assert.equal(assessPlannedSceneTracking(pass,evidence).usable,false);
  assert.deepEqual(blockedSelectionScenes([pass],{moments:{'pass-locked':evidence}}).map(item=>item.id),['pass-locked']);
});

test('a corrected pass may reuse the same verified source interval',()=>{
  const old={...scene,id:'pass-locked',eventType:'save',
    sourceReselection:{version:6,previousStart:10,previousEnd:15}};
  const guide={sourceType:'broadcast',outcome:'pass',uncertainties:[],anchors:[
    anchor(10.5,'setup'),{...anchor(11,'contact'),description:'Player passes into the box.'},
    anchor(12,'flight'),{...anchor(13,'payoff'),description:'Goalkeeper gathers the through pass.'}]};
  const result=applyBlockedSelection(old,{startTime:0,endTime:40},{
    selectionStart:10,selectionEnd:15,selectionReason:'The complete pass is visible in the same camera view.',
    selectedReplay:false,sameIncidentVerified:false,guide},context);
  assert.equal(result.eventType,'normal_play');
  assert.equal(result.sourceReselection.previousStart,10);
});

test('verified through pass corrects a provisional save label and stale narration facts',()=>{
  const old={id:'pass-1',storyId:'pass-story',startTime:10,endTime:15,eventType:'save',
    semanticVerified:true,actionComplete:true,selectionLocked:false,
    analysisPurpose:'Goalkeeper saves a shot',completionReason:'Saved shot',
    sourceSelectionEvidence:{observation:{setup:'Attack starts',continuation:'Shot',result:'Save',outcome:'save'}},
    trackingBrief:{originTime:10,payoffEvidence:{verified:true},goalFocusX:.1}};
  const guide={sourceType:'broadcast',outcome:'pass',uncertainties:[],anchors:[
    anchor(.5,'setup'),anchor(1,'contact'),anchor(2,'flight'),anchor(3,'payoff')]};
  const result=selectGuidedSourceAction(old,{startTime:10,endTime:15,
    actionGuidance:{guide}},context).scene;
  assert.equal(result.eventType,'normal_play');
  assert.equal(result.sourceSelectionEvidence.observation.outcome,'normal_play');
  assert.equal(result.sourceSelectionEvidence.originalObservation.outcome,'save');
  assert.equal(result.completionReason,guide.anchors[3].description);
  assert.equal(result.trackingBrief.payoffEvidence,null);
});
