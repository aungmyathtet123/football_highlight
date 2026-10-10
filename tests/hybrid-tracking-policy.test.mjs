import assert from 'node:assert/strict';
import test from 'node:test';
import { HYBRID_TRACKING_VERSION, hybridDetectorScene, providerEvidenceMatches } from '../local-processor/hybrid-tracking-policy.mjs';
import { reviewedFramingEvent } from '../local-processor/gemini-framing.mjs';
import { assessHybridFraming } from '../local-processor/hybrid-framing.mjs';

test('a hybrid run never reuses Gemini-generated camera coordinates', () => {
  const oldVisualRepair = {
    provider: 'gemini-vision', hybridVisualRepairVersion: HYBRID_TRACKING_VERSION,
    finalCropVerified: true,
  };
  assert.equal(providerEvidenceMatches('hybrid', oldVisualRepair), false);
  assert.equal(providerEvidenceMatches('gemini', oldVisualRepair), true);
});

test('a hybrid run accepts only current native tracker evidence', () => {
  assert.equal(providerEvidenceMatches('hybrid', {
    provider: 'hybrid-football', hybridTrackingVersion: HYBRID_TRACKING_VERSION,
  }), true);
  assert.equal(providerEvidenceMatches('hybrid', {
    provider: 'hybrid-football', hybridTrackingVersion: HYBRID_TRACKING_VERSION - 1,
  }), false);
});

test('the detector scene excludes unverified semantic coordinate hints', () => {
  const source = { id: 'initial-1-1', recommendedCrop: [{x: .9}], actionGuidance: {
    sourceFingerprint: 'source', model: 'model', guide: {anchors: []},
  }, trackingBrief: {
    contactTime: 5.7, actionGuide: {anchors: [{ball: [1, 2, 3, 4]}]},
    initialBallFocusX: .9, shotDestination: {targetBox: [0, 0, 1, 1]},
    goalFocusX: .9, payoffEvidence: {verified: true},
  }};
  const tracked = hybridDetectorScene(source);
  assert.equal(tracked.recommendedCrop, undefined);
  assert.equal(tracked.trackingBrief.contactTime, 5.7);
  for (const key of ['actionGuide', 'initialBallFocusX', 'shotDestination']) {
    assert.equal(tracked.trackingBrief[key], undefined);
  }
  assert.equal(tracked.trackingBrief.goalFocusX, null);
  assert.equal(tracked.trackingBrief.payoffEvidence, null);
  assert.deepEqual(source.recommendedCrop, [{x: .9}]);
});

test('a verified portrait review can correct a selected save to a shot wide', () => {
  const scene = {eventType:'save',startTime:26.5,endTime:33.7};
  const evidence = {renderReview:{passed:true,correctSubject:true,stableCamera:true,
    ballFollowed:true,setupVisible:true,contactVisible:true,outcomeVisible:true,
    ballEnteredGoal:false,issues:[],observedOutcome:{type:'wide',time:6.42,
      description:'The moving ball passed outside the post.'}}};
  assert.equal(reviewedFramingEvent(scene,evidence),'shot_off_target');
});

test('a locked goal can be corrected to a directly observed keeper save', () => {
  const scene={eventType:'goal',selectionLocked:true,startTime:20,endTime:27,
    trackingBrief:{contactTime:24,flightStartTime:24.1,payoffStartTime:25.2}};
  const evidence={provider:'hybrid-football',hybridTrackingVersion:HYBRID_TRACKING_VERSION,
    keyframes:[],renderReview:{passed:true,correctSubject:true,stableCamera:true,
      ballFollowed:true,setupVisible:true,contactVisible:true,outcomeVisible:true,
      ballEnteredGoal:false,keeperContactVisible:true,issues:[],
      observedOutcome:{type:'keeper_save',time:5.4,
        description:'The keeper visibly deflects the moving match ball away from goal.'},
      observations:[{time:1,description:'The carrier approaches the area.'},
        {time:5.4,description:'The keeper blocks the shot.'}],
      phaseChecks:[{phase:'setup',time:1,ballVisible:true,playerVisible:true,description:'Carrier with ball.'},
        {phase:'contact',time:4,ballVisible:true,playerVisible:true,description:'Shot contact.'},
        {phase:'flight',time:4.5,ballVisible:true,playerVisible:true,description:'Ball follows shot.'},
        {phase:'payoff',time:5.4,ballVisible:true,playerVisible:true,description:'Keeper deflects ball.'}]}};
  assert.equal(reviewedFramingEvent(scene,evidence),'save');
});

test('a timed-out finish review cannot approve an earlier provisional verdict', () => {
  const assessment=assessHybridFraming({eventType:'goal',selectionLocked:true,
    startTime:20,endTime:27},{provider:'hybrid-football',
    hybridTrackingVersion:HYBRID_TRACKING_VERSION,
    reviewRepairError:'Finish review unavailable (timeout); outcome unverified.',
    renderReview:{passed:true,observedOutcome:{type:'keeper_save',time:5}}});
  assert.equal(assessment.usable,false);
  assert.equal(assessment.mode,'hybrid_review_unavailable');
});
