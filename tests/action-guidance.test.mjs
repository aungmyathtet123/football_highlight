import test from 'node:test';
import assert from 'node:assert/strict';
import {actionGuidanceRequest,validateActionGuidance,observeValidatedActionGuidance,guidedDetectorScene,actionGuidanceKey,matchingActionGuidance,applySavedActionGuidance,actionGuideObservationKey,matchingActionGuideObservation,sharedActionGuideObservation} from '../local-processor/action-guidance.mjs';
import {hybridDetectorScene} from '../local-processor/hybrid-tracking-policy.mjs';
const guide=()=>({sourceType:'simulation',outcome:'uncertain',uncertainties:['finish hidden'],
  anchors:[{time:0,phase:'setup',ball:[400,300,410,310],player:[300,280,450,320],goalmouth:null,
    description:'Player controls the visible ball'}]});
test('identical source observations share a request, but never share another interval or model',()=>{
  const one={id:'one',startTime:10,endTime:16},two={...one,id:'two'},fp={sha256:'source'};
  const key=actionGuideObservationKey(one,fp,'model');
  assert.equal(actionGuideObservationKey(two,fp,'model'),key);
  assert.notEqual(actionGuidanceKey(one,fp,'model'),actionGuidanceKey(two,fp,'model'));
  const saved={version:1,key,guide:guide()};
  assert.equal(matchingActionGuideObservation(two,saved,fp,'model'),saved.guide);
  for(const [scene,fingerprint,model] of [[{...one,endTime:17},fp,'model'],[one,{sha256:'changed'},'model'],[one,fp,'different']])
    assert.equal(matchingActionGuideObservation(scene,saved,fingerprint,model),null);
  assert.equal(matchingActionGuideObservation(one,{...saved,guide:{}},fp,'model'),null);
});
test('parallel duplicate guide requests and restarts reuse one saved observation without sharing mutable boxes',async()=>{
  const pending=new Map();let cached=null,requests=0,saves=0;
  const options={pending,load:async()=>cached,observe:async()=>{requests++;return guide();},save:async value=>{saves++;cached=value;}};
  const [one,two]=await Promise.all([sharedActionGuideObservation('exact-video',options),sharedActionGuideObservation('exact-video',options)]);
  assert.equal(requests,1);assert.equal(saves,1);assert.equal(pending.size,0);
  one.anchors[0].ball[0]=0;
  assert.equal(two.anchors[0].ball[0],400);assert.equal(cached.anchors[0].ball[0],400);
  await sharedActionGuideObservation('exact-video',{...options,pending:new Map()});
  assert.equal(requests,1);
});
test('a failed shared request is not cached or left permanently in flight',async()=>{
  const pending=new Map();let requests=0;
  const options={pending,load:async()=>null,observe:async()=>{requests++;throw new Error('capacity');},save:async()=>assert.fail('Failed guide must not be saved')};
  await assert.rejects(sharedActionGuideObservation('same',options),/capacity/);
  assert.equal(pending.size,0);
  await assert.rejects(sharedActionGuideObservation('same',options),/capacity/);
  assert.equal(requests,2);
});
test('semantic guidance has one video and small bounded output, not dense camera rows',()=>{
  const r=actionGuidanceRequest('model','data',6);
  assert.equal(r.contents.filter(v=>v.inlineData?.mimeType==='video/mp4').length,1);
  assert.equal(r.config.maxOutputTokens,8192);
  assert.match(r.contents[1].text,/NOT a camera path/);
  assert.equal(validateActionGuidance(guide(),6).outcome,'uncertain');
});
test('a semantic guide changes search context, not selected source bounds or crop approval',()=>{
  const scene={id:'one',startTime:10,endTime:16,eventType:'goal',trackingBrief:{}};
  const g=guide();g.outcome='goal';g.anchors.push({time:5,phase:'payoff',ball:[400,700,410,710],
    player:null,goalmouth:[300,650,500,850],description:'Visible goalmouth at the finish'});
  const result=guidedDetectorScene(scene,g);
  assert.equal(result.startTime,10);assert.equal(result.endTime,16);
  assert.equal(result.trackingBrief.initialBallFocusX,.305);
  assert.equal(result.finalCropVerified,undefined);
  assert.equal(result.trackingBrief.payoffEvidence,undefined,'no observed contact means no finishing region lock');
});
test('invalid and invented anchor clocks/boxes are rejected without changing observations',()=>{
  for(const mutate of [g=>g.anchors[0].time=7,g=>g.anchors[0].ball=[1,2,3],
    g=>g.anchors[0].ball=[400,300,390,310],g=>g.anchors=Array(7).fill(g.anchors[0]),
    g=>delete g.anchors[0].player]) {
    const g=guide();mutate(g);assert.throws(()=>validateActionGuidance(g,6));
  }
});
test('coordinate response is saved before validation and corrected against the same video without dropping evidence',async()=>{
  const invalid=guide();invalid.anchors[0].ball=[1200,300,1210,310];
  const valid=guide(),request=actionGuidanceRequest('model','video-bytes',6),original=structuredClone(request);
  const responses=new Map(),calls=[],reports=[];
  const result=await observeValidatedActionGuidance({request,duration:6,label:'scene-one',
    generate:async(current,attempt)=>{
      calls.push(current);
      if(attempt===2) {
        assert.deepEqual(responses.get(1),invalid,'invalid response must already be saved');
        assert.deepEqual(current.contents[0],original.contents[0],'same supplied source video');
        assert.match(current.contents.at(-1).text,/ball box at anchor 1/);
        assert.match(current.contents.at(-1).text,/1200,300,1210,310/);
        assert.match(current.contents.at(-1).text,/Preserve valid anchors/);
      }
      return attempt===1?invalid:valid;
    },saveResponse:async(attempt,raw)=>responses.set(attempt,structuredClone(raw)),
    report:async message=>reports.push(message)});
  assert.deepEqual(result,valid);assert.deepEqual(result.anchors[0].ball,[400,300,410,310]);
  assert.deepEqual(request,original);assert.equal(calls.length,2);assert.equal(responses.size,2);
  assert.equal(reports.length,1);assert.match(reports[0],/saved source scenes/);
});

test('restart reuses archived responses and only requests the missing coordinate correction',async()=>{
  const invalid=guide();invalid.anchors[0].player=[300,280,300,320];
  const responses=new Map([[1,invalid]]);let requests=0;
  const options={request:actionGuidanceRequest('model','video',6),duration:6,label:'scene-two',
    loadResponse:async attempt=>responses.get(attempt)??null,
    saveResponse:async(attempt,raw)=>responses.set(attempt,raw),
    generate:async(request,attempt)=>{
      requests++;assert.equal(attempt,2);assert.match(request.contents.at(-1).text,/player box/);return guide();
    }};
  assert.deepEqual(await observeValidatedActionGuidance(options),guide());assert.equal(requests,1);
  assert.deepEqual(await observeValidatedActionGuidance(options),guide());assert.equal(requests,1);
});

test('valid first observation costs one request and malformed clocks have bounded corrections',async()=>{
  let calls=0;const responses=[];
  const options={request:actionGuidanceRequest('model','video',6),duration:6,label:'scene-three',
    generate:async()=>{calls++;return guide();},saveResponse:async(attempt,raw)=>responses.push(raw)};
  assert.deepEqual(await observeValidatedActionGuidance(options),guide());assert.equal(calls,1);
  const badClock=guide();badClock.anchors[0].time=7;
  await assert.rejects(observeValidatedActionGuidance({...options,
    generate:async()=>{calls++;return badClock;}}),/Invalid semantic anchor clock/);
  assert.equal(calls,4);assert.deepEqual(responses.at(-1),badClock);
});

test('archived reset clock is corrected once against the same video and reused on restart',async()=>{
  const phases=['setup','contact','flight','payoff','reaction'];
  const invalid=guide();invalid.outcome='goal';invalid.uncertainties=[];
  invalid.anchors=[2.5,4.125,4.5,.25,.75].map((time,i)=>({...guide().anchors[0],time,phase:phases[i],
    description:`Directly observed ${phases[i]} in the supplied video`}));
  const original=structuredClone(invalid);
  assert.throws(()=>validateActionGuidance(invalid,9.5),e=>e.code==='ACTION_GUIDE_CLOCK'
    &&e.anchorIndex===3&&e.time===.25&&e.previousTime===4.5);
  const corrected=structuredClone(invalid);
  // Test double, not production evidence: only the model may reobserve and
  // replace the bad timings; the observer must not sort/clamp old anchors.
  corrected.anchors[3].time=5.25;corrected.anchors[4].time=5.75;
  const responses=new Map([[1,invalid]]),calls=[],reports=[];
  const request=actionGuidanceRequest('model','same-video',9.5);
  const options={request,duration:9.5,label:'selected-replay',
    loadResponse:async i=>responses.get(i)??null,
    saveResponse:async(i,raw)=>responses.set(i,structuredClone(raw)),
    report:async text=>reports.push(text),
    generate:async(current,attempt)=>{
      calls.push(current);assert.equal(attempt,2);
      assert.deepEqual(current.contents[0],request.contents[0]);
      assert.match(current.contents.at(-1).text,/anchor 4.*0.25s.*4.5s/);
      assert.match(current.contents.at(-1).text,/not by sorting/);
      return corrected;
    }};
  assert.deepEqual(await observeValidatedActionGuidance(options),corrected);
  assert.equal(calls.length,1);assert.match(reports[0],/Correcting timing response/);
  assert.deepEqual(invalid,original);assert.deepEqual(responses.get(1),original);
  assert.deepEqual(await observeValidatedActionGuidance(options),corrected);
  assert.equal(calls.length,1,'Resume must use the corrected archive, not request the clip again');
});

test('phase, out-of-range, missing, reset and collapsed clocks are precise response errors',async()=>{
  const cases=[
    [g=>g.anchors[0].time=-.1,'ACTION_GUIDE_CLOCK'],
    [g=>g.anchors[0].time=10,'ACTION_GUIDE_CLOCK'],
    [g=>g.anchors[0].time='1.0','ACTION_GUIDE_CLOCK'],
    [g=>g.anchors[0].time=null,'ACTION_GUIDE_CLOCK'],
    [g=>g.anchors[0].phase='finish','ACTION_GUIDE_PHASE'],
    [g=>g.anchors[0].description='','ACTION_GUIDE_SCHEMA'],
    [g=>g.anchors=[null],'ACTION_GUIDE_SCHEMA'],
  ];
  for(const [mutate,code] of cases){
    const invalid=guide();mutate(invalid);
    assert.throws(()=>validateActionGuidance(invalid,6),e=>e.code===code);
    let calls=0;
    const result=await observeValidatedActionGuidance({request:actionGuidanceRequest('model','same-video',6),
      duration:6,label:'any-selected-scene',loadResponse:async i=>i===1?invalid:null,
      generate:async()=>{calls++;return guide();}});
    assert.deepEqual(result,guide());assert.equal(calls,1);
  }
  const collapsed=guide();collapsed.anchors=[0,.028,.035].map((time,i)=>({...guide().anchors[0],
    time,phase:['setup','contact','payoff'][i],ball:[400,300+i*200,410,310+i*200]}));
  assert.throws(()=>validateActionGuidance(collapsed,6),e=>e.code==='ACTION_GUIDE_CLOCK');
});

test('model and transport failures do not consume semantic correction attempts or fabricate observations',async()=>{
  const error=Object.assign(new Error('Service unavailable'),{code:503});let calls=0,saves=0;
  await assert.rejects(observeValidatedActionGuidance({request:actionGuidanceRequest('model','video',6),duration:6,
    generate:async()=>{calls++;throw error;},saveResponse:async()=>saves++}),e=>e===error);
  assert.equal(calls,1);assert.equal(saves,0);
  await assert.rejects(observeValidatedActionGuidance({request:{contents:[]},duration:NaN,
    loadResponse:async()=>guide(),generate:async()=>assert.fail('Invalid caller duration must not be retried')}),/positive scene duration/);
});

test('request bounds each independent clip clock without mutating shared schema or invalidating saved good observations',()=>{
  const a=actionGuidanceRequest('model','clip-a',9.5),b=actionGuidanceRequest('model','clip-b',4);
  const anchors=a.config.responseJsonSchema.properties.anchors;
  assert.equal(anchors.minItems,1);assert.equal(anchors.maxItems,6);
  assert.equal(anchors.items.properties.time.minimum,0);assert.equal(anchors.items.properties.time.maximum,9.5);
  assert.equal(b.config.responseJsonSchema.properties.anchors.items.properties.time.maximum,4);
  assert.match(a.contents[1].text,/Do NOT reset the clock/);
  assert.throws(()=>actionGuidanceRequest('model','clip',0),/positive scene duration/);
});

test('persistent malformed geometry is bounded, diagnosed and archived rather than invented',async()=>{
  const invalid=guide();invalid.anchors[0].goalmouth=[400,300,390,310];
  const responses=new Map();let calls=0;
  const options={request:actionGuidanceRequest('model','video',6),duration:6,label:'scene-four',
    generate:async()=>{calls++;return invalid;},
    loadResponse:async attempt=>responses.get(attempt)??null,
    saveResponse:async(attempt,raw)=>responses.set(attempt,structuredClone(raw))};
  const check=error=>error.code==='ACTION_GUIDE_GEOMETRY'&&error.field==='goalmouth'
    &&error.anchorIndex===0&&/scene-four.*anchor 1.*400,300,390,310/.test(error.message);
  await assert.rejects(observeValidatedActionGuidance(options),check);
  assert.equal(calls,3);assert.equal(responses.size,3);
  await assert.rejects(observeValidatedActionGuidance(options),check);assert.equal(calls,3);
  assert.deepEqual(invalid.anchors[0].goalmouth,[400,300,390,310]);
});

test('schema bounds geometry and nullable hidden subjects without accepting inverted or incomplete boxes',()=>{
  const schema=actionGuidanceRequest('model','video',6).config.responseJsonSchema;
  for(const field of ['ball','player','goalmouth']) {
    const box=schema.properties.anchors.items.properties[field];
    assert.equal(box.minItems,4);assert.equal(box.maxItems,4);
    assert.equal(box.items.minimum,0);assert.equal(box.items.maximum,1000);
  }
  for(const ball of [[],[400,300,400,310],[400,310,410,300],[-1,300,410,310],[400,300,1001,310],undefined]) {
    const value=guide();value.anchors[0].ball=ball;
    assert.throws(()=>validateActionGuidance(value,6),error=>error.code==='ACTION_GUIDE_GEOMETRY'&&error.field==='ball');
  }
  const hidden=guide();hidden.anchors[0].ball=null;assert.equal(validateActionGuidance(hidden,6),hidden);
});
test('guides are bound to source bytes, exact selected interval, model and contract',()=>{
  const scene={id:'one',startTime:10,endTime:16,eventType:'goal'};
  const fingerprint={size:1234,sha256:'source-bytes'},model='model';
  const saved={version:1,key:actionGuidanceKey(scene,fingerprint,model),sourceFingerprint:fingerprint,
    model,sourceStartTime:10,sourceEndTime:16,guide:guide()};
  assert.equal(matchingActionGuidance(scene,saved,fingerprint,model),saved.guide);
  assert.equal(matchingActionGuidance({...scene,endTime:17},saved,fingerprint,model),null);
  assert.equal(matchingActionGuidance(scene,saved,{...fingerprint,sha256:'different'},model),null);
  assert.equal(matchingActionGuidance(scene,saved,fingerprint,'new-model'),null);
  assert.equal(matchingActionGuidance(scene,{...saved,version:0},fingerprint,model),null);
  const prepared=applySavedActionGuidance({...scene,actionGuidance:saved});
  // The guidance adapter owns this sparse search prior. The production dense
  // tracker may deliberately discard it; that independent camera policy is
  // not part of the observation/cache contract tested here.
  assert.equal(prepared.trackingBrief.initialBallFocusX,.305);
  const stale=hybridDetectorScene({...prepared,actionGuidance:{...saved,sourceStartTime:9}});
  assert.equal(stale.trackingBrief.actionGuide,undefined);
  assert.equal(stale.trackingBrief.goalFocusX,null);
  assert.equal(stale.trackingBrief.initialBallFocusX,undefined);
});

test('different observed phases cannot describe a cross-field goal in 35 milliseconds',()=>{
  const g=guide();g.outcome='goal';g.uncertainties=[];
  g.anchors=[...g.anchors,{...g.anchors[0],time:.028,phase:'contact',description:'The attacker strikes towards goal'},
    {...g.anchors[0],time:.035,phase:'payoff',ball:[400,800,410,810],description:'The ball crosses the goal line'}];
  assert.throws(()=>validateActionGuidance(g,7.5),/less than one observed video frame/);
  g.anchors[1].time=2.8;g.anchors[2].time=3.5;
  assert.equal(validateActionGuidance(g,7.5),g);
});

test('a later shooter location is never reused as the opening ball prior',()=>{
  const g=guide();g.anchors[0].time=3;
  const result=guidedDetectorScene({id:'one',startTime:10,endTime:16,eventType:'goal',
    trackingBrief:{initialBallFocusX:.9}},g);
  assert.equal(result.trackingBrief.initialBallFocusX,undefined);
  assert.equal(result.finalCropVerified,undefined);
});

test('a save or miss updates the observed shot destination without imposing a goal opening constraint',()=>{
  for(const outcome of ['save','wide','over']) {
    const g=guide();g.outcome=outcome;g.uncertainties=[];
    g.anchors.push({...g.anchors[0],time:2,phase:'contact'},
      {...g.anchors[0],time:3,phase:'payoff',ball:[400,780,410,790],
        goalmouth:[300,650,500,850],description:'The shot reaches the visible goal area'});
    const s=guidedDetectorScene({startTime:10,endTime:16,eventType:'shot_off_target',
      trackingBrief:{goalFocusX:0,attackDirection:'left'}},g);
    assert.equal(s.trackingBrief.goalFocusX,.785);
    assert.equal(s.trackingBrief.attackDirection,'right');
    assert.equal(s.trackingBrief.shotDestination.provider,'semantic_region_guide_not_crop_approval');
    assert.equal(s.trackingBrief.payoffEvidence,undefined);
    assert.equal(s.startTime,10);assert.equal(s.endTime,16);
  }
});

test('an incoming airborne cross begins before the receiving header contact',()=>{
  const g=guide();g.outcome='wide';g.uncertainties=[];
  g.anchors=[{...g.anchors[0],time:1,phase:'flight'},
    {...g.anchors[0],time:3,phase:'contact'},
    {...g.anchors[0],time:4,phase:'payoff'}];
  const s=guidedDetectorScene({startTime:10,endTime:16,eventType:'shot_off_target'},g);
  assert.equal(s.trackingBrief.flightStartTime,11);
  assert.equal(s.trackingBrief.contactTime,13);
});
