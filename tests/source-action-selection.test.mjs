import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceActionGuideWindow,selectGuidedSourceAction,verifiedSourceOutcomeCorrection} from '../local-processor/source-action-selection.mjs';
import {initialScoringCoverage} from '../local-processor/initial-section-analysis.mjs';
const scene={id:'shot',eventType:'shot_on_target',startTime:10,endTime:14,trackingBrief:{}};
const anchor=(time,phase)=>({time,phase,ball:[400,400,410,410],player:[300,380,450,420],
  goalmouth:[300,600,500,800],description:`Observed ${phase} of the attacking action`});
const observed=()=>({...sourceActionGuideWindow(scene,100),actionGuidance:{guide:{sourceType:'broadcast',
  outcome:'save',uncertainties:[],anchors:[anchor(1,'setup'),anchor(3,'contact'),anchor(5.5,'payoff')]}}});
const context={model:'model',sourceFingerprint:{sha256:'bytes',size:1234}};
test('one pre-lock observation includes context and the resolved action before splitting',()=>{
  const result=selectGuidedSourceAction(scene,observed(),context);
  assert.equal(result.scene.startTime,10);
  assert.equal(result.scene.endTime,15);
  assert.equal(result.scene.eventType,'save');
  assert.equal(result.scene.actionGuidance.guide.anchors.at(-1).time,4.5);
  assert.equal(result.scene.finalCropVerified,undefined);
  assert.equal(result.scene.trackingBrief.contactTime,12);
});

test('sparse anchors never trim away already selected buildup and follow-through',()=>{
  const value=observed();value.actionGuidance.guide.anchors=[anchor(2,'setup'),anchor(3,'contact'),anchor(4,'payoff')];
  const result=selectGuidedSourceAction(scene,value,context).scene;
  assert.equal(result.startTime,10);
  assert.equal(result.endTime,14);
  assert.equal(result.actionGuidance.sourceStartTime,10);
  assert.equal(result.actionGuidance.sourceEndTime,14);
});

test('a later replay contact cannot replace the completed first action',()=>{
  const value=observed();value.actionGuidance.guide.anchors.push(anchor(6,'contact'));
  const result=selectGuidedSourceAction(scene,value,context).scene;
  assert.ok(result);
  assert.equal(result.trackingBrief.contactTime,12);
});

test('missing sparse setup anchor retains observed initial setup, not fabricated coordinates',()=>{
  const value=observed();value.actionGuidance.guide.anchors=value.actionGuidance.guide.anchors.slice(1);
  const initial={...scene,semanticVerified:true,actionComplete:true,trackingBrief:{originTime:10},
    sourceSelectionEvidence:{observation:{initiatorAndBallVisible:true,setup:'The player receives the pass.'}}};
  const result=selectGuidedSourceAction(initial,value,context).scene;
  assert.equal(result.startTime,10);
  assert.equal(result.trackingBrief.originTime,10);
  assert.equal(result.actionGuidance.guide.anchors.filter(a=>a.phase==='setup').length,0);
  assert.equal(result.finalCropVerified,undefined);
});
test('unknown completion is not locked and an optional replay never becomes a new goal',()=>{
  let value=observed();value.actionGuidance.guide.outcome='uncertain';
  assert.equal(selectGuidedSourceAction(scene,value,context).scene,null);
  value=observed();value.actionGuidance.guide.outcome='goal';
  assert.equal(selectGuidedSourceAction(scene,value,context).reason,'optional_action_goal_context_conflict');
  assert.equal(selectGuidedSourceAction({...scene,eventType:'goal'},observed(),context).reason,'source_goal_outcome_unresolved');
});

test('authoritative complete source evidence corrects a false goal label without removing its action',()=>{
  for(const originalEventType of ['goal','disallowed_goal']) {
    const original={...scene,storyId:'corner',eventType:originalEventType,
      description:'A goal is ruled out.',analysisPurpose:'Explain the disallowed goal.',onScreenText:'NO GOAL',
      sourceSelectionEvidence:{observation:{setup:'The corner comes in.',result:'Goal ruled out.',outcome:originalEventType}}};
    const value=observed();value.actionGuidance.guide.outcome='blocked';
    const result=selectGuidedSourceAction(original,value,{...context,authoritativeOutcome:true}).scene;
    assert.equal(result.eventType,'big_chance');assert.equal(result.startTime,original.startTime);
    assert.equal(result.onScreenText,undefined);assert.equal(result.trackingBrief.payoffEvidence,null);
    assert.equal(result.sourceSelectionEvidence.observation.outcome,'big_chance');
    assert.equal(result.sourceSelectionEvidence.originalObservation.outcome,originalEventType);
    assert.ok(verifiedSourceOutcomeCorrection(result,originalEventType));
    const observation={...original,contactTime:12};
    const coverage=initialScoringCoverage([observation],[result]);
    assert.equal(coverage.complete,true);assert.equal(coverage.incidents[0].resolution,'source_outcome_corrected');
    // The corrected optional chance can be omitted in Step 1, but not by simply
    // losing the goal: its exact source-video reconciliation remains audited.
    assert.equal(initialScoringCoverage([observation],[],{resolvedCandidates:[result]}).complete,true);
    assert.equal(initialScoringCoverage([observation],[]).complete,false);
  }
});

test('uncertain or unauthoritative source checks never downgrade a scoring incident',()=>{
  const original={...scene,eventType:'disallowed_goal'};
  for(const outcome of ['blocked','save','wide','woodwork']) {
    const value=observed();value.actionGuidance.guide.outcome=outcome;
    assert.equal(selectGuidedSourceAction(original,value,context).scene,null);
    value.actionGuidance.guide.uncertainties=['The finish is hidden.'];
    assert.equal(selectGuidedSourceAction(original,value,{...context,authoritativeOutcome:true}).scene,null);
  }
  const value=observed();value.actionGuidance.guide.outcome='uncertain';
  assert.equal(selectGuidedSourceAction(original,value,{...context,authoritativeOutcome:true}).scene,null);
});

test('a reconciliation flag cannot bypass goal coverage without the exact saved complete video guide',()=>{
  const value=observed();value.actionGuidance.guide.outcome='blocked';
  const result=selectGuidedSourceAction({...scene,storyId:'corner',eventType:'disallowed_goal'},value,
    {...context,authoritativeOutcome:true}).scene;
  assert.equal(verifiedSourceOutcomeCorrection({...result,actionGuidance:undefined},'disallowed_goal'),false);
  assert.equal(verifiedSourceOutcomeCorrection({...result,endTime:result.endTime+.1},'disallowed_goal'),false);
  assert.equal(verifiedSourceOutcomeCorrection({...result,sourceOutcomeReconciliation:{
    ...result.sourceOutcomeReconciliation,authoritative:false}},'disallowed_goal'),false);
});
test('Step 2 can never trim, extend or rediscover a locked source scene',()=>{
  assert.throws(()=>sourceActionGuideWindow({...scene,selectionLocked:true},100));
  assert.throws(()=>selectGuidedSourceAction({...scene,selectionLocked:true},observed(),context));
  assert.deepEqual(sourceActionGuideWindow({...scene,startTime:.2,endTime:99.5},100),
    {...scene,startTime:0,endTime:100,sourceSceneAsset:undefined,actionGuidance:undefined});
});
