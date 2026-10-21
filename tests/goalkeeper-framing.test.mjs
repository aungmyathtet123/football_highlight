import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GEMINI_CAMERA_POLICY_VERSION,planGeminiCamera,trackSceneWithGemini} from '../local-processor/gemini-framing.mjs';

const keeperTouchFrames=(live=true)=>Array.from({length:16},(_,index)=>({time:index/8,cut:false,
  phase:index<4?'setup':index===4?'contact':index<8?'flight':'payoff',
  situation:index<4?'possession':index===4?'release':index<8?'travel':'keeper_touch',
  actionResolved:index>=8,ballInPlay:index<8||live,
  ball:{x1:.40,y1:.5,x2:.41,y2:.51},
  player:index>=8?null:{x1:.39,y1:.4,x2:.43,y2:.7},
  goalkeeper:{x1:.40,y1:.35,x2:.44,y2:.62}}));

test('live parries and controlled catches follow keeper and ball without an outfield-player requirement',()=>{
  for(const live of [true,false])for(const eventType of ['save','shot_on_target','big_chance']) {
    const frames=keeperTouchFrames(live),original=structuredClone(frames);
    const plan=planGeminiCamera({eventType},frames,{width:1920,height:1080});
    assert.ok(plan.keyframes.slice(8).every(f=>f.ballInFrame&&f.goalkeeperInFrame));
    assert.ok(plan.keyframes.filter(f=>!f.reactionOnly&&f.situation==='keeper_touch')
      .every(f=>f.playerInFrame&&f.jointFit&&f.actionPlayerRole==='goalkeeper'));
    assert.ok(plan.requiredReviewChecks.includes('keeperContactVisible'));
    assert.equal(plan.maxSpeed,0);assert.deepEqual(frames,original);
  }
});

test('keeper touch ignores distant outfield-player geometry and exports the keeper centre',()=>{
  const frames=keeperTouchFrames().map((f,index)=>index>=8?
    {...f,player:{x1:.86,y1:.4,x2:.92,y2:.7}}:f);
  const plan=planGeminiCamera({eventType:'save'},frames,{width:1920,height:1080});
  assert.equal(plan.maxSpeed,0);
  for(const f of plan.keyframes.slice(8)) {
    assert.ok(Math.abs(f.playerCenterX-.42*1920)<1e-9);
    assert.equal(f.playerCenterY,(.35+.62)/2*1080);
    assert.ok(f.jointFit&&f.goalkeeperInFrame&&f.ballInFrame);
  }
});

test('role handling never fabricates a missing ball, keeper or impossible joint crop',()=>{
  for(const patch of [{ball:null},{goalkeeper:null},{ball:{x1:.9,y1:.5,x2:.91,y2:.51}}]) {
    const frames=keeperTouchFrames().map((f,index)=>index>=8?{...f,...patch}:f);
    assert.throws(()=>planGeminiCamera({eventType:'save'},frames,{width:1920,height:1080}),
      /missing football|missing involved goalkeeper|did not observe|cannot fit/);
  }
  const frames=keeperTouchFrames().map((f,index)=>index>=8?{...f,situation:'receive'}:f);
  assert.throws(()=>planGeminiCamera({eventType:'save'},frames,{width:1920,height:1080}),/missing involved player/);
});

test('keeper contact follows the keeper without changing earlier ownership or legacy involved-player observations',()=>{
  const frames=keeperTouchFrames().map((f,index)=>index===8?{...f,phase:'contact'}:f);
  const plan=planGeminiCamera({eventType:'save'},frames,{width:1920,height:1080});
  assert.equal(plan.keyframes[4].playerCenterX,(.39+.43)/2*1920);
  assert.ok(Math.abs(plan.keyframes[8].playerCenterX-.42*1920)<1e-9);assert.ok(plan.keyframes[8].jointFit);
  const legacy=keeperTouchFrames().map((f,index)=>index>=8?{...f,player:f.goalkeeper,goalkeeper:null}:f);
  assert.ok(planGeminiCamera({eventType:'save'},legacy,{width:1920,height:1080})
    .keyframes.slice(8).every(f=>f.jointFit));
});

test('resolved continuation/result does not require a distant outfield player or lose its observed keeper reaction',()=>{
  const frames=keeperTouchFrames(false).map((f,index)=>index>=8?{...f,phase:'continuation',situation:'result',
    player:{x1:.85,y1:.4,x2:.9,y2:.7}}:f);
  const plan=planGeminiCamera({eventType:'save'},frames,{width:1920,height:1080});
  assert.equal(plan.maxSpeed,0);
  assert.ok(plan.keyframes.slice(8).every(f=>f.ballInFrame&&f.goalkeeperInFrame));
  const reaction=[...frames,{...frames.at(-1),time:2,phase:'reaction',situation:'reaction',ball:null}];
  const after=planGeminiCamera({eventType:'save'},reaction,{width:1920,height:1080}).keyframes.at(-1);
  assert.equal(after.reactionSubject,'observed_goalkeeper');assert.ok(after.goalkeeperInFrame);
});

test('flight, rolling rebounds and loose balls do not demand an unrelated outfield player',()=>{
  for(const situation of ['travel','rebound','loose_ball']) {
    const frames=keeperTouchFrames().map((f,index)=>index>=10?{...f,phase:'continuation',situation,
      player:{x1:.85,y1:.4,x2:.9,y2:.7}}:f);
    const plan=planGeminiCamera({eventType:'save'},frames,{width:1920,height:1080});
    assert.ok(plan.keyframes.slice(10).every(f=>f.ballInFrame));
    assert.equal(plan.maxSpeed,0);
    if(situation==='rebound')assert.ok(plan.requiredReviewChecks.includes('reboundFollowed'));
  }
});

test('outfield passing and receiving touches still require their own observed player, never a distant keeper',()=>{
  for(const situation of ['possession','release','receive']) {
    const frames=keeperTouchFrames().map((f,index)=>index>=8?{...f,situation}:f);
    assert.throws(()=>planGeminiCamera({eventType:'save'},frames,{width:1920,height:1080}),/missing involved player/);
  }
});

test('actual scene flow observes once, reviews the keeper crop and reuses approved evidence without a repair call',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'keeper-framing-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const sourcePath=join(directory,'source.mp4');await writeFile(sourcePath,'test media');
  const frames=keeperTouchFrames().map((f,index)=>{
    const row={...f,index,identity:index>=8?'involved_keeper':'attacking_player',
      explanation:index>=8?'The keeper directly touches the ball.':'The attacker plays the ball.',
      goalPost:null,subjectCore:null,faceCore:null};
    for(const key of ['ball','player','goalkeeper']) {
      const b=f[key];row[key]=b?[b.y1*1000,b.x1*1000,b.y2*1000,b.x2*1000]:null;
    }
    return row;
  });
  const calls=[];
  const options={sourcePath,sourceFingerprint:{sha256:'test-source'},directory,
    scene:{id:'keeper-scene',startTime:0,endTime:2,eventType:'save',semanticVerified:true,actionComplete:true},
    media:{width:1920,height:1080},ratio:9/16,model:'test-model',ffmpeg:'test-encoder',
    run:async(_command,args)=>writeFile(args.at(-1),'rendered test media'),
    filterFileArgs:async(_command,path)=>['-filter_complex_script',path],
    generate:async(_request,label)=>{
      calls.push(label);
      if(label.startsWith('video keyframes'))return {frames};
      assert.equal(label,'cropped scene review keeper-scene');
      return {passed:true,correctSubject:true,stableCamera:true,ballFollowed:true,
        setupVisible:true,contactVisible:true,outcomeVisible:true,keeperContactVisible:true,
        keeperContextVisible:true,ballEnteredGoal:false,issues:[],
        observedOutcome:{type:'keeper_save',time:1,description:'The goalkeeper directly parries the ball.'},
        observations:[{time:0,description:'The attacker controls the real ball.'},
          {time:1,description:'The ball visibly touches the involved goalkeeper.'}]};
    }};
  const evidence=await trackSceneWithGemini(options);
  assert.equal(evidence.finalCropVerified,true);assert.equal(evidence.cameraPolicyVersion,GEMINI_CAMERA_POLICY_VERSION);
  assert.ok(evidence.keyframes.slice(8).every(f=>f.jointFit&&f.goalkeeperInFrame));
  assert.equal(evidence.sourceStartTime,0);assert.equal(evidence.sourceEndTime,2);
  assert.equal(calls.length,2);assert.ok(calls.every(label=>!label.includes('repair')));
  await trackSceneWithGemini(options);assert.equal(calls.length,2);
});
