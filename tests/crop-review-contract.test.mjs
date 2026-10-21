import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GEMINI_CROP_REVIEW_POLICY_VERSION,GEMINI_FRAMING_VERSION,independentCropReviewPrompt,framingReviewGenerationConfig,
  effectiveFramingReviewChecks,framingReviewFailure,assessGeminiFraming,trackSceneWithGemini,
  verifiedPairedGoalOutcome,compareFramingOutcome}
  from '../local-processor/gemini-framing.mjs';

const scene={id:'follow-up',startTime:0,endTime:2,eventType:'shot_on_target',semanticVerified:true,actionComplete:true};
const goalReview={passed:true,correctSubject:true,stableCamera:true,ballFollowed:true,
  setupVisible:true,contactVisible:true,outcomeVisible:true,goalVisible:true,ballEnteredGoal:true,
  receiverVisible:true,reboundFollowed:true,keeperContextVisible:true,issues:[],
  observedOutcome:{type:'goal',time:1.75,description:'The second attacker finishes the live rebound inside the goal.'},
  observations:[{time:0,description:'The first player controls and passes the real ball.'},
    {time:1.75,description:'The follow-up shot visibly crosses the goal line inside the posts.'}]};
const goalNote={observedOutcome:'goal',goalLineCrossingVerified:true,goalLineCrossingTime:1.75,
  crossingEvidence:'The follow-up shot crosses the goal line inside the posts after the first shot rebounds.'};
const evidence=(review=goalReview)=>({provider:'gemini-vision',geminiFramingVersion:GEMINI_FRAMING_VERSION,
  outcomeConsistencyVersion:1,geometryVerified:true,requiredReviewChecks:['receiverVisible','reboundFollowed'],
  initialFocusNotes:[{observedOutcome:'woodwork',goalLineCrossingVerified:false},goalNote],renderReview:review});

test('independent crop prompt checks all contacts through the terminal action against the visible scene clock',()=>{
  const prompt=independentCropReviewPrompt(scene,{keyframes:[],requiredReviewChecks:['receiverVisible','reboundFollowed']});
  assert.match(prompt,/burned-in SCENE seconds clock/);
  assert.match(prompt,/Watch through the END/);
  assert.match(prompt,/follow-up touch\/shot/);
  assert.match(prompt,/LAST resolved attacking action/);
  assert.match(prompt,/Receiving touches can occur ANYWHERE/);
  assert.match(prompt,/ALL meaningful actual receiving touches/);
  assert.match(prompt,/\["receiverVisible","reboundFollowed"\]/);
  assert.match(prompt,/non-applicability in observations/);
  assert.doesNotMatch(prompt,/shot_on_target|follow-up.*expected goal/);
});

test('a complete follow-up goal still requires the actual receiving touch, never auto-approves false flags',()=>{
  assert.equal(assessGeminiFraming(scene,evidence()).usable,true);
  const review={...goalReview,receiverVisible:false,reboundFollowed:false};
  const saved=evidence(review),checks=effectiveFramingReviewChecks(scene,saved);
  assert.deepEqual(checks,['receiverVisible']);
  assert.equal(assessGeminiFraming(scene,saved).usable,false);
  const message=framingReviewFailure(review,checks,2,false,scene,saved);
  assert.match(message,/receiverVisible/);
  assert.doesNotMatch(message,/reboundFollowed|source_crop_outcome_unconfirmed/);
});

test('outcome disagreement is explicit and cannot promote a guessed goal',()=>{
  const saved={...evidence(),initialFocusNotes:[{observedOutcome:'woodwork',goalLineCrossingVerified:false}]};
  assert.equal(assessGeminiFraming(scene,saved).usable,false);
  assert.match(framingReviewFailure(goalReview,effectiveFramingReviewChecks(scene,saved),2,false,scene,saved),
    /source_crop_outcome_unconfirmed/);
});

test('crop review starts with enough JSON budget and lower thinking instead of deliberately truncating once',()=>{
  const config=framingReviewGenerationConfig();
  assert.equal(config.thinkingConfig.thinkingLevel,'LOW');
  assert.equal(config.maxOutputTokens,16384);
  assert.equal(config.responseMimeType,'application/json');
  assert.ok(config.responseSchema.required.includes('phaseChecks'));
  config.thinkingConfig.thinkingLevel='HIGH';
  assert.equal(framingReviewGenerationConfig().thinkingConfig.thinkingLevel,'LOW');
});

test('paired result requires the same source interval, actual crop crossing and matching clocks',()=>{
  const original={...evidence(),initialFocusNotes:[{observedOutcome:'keeper_save',goalLineCrossingVerified:false}],
    outcomeComparison:{version:1,sameActionVerified:true,sourceSceneStartTime:0,sourceSceneEndTime:2,sourceOutcome:goalNote}};
  assert.equal(verifiedPairedGoalOutcome(scene,original),true);
  assert.equal(assessGeminiFraming(scene,original).usable,true);
  for(const patch of [{sameActionVerified:false},{sourceSceneStartTime:1},{sourceSceneEndTime:3},
    {sourceOutcome:{...goalNote,goalLineCrossingTime:.5}},
    {sourceOutcome:{...goalNote,goalLineCrossingVerified:false}},
    {sourceOutcome:{...goalNote,crossingEvidence:'guessed'}}]) {
    const changed={...original,outcomeComparison:{...original.outcomeComparison,...patch}};
    assert.equal(verifiedPairedGoalOutcome(scene,changed),false);
    assert.equal(assessGeminiFraming(scene,changed).usable,false);
  }
  assert.equal(verifiedPairedGoalOutcome(scene,{...original,renderReview:{...goalReview,goalVisible:false}}),false);
  assert.equal(assessGeminiFraming(scene,{...original,renderReview:{...goalReview,receiverVisible:false}}).usable,false);
});

test('one source/crop comparison preserves boundaries and caches rejected results without repeating paid calls',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'crop-outcome-comparison-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const cropped=join(directory,'crop.mp4'),contextPath=join(directory,'source.mp4');
  await writeFile(cropped,'actual crop');await writeFile(contextPath,'original wide source');
  const original={...evidence(),initialFocusNotes:[]};let calls=0;
  const options={scene,camera:{keyframes:[],requiredReviewChecks:['receiverVisible']},evidence:original,
    cropped,contextPath,directory,signature:'test',model:'test-model',report:async()=>{},
    generate:async(request,label)=>{calls++;assert.equal(label,'source/crop outcome comparison follow-up');
      assert.equal(request.contents.filter(p=>p.inlineData).length,2);
      assert.match(request.contents.at(-1).text,/Full-width-only action cannot pass/);
      return {sameActionVerified:true,sourceOutcome:goalNote,cropReview:{...goalReview,receiverVisible:false}};}};
  const first=await compareFramingOutcome(options);
  assert.equal(first.sourceStartTime,original.sourceStartTime);assert.equal(scene.startTime,0);assert.equal(scene.endTime,2);
  assert.equal(first.renderReview.receiverVisible,false);
  assert.equal(assessGeminiFraming(scene,first).usable,false);
  assert.equal(original.outcomeComparison,undefined,'original observation is never rewritten');
  await compareFramingOutcome(options);assert.equal(calls,1,'even a rejected comparison is checkpointed');

  const mismatched={...options,signature:'mismatched',generate:async()=>{
    calls++;return {sameActionVerified:true,sourceOutcome:{...goalNote,observedOutcome:'keeper_save'},cropReview:goalReview};}};
  await assert.rejects(compareFramingOutcome(mismatched),/outcomes remain contradictory/);
  const after=calls;
  await assert.rejects(compareFramingOutcome(mismatched),/outcomes remain contradictory/);
  assert.equal(calls,after,'unresolved contradictions are saved, not recharged on Resume');
});

test('subject support failure reports face/torso rather than demanding nonexistent gameplay',()=>{
  const message=framingReviewFailure({passed:true,correctSubject:true,stableCamera:true,subjectCoreVisible:false,
    issues:[],observations:[{time:0,description:'The reacting player is partly outside the frame.'}]},[],2,true);
  assert.match(message,/subjectCoreVisible/);
  assert.doesNotMatch(message,/ballFollowed|setupVisible|contactVisible|outcomeVisible/);
});

test('real scene path uses a review-only clock and the new contract once, then reuses approved evidence',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'crop-review-contract-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const sourcePath=join(directory,'source.mp4');await writeFile(sourcePath,'test source');
  const frames=Array.from({length:16},(_,index)=>({index,time:index/8,cut:false,
    phase:index<4?'setup':index===4||index===6||index===10||index===11?'contact':index<14?'flight':'payoff',
    situation:index<4?'possession':index===6||index===10?'receive':index===4||index===11?'release':index===8||index===9?'rebound':index<14?'travel':'result',
    actionResolved:index>=14,ballInPlay:index<14,identity:'involved attacker',explanation:'The actual involved player and ball are visible.',
    ball:[500,400,510,410],player:[400,390,700,430],goalkeeper:null,goalPost:null,subjectCore:null,faceCore:null}));
  const calls=[],graphs=[];
  const options={sourcePath,sourceFingerprint:{sha256:'source-clock-contract'},scene,directory,
    media:{width:1920,height:1080},ratio:9/16,model:'test-model',ffmpeg:'test-encoder',
    run:async(_command,args)=>writeFile(args.at(-1),'rendered video fixture'),
    filterFileArgs:async(_command,path)=>{graphs.push(await readFile(path,'utf8'));return ['-filter_complex_script',path];},
    generate:async(request,label)=>{
      calls.push(label);
      if(label.startsWith('video keyframes'))return {frames,focusNotes:goalNote};
      assert.equal(label,'cropped scene review follow-up');
      assert.match(request.contents.at(-1).text,/LAST resolved attacking action/);
      assert.equal(request.config.thinkingConfig.thinkingLevel,'LOW');
      assert.equal(request.config.maxOutputTokens,16384);
      return goalReview;
    }};
  const result=await trackSceneWithGemini(options);
  assert.equal(result.cropReviewPolicyVersion,GEMINI_CROP_REVIEW_POLICY_VERSION);
  assert.equal(result.finalCropVerified,true);
  assert.ok(graphs.every(graph=>graph.includes('drawtext=')&&graph.includes('SCENE')));
  assert.equal(calls.length,2);
  await trackSceneWithGemini(options);
  assert.equal(calls.length,2,'approved source observations and crop are reused, no repair ladder');

  const comparisonCalls=[];
  const comparedOptions={...options,scene:{...scene,id:'conflicting-follow-up'},generate:async(request,label)=>{
    comparisonCalls.push(label);
    if(label.startsWith('video keyframes'))return {frames,focusNotes:{observedOutcome:'keeper_save',
      goalLineCrossingVerified:false,goalLineCrossingTime:null,crossingEvidence:'Initial observation called the shot a save.'}};
    if(label==='cropped scene review conflicting-follow-up')return goalReview;
    assert.equal(label,'source/crop outcome comparison conflicting-follow-up');
    assert.equal(request.contents.filter(part=>part.inlineData).length,2);
    return {sameActionVerified:true,sourceOutcome:goalNote,cropReview:goalReview};
  }};
  const corrected=await trackSceneWithGemini(comparedOptions);
  assert.equal(corrected.outcomeComparison.sameActionVerified,true);
  assert.equal(corrected.finalCropVerified,true);
  assert.equal(comparisonCalls.length,3,'only contradictory outcomes need one extra visual comparison');
  await trackSceneWithGemini(comparedOptions);
  assert.equal(comparisonCalls.length,3,'approved reconciliation is reused on restart');
});
