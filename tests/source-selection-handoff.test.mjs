import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {mapWithConcurrency} from '../local-processor/bounded-concurrency.mjs';
import {INITIAL_SECTION_VERSION,initialScoringCoverage,selectInitialActionViews} from '../local-processor/initial-section-analysis.mjs';
import {sourceActionGuideWindow,selectGuidedSourceAction} from '../local-processor/source-action-selection.mjs';
import {ACTION_GUIDANCE_VERSION,actionGuidanceKey,matchingActionGuidance,actionGuidanceRequest,
  observeValidatedActionGuidance,applySavedActionGuidance,actionGuideObservationKey,
  matchingActionGuideObservation,sharedActionGuideObservation} from '../local-processor/action-guidance.mjs';

const source=await readFile(new URL('../local-processor/server.mjs',import.meta.url),'utf8');
const start=source.indexOf('async function prepareGuidedSourceSelection(');
const end=source.indexOf('async function prepareHybridActionGuide(',start);
const candidate=(id,eventType,startTime)=>({id,storyId:id,eventType,startTime,endTime:startTime+8,
  semanticVerified:true,actionComplete:true,keepDecision:'keep',
  trackingBrief:{originTime:startTime,contactTime:startTime+3},
  sourceSelectionEvidence:{version:INITIAL_SECTION_VERSION,
    observation:{initiatorAndBallVisible:true,setup:'The player controls the ball.',outcome:eventType}}});
const anchor=(time,phase)=>({time,phase,ball:[400,400,410,410],player:[300,380,450,420],
  goalmouth:[300,600,500,800],description:`Observed ${phase} of the source action`});

function harness(outcomes) {
  const calls=[],writes=[];
  const context=vm.createContext({sourceContentFingerprint:async()=>({sha256:'source-bytes',size:1234}),
    mapWithConcurrency,fastTracking:{reviewModel:'scoring-review',reviewConcurrency:2},
    process:{env:{GEMINI_DISCOVERY_MODEL:'section-discovery'}},outputRoot:'outputs',
    sourceActionGuideWindow,selectGuidedSourceAction,initialScoringCoverage,selectInitialActionViews,
    join:(...parts)=>parts.join('/'),writeFile:async(path,body)=>writes.push({path,body:JSON.parse(body)}),
    prepareHybridActionGuide:async(_path,window,_job,options)=>{
      calls.push({id:window.id,...options});
      return {...window,actionGuidance:{guide:{sourceType:'broadcast',
        outcome:outcomes[window.id],uncertainties:[],
        anchors:[anchor(1,'setup'),anchor(4,'contact'),anchor(7,'payoff')]}}};
    }});
  return {calls,writes,run:vm.runInContext(`${source.slice(start,end)}\nprepareGuidedSourceSelection`,context)};
}

test('actual pre-lock handoff resolves a false scoring hypothesis with authoritative evidence, retaining actual goals',async()=>{
  const {run,calls,writes}=harness({first:'goal',corner:'blocked',shot:'save'});
  const result=await run('source.mp4',[
    candidate('first','goal',10),candidate('corner','disallowed_goal',30),candidate('shot','shot_on_target',50),
  ],{duration:90},'job');
  assert.deepEqual(calls.map(({id,model})=>({id,model})),[
    {id:'first',model:'scoring-review'},{id:'corner',model:'scoring-review'},
    {id:'shot',model:'section-discovery'},
  ]);
  assert.equal(result[0].eventType,'goal');
  assert.equal(result[1].eventType,'big_chance');
  assert.equal(result[2].eventType,'save');
  assert.ok(result.every(scene=>!scene.selectionLocked));
  assert.equal(writes.length,1);
  assert.equal(writes[0].body.broadDiscoveryRepeated,false);
  assert.ok(writes[0].body.decisions.every(decision=>decision.scene));
});

test('actual pre-lock handoff cannot silently omit an unresolved observed goal',async()=>{
  const {run,writes}=harness({goal:'uncertain'});
  await assert.rejects(run('source.mp4',[candidate('goal','goal',10)],{duration:90},'job'),
    error=>error.code==='SOURCE_SELECTION_CONFLICT');
  assert.equal(writes[0].body.decisions[0].scene,null);
  assert.equal(writes[0].body.decisions[0].reason,'source_goal_outcome_unresolved');
});

test('actual server archives an invalid response, corrects that same clip and caches validated action evidence',async()=>{
  const first=source.indexOf('async function prepareHybridActionGuide(');
  const last=source.indexOf('async function verifyHybridScene(',first);
  const files=new Map(),calls=[],updates=[],runs=[];
  const invalid={sourceType:'broadcast',outcome:'goal',uncertainties:[],
    anchors:[anchor(0,'setup'),anchor(3,'contact'),anchor(6,'payoff')]};
  invalid.anchors[1].ball=[400,400,400,410];
  const valid=structuredClone(invalid);valid.anchors[1].ball=[400,400,410,410];
  const context=vm.createContext({ACTION_GUIDANCE_VERSION,actionGuidanceKey,matchingActionGuidance,
    actionGuidanceRequest,observeValidatedActionGuidance,applySavedActionGuidance,
    actionGuideObservationKey,matchingActionGuideObservation,sharedActionGuideObservation,
    pendingActionGuideObservations:new Map(),outputRoot:'outputs',
    sourceContentFingerprint:async()=>({sha256:'uploaded-bytes',size:1234}),
    mkdir:async()=>{},join:(...parts)=>parts.join('/'),splitSceneInput:()=>null,
    fastTracking:{reviewModel:'model'},process:{env:{}},ffmpegPath:'ffmpeg',
    run:async(...args)=>runs.push(args),createGeminiClient:()=>({}),
    readJob:async()=>({id:'job',stage:'detecting_moments',progress:30}),
    updateJob:async(_job,_stage,_progress,detail)=>updates.push(detail),
    readFile:async path=>{
      if(path.endsWith('.source.mp4'))return Buffer.from('source clip');
      if(!files.has(path))throw new Error('ENOENT');
      return files.get(path);
    },writeFile:async(path,body)=>files.set(path,body),
    generateGeminiJson:async(_ai,request,label)=>{
      calls.push({request,label});
      if(calls.length===2) {
        assert.ok([...files.keys()].some(path=>path.endsWith('.response-1.json')));
        assert.match(request.contents.at(-1).text,/ball box at anchor 2/);
        assert.deepEqual(request.contents[0],calls[0].request.contents[0]);
      }
      return {parsed:calls.length===1?invalid:valid};
    }});
  const run=vm.runInContext(`${source.slice(first,last)}\nprepareHybridActionGuide`,context);
  const scene=candidate('scoring-action','goal',10);
  const observed=await run('upload.mp4',scene,'job',{sourceSelection:true,index:1,total:1});
  assert.equal(calls.length,2);assert.equal(runs.length,1);
  assert.deepEqual(observed.actionGuidance.guide.anchors[1].ball,valid.anchors[1].ball);
  assert.equal(observed.startTime,scene.startTime);assert.equal(observed.endTime,scene.endTime);
  assert.ok(updates.some(update=>/Correcting coordinate response/.test(update.progressDetail)));
  const archived=[...files.entries()].filter(([path])=>path.includes('.response-')).map(([,body])=>JSON.parse(body));
  assert.equal(archived.length,2);assert.deepEqual(archived[0].raw,invalid);
  assert.equal(archived[0].sourceStartTime,10);assert.equal(archived[0].sourceEndTime,18);
  assert.equal(archived[0].key,archived[1].key);
  const reused=await run('upload.mp4',scene,'job',{sourceSelection:true});
  assert.equal(calls.length,2);assert.deepEqual(JSON.parse(JSON.stringify(reused.actionGuidance.guide)),valid);
});
