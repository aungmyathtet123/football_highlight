import test from 'node:test';
import assert from 'node:assert/strict';
import {applyBlockedSelection,blockedSelectionWindow} from '../local-processor/blocked-source-selection.mjs';
import {fixedSceneQueue,sourceTimelineStart} from '../local-processor/fixed-scene-queue.mjs';
import {selectGuidedSourceAction} from '../local-processor/source-action-selection.mjs';

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
  assert.equal(window.endTime,40);
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
  assert.throws(()=>applyBlockedSelection(scene,{startTime:0,endTime:50},
    {...replay,selectionStart:43,selectionEnd:47,guide:{...replay.guide,
      anchors:replay.guide.anchors.map(item=>({...item,time:item.time+23}))}},context),/immediately after/);
});

test('reselecting a failed replay searches from the original live incident and keeps edit order',()=>{
  const first=applyBlockedSelection(scene,{startTime:0,endTime:40},replay,context);
  const window=blockedSelectionWindow(first,[{startTime:9,endTime:15},
    {startTime:20,endTime:24},{startTime:25,endTime:28}],100);
  assert.equal(window.startTime,8);
  assert.equal(window.endTime,40);
  const identical={...replay,selectionStart:12,selectionEnd:16,
    guide:{...replay.guide,anchors:replay.guide.anchors.map(item=>({...item,time:item.time-8}))}};
  assert.throws(()=>applyBlockedSelection(first,window,identical,context),/repeats the independently rejected/);
  const next={...replay,selectionStart:17,selectionEnd:20,
    guide:{...replay.guide,anchors:replay.guide.anchors.map(item=>({...item,time:item.time-3}))}};
  const replacement=applyBlockedSelection(first,window,next,context);
  assert.equal(replacement.sourceReselection.previousStart,10);
  assert.equal(sourceTimelineStart(replacement),10);
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
