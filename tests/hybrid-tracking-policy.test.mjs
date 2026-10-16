import assert from 'node:assert/strict';
import test from 'node:test';
import { HYBRID_TRACKING_VERSION, hybridDetectorScene, providerEvidenceMatches } from '../local-processor/hybrid-tracking-policy.mjs';
import { reviewedFramingEvent } from '../local-processor/gemini-framing.mjs';
import { assessHybridFraming, sourceContainEvidence, hybridCropReviewRequest, hybridActionReviewContract, reviewedHybridPhaseBrief, needsHybridOpeningDetail, applyHybridOpeningDetail, mergeHybridOutcomeReview, hybridGeometry } from '../local-processor/hybrid-framing.mjs';

test('a faster portrait pan needs sustained native flight and still retains the ball',()=>{
  const scene={startTime:0,endTime:1,trackingBrief:{contactTime:.1,payoffStartTime:.3,payoffEndTime:1}};
  const records=Array.from({length:5},(_,index)=>({time:index*.1,ball_x:.4+index*.045,ball_y:.5,
    direct_ball:true,action_phase:'flight',scene_cut:false}));
  const keyframes=records.map(record=>({cameraX:record.ball_x,cropBox:[record.ball_x-.158,0,record.ball_x+.158,1]}));
  const evidence={sourceRecords:records,keyframes};
  assert.equal(hybridGeometry(scene,evidence).usable,false);
  const measured={...evidence,sourceRecords:records.map(record=>({...record,
    ball_observation_method:'camera_compensated_motion',motion_track_samples:10}))};
  assert.equal(hybridGeometry(scene,measured).usable,true);
  measured.sourceRecords[2].ball_x=.05;
  assert.ok(hybridGeometry(scene,measured).violations.includes('observed_ball_outside_safe_crop'));
});

test('a finish excerpt preserves independently observed setup inside its time window',()=>{
  const setup={phase:'setup',time:.5,ballVisible:true,playerVisible:true,
    description:'Incoming ball and eventual header player are jointly visible.'};
  const earlier={passed:true,correctSubject:true,stableCamera:true,outcomeVisible:true,
    ballFollowed:true,setupVisible:true,contactVisible:true,ballEnteredGoal:false,
    observations:[],issues:[],phaseChecks:[setup]};
  const finish={passed:true,correctSubject:true,stableCamera:true,outcomeVisible:true,
    ballFollowed:true,contactVisible:true,ballEnteredGoal:false,keeperContactVisible:false,
    observations:[],issues:[],observedOutcome:{type:'wide',time:1.75,description:'Ball passes outside the post.'},
    phaseChecks:[{phase:'contact',time:.75,ballVisible:true,playerVisible:true,description:'The header contact is visible.'}]};
  const merged=mergeHybridOutcomeReview(earlier,finish,{start:.25,end:2.25});
  assert.deepEqual(merged.phaseChecks.find(check=>check.phase==='setup'),setup);
  assert.equal(merged.passed,true);
  assert.equal(mergeHybridOutcomeReview({...earlier,setupVisible:false},finish,{start:.25,end:2.25}).passed,false);
});

test('finishing setup follows the eventual scorer and incoming ball', () => {
  const contract=hybridActionReviewContract({eventType:'goal'});
  assert.match(contract,/eventual shooter or header player with the incoming moving match ball BEFORE/);
  assert.match(contract,/earlier assister or cross taker may be off-screen/);
  assert.match(contract,/clip beginning at or after decisive contact still fails setup/);
});

test('football action families use their own visible resolution', () => {
  for (const eventType of ['assist','free_kick','skill','dribble','tackle','normal_play']) {
    const contract=hybridActionReviewContract({eventType});
    assert.match(contract,/NON-FINISHING football action/);
    assert.doesNotMatch(contract,/eventual shooter or header player/);
  }
  assert.match(hybridActionReviewContract({eventType:'penalty'}),/penalty AWARD or a TAKEN penalty/);
  for (const eventType of ['offside','var']) {
    const contract=hybridActionReviewContract({eventType});
    assert.match(contract,/football decision/);
    assert.doesNotMatch(contract,/decisive finishing action/);
  }
});

test('decision-only views require an observed ruling but not a match ball', () => {
  const scene={eventType:'var',startTime:10,endTime:12};
  const evidence={provider:'hybrid-football',hybridTrackingVersion:HYBRID_TRACKING_VERSION,
    sourceRecords:[{time:1.5,action_phase:'payoff',direct_ball:false,player_track_id:1,
      player_x1:.4,player_x2:.6,player_top:.2,player_bottom:.8}],
    keyframes:[{time:1.5,cameraX:.5,cropBox:[0,0,1,1]}],
    renderReview:{passed:true,correctSubject:true,
      stableCamera:true,outcomeVisible:true,observations:[
        {time:.5,description:'The referee approaches the review screen.'},
        {time:1.5,description:'The referee gives the final decision.'}],
      phaseChecks:[{phase:'payoff',time:1.5,ballVisible:false,playerVisible:true,
        description:'The referee visibly signals the decision.'}]}};
  assert.equal(assessHybridFraming(scene,evidence).usable,true);
  evidence.renderReview.phaseChecks=[];
  assert.deepEqual(assessHybridFraming(scene,evidence).issues,['unobserved_decision_payoff']);
});

test('a penalty award resolves at the referee decision without a later kick', () => {
  const scene={eventType:'penalty',startTime:10,endTime:12,
    trackingBrief:{contactTime:10.5,payoffStartTime:11.5,payoffEndTime:12}};
  const times=[0,.5,1,1.5];
  const phases=['setup','contact','flight','payoff'];
  const evidence={provider:'hybrid-football',hybridTrackingVersion:HYBRID_TRACKING_VERSION,
    sourceRecords:times.map((time,index)=>({time,action_phase:phases[index],
      direct_ball:index<3,ball_x:.5,ball_y:.5,player_track_id:1,
      player_x1:.4,player_x2:.6,player_top:.2,player_bottom:.8})),
    keyframes:times.map(time=>({time,cameraX:.5,cropBox:[0,0,1,1]})),
    renderReview:{passed:true,correctSubject:true,stableCamera:true,outcomeVisible:true,
      ballFollowed:true,setupVisible:true,contactVisible:true,ballEnteredGoal:false,
      observedOutcome:{type:'not_applicable',time:1.5,description:'The referee awards the penalty.'},
      observations:[{time:.5,description:'The defender challenges the carrier.'},
        {time:1.5,description:'The referee signals a penalty.'}],
      phaseChecks:[{phase:'payoff',time:1.5,playerVisible:true,ballVisible:false,
        description:'The referee visibly awards the penalty.'}]}};
  assert.equal(assessHybridFraming(scene,evidence).usable,true);
  evidence.renderReview.phaseChecks=[];
  assert.ok(assessHybridFraming(scene,evidence).issues.includes('unobserved_decision_payoff'));
});

test('verified header phases can correct source timing without the original cross taker', () => {
  const scene={eventType:'goal',startTime:10,endTime:12.5,
    trackingBrief:{originTime:10,contactTime:10.75,flightStartTime:10.75,
      payoffStartTime:12,payoffEndTime:12.5}};
  const times=[0,.25,.58,.83,1.17,2];
  const phases=['setup','setup','contact','flight','payoff','payoff'];
  const evidence={provider:'hybrid-football',hybridTrackingVersion:HYBRID_TRACKING_VERSION,
    sourceStartTime:10,sourceEndTime:12.5,
    sourceRecords:times.map((time,index)=>({time,action_phase:phases[index],
      direct_ball:true,ball_x:.5,ball_y:.4,player_track_id:index<2?1:null,
      player_x1:.45,player_x2:.55,player_top:.2,player_bottom:.8})),
    keyframes:times.map(time=>({time,cameraX:.5,cropBox:[0,0,1,1]})),
    renderReview:{passed:true,correctSubject:true,stableCamera:true,outcomeVisible:true,
      ballFollowed:true,setupVisible:true,contactVisible:true,ballEnteredGoal:true,
      keeperContactVisible:false,issues:[],observedOutcome:{type:'goal',time:1.17,
        description:'The headed ball crosses between the posts.'},
      observations:[{time:.25,description:'Scorer and incoming ball are visible before the header.'},
        {time:1.17,description:'The ball crosses into the goal.'}],
      phaseChecks:[['setup',.25],['contact',.58],['flight',.83],['payoff',1.17]]
        .map(([phase,time])=>({phase,time,ballVisible:true,playerVisible:true,
          description:'The relevant player and moving match ball are visible.'}))}};
  assert.equal(assessHybridFraming(scene,evidence).usable,true);
});

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
  assert.equal(providerEvidenceMatches('hybrid', {
    provider: 'hybrid-football', hybridTrackingVersion: HYBRID_TRACKING_VERSION - 1,
    finalCropVerified:true,layoutMode:'action',renderReview:{passed:true},
  }), true);
  assert.equal(providerEvidenceMatches('hybrid', {
    provider:'hybrid-football',hybridTrackingVersion:6,finalCropVerified:true,
    layoutMode:'action',renderReview:{passed:true},
  }),true);
  assert.equal(providerEvidenceMatches('hybrid', {
    provider:'hybrid-football',hybridTrackingVersion:6,finalCropVerified:false,
    layoutMode:'action',renderReview:{passed:true},
  }),false);
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

test('a collapsed prior crop clock is discarded before new tracking', () => {
  const scene={startTime:382.5,endTime:387.354,trackingBrief:{
    contactTime:382.503,flightStartTime:382.503,
    payoffStartTime:382.503,payoffEndTime:382.503,attackDirection:'left'}};
  const prepared=hybridDetectorScene(scene);
  assert.equal(prepared.trackingBrief.contactTime,undefined);
  assert.equal(prepared.trackingBrief.payoffStartTime,undefined);
  assert.equal(prepared.trackingBrief.attackDirection,'left');
});

test('a payoff instant after an observed finish keeps the shot clock', () => {
  for (const [startTime,endTime,contactTime,payoffStartTime] of [
    [83.5,91.024,88.17,89],
    [179.98,190.855,189.063,190.063],
    [259.488533,261.863533,260.156,260.822],
  ]) {
    const scene={startTime,endTime,eventType:'save',trackingBrief:{
      contactTime,flightStartTime:contactTime,handoffTime:contactTime+.1,
      payoffStartTime,payoffEndTime:payoffStartTime,
      timingEvidence:'independent_actual_crop_phase_checks'}};
    const prepared=hybridDetectorScene(scene);
    assert.equal(prepared.trackingBrief.contactTime,contactTime);
    assert.equal(prepared.trackingBrief.payoffStartTime,payoffStartTime);
    assert.equal(prepared.trackingBrief.payoffEndTime,endTime);
  }
});

test('a real crop review saves a payoff interval rather than one instant', () => {
  const scene={eventType:'goal',startTime:10,endTime:13,trackingBrief:{}};
  const phaseChecks=[['setup',.3],['contact',1.2],['flight',1.6],['payoff',2.4]]
    .map(([phase,time])=>({phase,time,ballVisible:true,playerVisible:true,
      description:'The match ball and relevant player are clearly visible.'}));
  const review={passed:true,correctSubject:true,stableCamera:true,outcomeVisible:true,
    ballFollowed:true,setupVisible:true,contactVisible:true,ballEnteredGoal:true,
    issues:[],phaseChecks,observedOutcome:{type:'goal',time:2.4,
      description:'The ball visibly crosses between the posts.'}};
  const brief=reviewedHybridPhaseBrief(scene,{renderReview:review});
  assert.ok(brief.payoffEndTime-brief.payoffStartTime>=.5);
  assert.equal(reviewedHybridPhaseBrief(scene,{renderReview:{...review,
    phaseChecks:phaseChecks.map(check=>({...check,time:.003}))}}),null);
});

test('positive finish with missing setup timestamp gets a separate opening observation', () => {
  const scene={eventType:'goal',startTime:10,endTime:12.5,
    trackingBrief:{contactTime:10.5,flightStartTime:10.5,payoffStartTime:11.5,payoffEndTime:12.5}};
  const times=[.1,.3,.5,.8,1.5,2];
  const evidence={provider:'hybrid-football',hybridTrackingVersion:HYBRID_TRACKING_VERSION,
    sourceStartTime:10,sourceEndTime:12.5,
    sourceRecords:times.map((time,index)=>({time,action_phase:index<2?'setup':index<3?'contact':index<4?'flight':'payoff',
      direct_ball:true,ball_x:.5,ball_y:.5,player_track_id:index>1?1:null,
      player_x1:.4,player_x2:.6,player_top:.2,player_bottom:.8})),
    keyframes:times.map(time=>({time,cameraX:.5,cropBox:[.34,0,.66,1]})),
    renderReview:{passed:true,correctSubject:true,stableCamera:true,outcomeVisible:true,
      ballFollowed:true,setupVisible:true,contactVisible:true,ballEnteredGoal:true,issues:[],
      observedOutcome:{type:'goal',time:1.5,description:'The ball clearly enters the goal.'},
      observations:[{time:.5,description:'The attacker touches the ball.'},
        {time:1.5,description:'The ball enters the net.'}],
      phaseChecks:[{phase:'contact',time:.5,ballVisible:true,playerVisible:true,description:'Touch'},
        {phase:'flight',time:.8,ballVisible:true,playerVisible:true,description:'Flight'},
        {phase:'payoff',time:1.5,ballVisible:true,playerVisible:true,description:'Goal'}]}};
  assert.equal(needsHybridOpeningDetail(scene,evidence),true);
  const reviewed=applyHybridOpeningDetail(evidence.renderReview,{setupVisible:true,setupTime:.3,
    description:'The finisher controls the moving match ball before the touch.'},.5,2.5);
  assert.equal(reviewed.phaseChecks.at(-1).phase,'setup');
  assert.equal(assessHybridFraming(scene,{...evidence,renderReview:reviewed}).usable,true);
  assert.equal(applyHybridOpeningDetail(evidence.renderReview,{setupVisible:false,setupTime:null,
    description:'No ball is identifiable.'},.5,2.5).passed,false);
});

test('a verified portrait review can correct a selected save to a shot wide', () => {
  const scene = {eventType:'save',startTime:26.5,endTime:33.7};
  const evidence = {renderReview:{passed:true,correctSubject:true,stableCamera:true,
    ballFollowed:true,setupVisible:true,contactVisible:true,outcomeVisible:true,
    ballEnteredGoal:false,issues:[],observedOutcome:{type:'wide',time:6.42,
      description:'The moving ball passed outside the post.'}}};
  assert.equal(reviewedFramingEvent(scene,evidence),'shot_off_target');
});

test('a locked goal needs independent source agreement before becoming a save', () => {
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
  assert.equal(reviewedFramingEvent(scene,evidence),null);
  assert.equal(assessHybridFraming(scene,evidence).usable,false);
  evidence.outcomeComparison={version:1,sameActionVerified:true,
    sourceSceneStartTime:20,sourceSceneEndTime:27,
    sourceOutcome:{observedOutcome:'keeper_save',goalLineCrossingVerified:false}};
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

test('a source-contained fallback preserves observations and removes the failed portrait window', () => {
  const native={provider:'hybrid-football',sourceRecords:[{time:0,direct_ball:true}],
    keyframes:[{time:0,cameraX:.8,cropBox:[.6,0,.9,1]}],
    renderReview:{passed:false},reviewRepairError:'old crop timeout',finalCropVerified:false};
  const contained=sourceContainEvidence(native);
  assert.equal(contained.layoutMode,'source_contain');
  assert.deepEqual(contained.keyframes[0].cropBox,[0,0,1,1]);
  assert.equal(contained.keyframes[0].cameraX,.5);
  assert.equal(contained.sourceRecords,native.sourceRecords);
  assert.equal(contained.renderReview,undefined);
  assert.equal(contained.reviewRepairError,undefined);
  assert.deepEqual(native.keyframes[0].cropBox,[.6,0,.9,1]);
});

test('a complete observed pass corrects a stale finishing label without inventing a goal', () => {
  const scene={eventType:'save',startTime:0,endTime:5};
  const review={passed:true,correctSubject:true,stableCamera:true,ballFollowed:true,
    setupVisible:true,contactVisible:true,outcomeVisible:true,ballEnteredGoal:false,issues:[],
    observedOutcome:{type:'not_applicable',time:3,description:'The pass reaches a teammate in open play.'},
    phaseChecks:[{phase:'contact',time:1,ballVisible:true,playerVisible:true},
      {phase:'payoff',time:3,ballVisible:true,playerVisible:true}]};
  assert.equal(reviewedFramingEvent(scene,{renderReview:review}),'normal_play');
  assert.equal(reviewedFramingEvent(scene,{renderReview:{...review,outcomeVisible:false}}),null);
  const request=hybridCropReviewRequest({model:'test',scene,videoData:'AA==',presentationMode:'source_contain'});
  assert.match(request.contents.at(-1).text,/full-source frame contained inside a portrait canvas/);
  assert.match(request.contents.at(-1).text,/incomplete source action must fail/);
});

test('a full-source inset cannot approve a 9:16 scene whose crop loses the action', () => {
  const scene={eventType:'goal',selectionLocked:true,startTime:0,endTime:4,
    trackingBrief:{contactTime:1,flightStartTime:1,payoffStartTime:3,payoffEndTime:3.5}};
  const times=[0,1,2,3];
  const evidence={provider:'hybrid-football',hybridTrackingVersion:HYBRID_TRACKING_VERSION,
    sourceStartTime:0,sourceEndTime:4,
    sourceRecords:times.map((time,index)=>({time,action_phase:['setup','contact','flight','payoff'][index],
      direct_ball:true,ball_x:.1,ball_y:.5,player_track_id:1,player_x1:.05,player_x2:.2,
      player_top:.3,player_bottom:.8})),
    keyframes:times.map(time=>({time,cameraX:.8,cropBox:[.6,0,.9,1]}))};
  const review={passed:true,correctSubject:true,stableCamera:true,ballFollowed:true,
    setupVisible:true,contactVisible:true,outcomeVisible:true,ballEnteredGoal:false,
    keeperContactVisible:false,issues:[],observedOutcome:{type:'blocked',time:3,
      description:'The defender blocks the moving ball and it stays out.'},
    observations:[{time:0,description:'Attacker advances with the ball.'},
      {time:3,description:'Defender blocks the shot and ball redirects.'}],
    phaseChecks:times.map((time,index)=>({phase:['setup','contact','flight','payoff'][index],time,
      ballVisible:true,playerVisible:true,description:'The moving ball and relevant player remain visible.'}))};
  assert.equal(assessHybridFraming(scene,{...evidence,renderReview:review}).usable,false);
  const contained={...sourceContainEvidence(evidence),renderReview:review};
  const assessment=assessHybridFraming(scene,contained);
  assert.equal(assessment.usable,false);
  assert.equal(assessment.mode,'portrait_full_bleed_required');
  assert.equal(reviewedFramingEvent(scene,contained),null);
});
