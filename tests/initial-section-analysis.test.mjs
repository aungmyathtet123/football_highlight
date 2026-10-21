import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {hasShortSelectionConsent} from '../local-processor/short-selection-consent.mjs';
import {RESTART_ACTION_VERSION,normalizeInitialRestartAction,restartActionMetadata} from '../local-processor/restart-action.mjs';
import {INITIAL_SECTION_SCHEMA,INITIAL_SECTION_VERSION,initialObservationProblems,initialScoringObservations,initialScoringCoverage,
  observeInitialSections,selectInitialActionViews} from '../local-processor/initial-section-analysis.mjs';
import {needsSemanticReview,semanticSignature} from '../local-processor/pipeline-state.mjs';
import {step1DiscoveryPlan,sectionSelectionSummary} from '../local-processor/step1-discovery-plan.mjs';
import {sourceGoalCountCoverage} from '../local-processor/goal-count-evidence.mjs';
import {inventoryForExcerpt,passageFitsShotSequence} from '../local-processor/passage-inventory.mjs';
import {stableSignature} from '../local-processor/pipeline-state.mjs';
import {initialDiscoveryFps,restoreInitialSectionResponse} from '../local-processor/gemini-workload-policy.mjs';

const draft=(patch={})=>({startTime:2,endTime:12,eventType:'goal',storyId:'goal-1',shotIds:['shot-1'],
  actionComplete:true,keepDecision:'keep',confidence:.9,ballVisible:true,mainPlayerVisible:true,
  sourceObservation:{setup:'The attacker controls the ball.',continuation:'The shot travels toward goal.',
    result:'The ball enters the net.',outcome:'goal',initiatorAndBallVisible:true,continuationVisible:true,resultVisible:true},
  trackingBrief:{originTime:3,contactTime:6,flightStartTime:6,payoffStartTime:8,payoffEndTime:11},...patch});
const scene=(id,start,eventType='goal',patch={})=>({id,storyId:id,startTime:start,endTime:start+10,eventType,
  actionComplete:true,keepDecision:'keep',semanticVerified:true,confidence:.9,
  sourceSelectionEvidence:{version:INITIAL_SECTION_VERSION,provider:'gemini_initial_section_video'},
  trackingBrief:{contactTime:start+4},...patch});

test('initial observation requires visible complete phases and real clocks, not normalized defaults',()=>{
  assert.deepEqual(initialObservationProblems(draft(),30),[]);
  assert.ok(initialObservationProblems(draft({trackingBrief:{}}),30).includes('invalid_action_phase_clock'));
  assert.ok(initialObservationProblems(draft({ballVisible:false}),30).includes('missing_visible_action_phase'));
  assert.ok(initialObservationProblems(draft({startTime:-1}),30).includes('invalid_excerpt_clock'));
  assert.ok(initialObservationProblems(draft({confidence:null}),30).includes('invalid_confidence'));
  assert.ok(initialObservationProblems(draft({eventType:'save'}),30).includes('outcome_class_conflict'));
});

test('crosses and rebounds retain a complete goal when goalmouth attention starts before the scoring touch',()=>{
  for(const brief of [
    {originTime:3,flightStartTime:5,contactTime:8,payoffStartTime:7.5,payoffEndTime:11},
    {originTime:3,flightStartTime:5,contactTime:8.2,payoffStartTime:8,payoffEndTime:11},
  ]) assert.deepEqual(initialObservationProblems(draft({trackingBrief:brief}),30),[]);
  assert.ok(initialObservationProblems(draft({trackingBrief:{originTime:3,flightStartTime:5,
    contactTime:8,payoffStartTime:6,payoffEndTime:7}}),30).includes('invalid_action_phase_clock'));
});

test('raw observed goals remain obligations even if local validation rejects their action clocks',()=>{
  const raw=draft({trackingBrief:{originTime:3,flightStartTime:5,contactTime:8,payoffStartTime:6,payoffEndTime:7}});
  const observations=initialScoringObservations({moments:[raw]},100,1);
  assert.equal(observations[0].contactTime,108);
  const missing=initialScoringCoverage(observations,[]);
  assert.equal(missing.required,1);assert.equal(missing.complete,false);
  const accepted=scene('g',102,'goal',{endTime:112,trackingBrief:{contactTime:108},
    sourceAngleSelected:true,storyId:observations[0].storyId});
  assert.equal(initialScoringCoverage(observations,[accepted]).complete,true);
  for(const patch of [{semanticVerified:false},{actionComplete:false},{sourceAngleDeferred:true},
    {sourceSupportDeferred:true},{keepDecision:'reject'}])
    assert.equal(initialScoringCoverage(observations,[{...accepted,...patch}]).complete,false);
});

test('initial scoring ledger includes disallowed goals but does not invent a goal from celebration footage',()=>{
  const observations=initialScoringObservations({moments:[draft(),draft({eventType:'disallowed_goal',
    sourceObservation:{...draft().sourceObservation,outcome:'disallowed_goal'}}),
    draft({eventType:'celebration',storyPhase:'reaction',sourceObservation:{...draft().sourceObservation,outcome:'celebration'}})]});
  assert.deepEqual(observations.map(item=>item.eventType),['goal','disallowed_goal']);
  assert.equal(initialScoringCoverage(observations,[]).required,2);
});

test('initial scoring ledger deduplicates source overlap and explicit replays, never separate live goals',()=>{
  const raw=draft();
  const first=initialScoringObservations({moments:[raw]});
  const overlap=initialScoringObservations({moments:[{...raw,storyId:'overlap',startTime:2.1,
    trackingBrief:{...raw.trackingBrief,contactTime:6.1}}]},0,1);
  const replay=initialScoringObservations({moments:[{...raw,storyId:'replay',isReplay:true,
    startTime:20,endTime:30,trackingBrief:{...raw.trackingBrief,contactTime:24}}]});
  const second=initialScoringObservations({moments:[{...raw,storyId:'second',startTime:32,endTime:42,
    trackingBrief:{...raw.trackingBrief,contactTime:36}}]});
  assert.equal(initialScoringCoverage([...first,...overlap,...replay,...second],[]).required,2);
});

test('observe once per section, including empty sections; restarting reuses every completed response',async()=>{
  const saved=new Map(),calls=[];
  const options={sections:[0,1,2],readCached:async section=>saved.get(section),
    observe:async section=>{calls.push(section);return {moments:section===1?[]:[draft()]};},
    save:async(section,_index,value)=>saved.set(section,value),consume:async value=>value};
  await observeInitialSections(options);
  await observeInitialSections(options);
  assert.deepEqual(calls,[0,1,2]);assert.equal(saved.size,3);
});

test('a provider interruption retries only the unfinished section, without repeating earlier paid work',async()=>{
  const saved=new Map(),calls=[];let interrupt=true;
  const options={sections:[0,1,2],readCached:async section=>saved.get(section),
    observe:async section=>{calls.push(section);if(section===1&&interrupt){interrupt=false;throw Error('503');}return {moments:[]};},
    save:async(section,_index,value)=>saved.set(section,value),consume:async value=>value};
  await assert.rejects(observeInitialSections(options),/503/);
  await observeInitialSections(options);
  assert.deepEqual(calls,[0,1,1,2]);
});

test('persist successful raw responses before local validation; never regenerate them on interpretation errors',async()=>{
  const saved=new Map();let calls=0;
  const options={sections:[0],readCached:async section=>saved.get(section),
    observe:async()=>{calls++;return {malformedContract:true};},save:async(section,_index,value)=>saved.set(section,value),
    consume:async()=>{throw Error('needs source attention');}};
  await assert.rejects(observeInitialSections(options));await assert.rejects(observeInitialSections(options));
  assert.equal(calls,1);assert.equal(saved.size,1);
});

test('select one view per incident and deduplicate section overlap without merging separate shots',()=>{
  const a=scene('g1',10),duplicate=scene('overlap-g1',10.1),replay=scene('replay',40,'goal',{storyId:'g1',isReplay:true}),
    b=scene('g2',110),chance=scene('chance',200,'save');
  const selected=selectInitialActionViews([a,duplicate,replay,b,chance]).filter(s=>s.sourceAngleSelected);
  assert.deepEqual(selected.map(s=>s.id),['g1','g2','chance']);
  assert.equal(sourceGoalCountCoverage(selected,2).complete,true);
});

test('a complete replay can be the primary goal without fabricating a scoreboard anchor',()=>{
  const result=selectInitialActionViews([scene('g1',10,'goal',{isReplay:true,storyPhase:'replay'})]);
  assert.equal(result[0].chosenIncidentAngle,true);
  assert.equal(result[0].sourceScoreAnchorId,undefined);
  assert.equal(sourceGoalCountCoverage(result,1).complete,true);
});

test('first selection favours the clearest complete portrait-readable angle, not a difficult first view',()=>{
  const live=scene('live',10,'goal',{storyId:'same',sourceSelectionEvidence:{version:INITIAL_SECTION_VERSION,
    observation:{portraitReadability:35,framingNotes:'The receiver and decisive ball are hidden'}}});
  const replay=scene('clear-replay',35,'goal',{storyId:'same',isReplay:true,
    sourceSelectionEvidence:{version:INITIAL_SECTION_VERSION,
      observation:{portraitReadability:95,framingNotes:'Complete pass, shot, ball flight and keeper result are clearly visible'}}});
  const selected=selectInitialActionViews([live,replay]).filter(item=>item.sourceAngleSelected);
  assert.deepEqual(selected.map(item=>item.id),['clear-replay']);
  assert.equal(selected[0].startTime,35);assert.equal(selected[0].endTime,45);
});

test('a next-section explicit replay is not counted as a new goal or selected a second time',()=>{
  const result=selectInitialActionViews([scene('live',140),
    scene('new-section-replay',165,'goal',{isReplay:true,storyPhase:'replay'})]);
  assert.deepEqual(result.filter(s=>s.sourceAngleSelected).map(s=>s.id),['live']);
  assert.equal(sourceGoalCountCoverage(result,1).observed,1);
});

test('reactions remain linked support after a goal, never goal evidence or unrelated duration filler',()=>{
  const result=selectInitialActionViews([scene('goal',10),scene('celebrate',20,'celebration',{storyId:'goal',endTime:23}),
    scene('unrelated',31,'celebration',{storyId:'goal'})]);
  assert.deepEqual(result.filter(s=>s.sourceAngleSelected).map(s=>s.id),['goal','celebrate']);
});

test('retry does not demand an independent source review for intact initial observations',()=>{
  const s=scene('g',10);s.sourceSelectionEvidence={...s.sourceSelectionEvidence,independentReview:false,
    sourceFingerprint:'hash',model:'configured',startTime:10,endTime:20};s.semanticSignature=semanticSignature(s);
  assert.equal(needsSemanticReview(s),false);
  assert.equal(needsSemanticReview({...s,eventType:'save'}),true);
  assert.equal(needsSemanticReview({...s,startTime:9}),true);
  assert.equal(needsSemanticReview(s,'different-model'),true);
});

test('initial schema accepts variable action count and requires source observation, not a per-shot audit',()=>{
  assert.equal(INITIAL_SECTION_SCHEMA.properties.moments.minItems,undefined);
  assert.equal(INITIAL_SECTION_SCHEMA.properties.moments.maxItems,undefined);
  assert.ok(INITIAL_SECTION_SCHEMA.properties.moments.items.required.includes('sourceObservation'));
  assert.equal(INITIAL_SECTION_SCHEMA.properties.shotAudit,undefined);
  assert.equal(INITIAL_SECTION_SCHEMA.properties.moments.items.properties.trackingBrief.type,'object');
  assert.deepEqual(INITIAL_SECTION_SCHEMA.properties.moments.items.properties.trackingBrief.required,
    ['originTime','contactTime','flightStartTime','payoffStartTime','payoffEndTime']);
});

test('selection section boundaries match the actual proxy overlap, including a partial final section',()=>{
  const plan=step1DiscoveryPlan(625,60,180,4);
  assert.deepEqual(plan.sections.map(s=>s.startTime),[0,176,352,528]);
  assert.deepEqual(plan.sections.map(s=>s.coreEnd),[176,352,528,625]);
});

const server=await readFile(new URL('../local-processor/server.mjs',import.meta.url),'utf8');
test('full recap initial path bypasses scoreboard, semantic reels, goal checks and all rediscovery loops',async()=>{
  const start=server.indexOf('    const initialSectionWorkflow =');
  const end=server.indexOf('    // A previous pre-handoff failure',start);
  const branch=server.slice(start,end).replace(/\} else \{\s*$/,'}');
  let initialRequests=0;
  const context=vm.createContext({hasShortSelectionConsent,geminiEnabled:true,hybridKeyframing:false,fastTracking:{enabled:false},isCompleteHighlights:()=>true,
    INITIAL_SECTION_VERSION,job:{settings:{commentary:true},sourceName:'test',sourceKey:'source',warnings:[]},
    id:'id',outputRoot:'outputs',media:{duration:600},candidates:[scene('g1',10)],overlayMasks:[],
    selectInitialActionViews,chooseInitialScenesForLock:v=>v.map(s=>({...s,sceneSelectionApproved:true})),
    applyCompleteDurationBounds:v=>v,semanticSignature,sourceGoalCountCoverage,initialScoringCoverage,goalTotalFromFilename:()=>1,
    join:(...v)=>v.join('/'),writeFile:async()=>{},
    analyzePassageInventoryWithGemini:async()=>{initialRequests++;throw Error('unneeded analysis');}});
  await vm.runInContext(`(async()=>{${branch}})()`,context);
  assert.equal(initialRequests,0);
  for(const forbidden of ['verifyCandidateSemanticsWithGemini','verifyIndependentGoalOutcomes','observeSourceScore',
    'discoverRecapExtraActions','discoverAdditionalCandidatesWithGemini']) assert.ok(!branch.includes(forbidden));
});

test('initial inventory performs one JSON attempt and no audit-correction request',()=>{
  const body=server.slice(server.indexOf('async function analyzePassageInventoryWithGemini('),server.indexOf('async function analyzeWithGemini('));
  assert.match(body,/generateGeminiJson\(ai,request,`Gemini initial source section \$\{index\+1\}`,1\)/);
  assert.doesNotMatch(body,/Correct the inventory|correction excerpt|verifyCandidateSemantics|concat/);
  assert.match(body,/independentReview:false/);
});

test('actual Step-1 handoff cannot declare zero goals complete after rejecting two observed goals',async()=>{
  const start=server.indexOf('    const initialSectionWorkflow =');
  const end=server.indexOf('    // A previous pre-handoff failure',start);
  const branch=server.slice(start,end).replace(/\} else \{\s*$/,'}');
  const reports=[];
  const scoringObservations=initialScoringObservations({moments:[draft(),draft({storyId:'second',
    startTime:20,endTime:30,trackingBrief:{originTime:21,flightStartTime:23,contactTime:25,payoffStartTime:24.5,payoffEndTime:28}})]});
  const context=vm.createContext({hasShortSelectionConsent,geminiEnabled:true,hybridKeyframing:false,fastTracking:{enabled:false},
    isCompleteHighlights:()=>true,INITIAL_SECTION_VERSION,
    job:{settings:{commentary:true},sourceName:'Teams Highlights.mp4',warnings:[],
      passageInventorySummary:{scoringObservations}},id:'id',outputRoot:'outputs',media:{duration:600},
    candidates:[scene('chance',100,'save')],selectInitialActionViews,
    chooseInitialScenesForLock:v=>v.map(s=>({...s,sceneSelectionApproved:true})),
    applyCompleteDurationBounds:v=>v,semanticSignature,sourceGoalCountCoverage,initialScoringCoverage,
    goalTotalFromFilename:()=>null,join:(...v)=>v.join('/'),
    writeFile:async(_path,value)=>reports.push(JSON.parse(value))});
  await assert.rejects(vm.runInContext(`(async()=>{${branch}})()`,context),/omitted 2 observed scoring incident/);
  assert.equal(reports[0].complete,false);assert.equal(reports[0].expectedTotalKnown,false);
  assert.equal(reports[0].observedScoringCoverage.required,2);
});

test('hybrid scene guidance finishes before view choice and scene locking',async()=>{
  const start=server.indexOf('    const initialSectionWorkflow =');
  const end=server.indexOf('    // A previous pre-handoff failure',start);
  const branch=server.slice(start,end).replace(/\} else \{\s*$/,'}');
  const order=[];
  const context=vm.createContext({hasShortSelectionConsent,geminiEnabled:true,hybridKeyframing:true,fastTracking:{enabled:true},
    isCompleteHighlights:()=>true,INITIAL_SECTION_VERSION,
    job:{settings:{commentary:true},sourceName:'test',sourceKey:'source',warnings:[]},
    id:'id',outputRoot:'outputs',media:{duration:600},candidates:[scene('g1',10)],overlayMasks:[],
    prepareGuidedSourceSelection:async(_source,candidates)=>{
      order.push('guide');assert.ok(candidates.every(s=>!s.selectionLocked));
      return candidates.map(s=>({...s,testGuided:true}));
    },
    selectInitialActionViews:candidates=>{order.push('choose_view');return selectInitialActionViews(candidates);},
    chooseInitialScenesForLock:candidates=>{order.push('lock');assert.ok(candidates.every(s=>s.testGuided));
      return candidates.map(s=>({...s,sceneSelectionApproved:true}));},
    applyCompleteDurationBounds:v=>v,semanticSignature,sourceGoalCountCoverage,initialScoringCoverage,goalTotalFromFilename:()=>1,
    join:(...v)=>v.join('/'),writeFile:async()=>{},
    analyzePassageInventoryWithGemini:async()=>{throw Error('Completed initial sections must not repeat');}});
  await vm.runInContext(`(async()=>{${branch}})()`,context);
  assert.deepEqual(order,['guide','choose_view','lock']);
});

test('actual initial inventory executes one request for each of four source sections and caches the result',async()=>{
  const body=server.slice(server.indexOf('async function analyzePassageInventoryWithGemini('),server.indexOf('async function analyzeWithGemini('));
  const files=new Map(),calls=[],progress=[],proxyProfiles=[];
  const sections=step1DiscoveryPlan(625,60,180,30).sections;
  const context=vm.createContext({RESTART_ACTION_VERSION,normalizeInitialRestartAction,restartActionMetadata,INITIAL_SECTION_VERSION,INITIAL_SECTION_SCHEMA,initialObservationProblems,initialScoringObservations,initialScoringCoverage,
    observeInitialSections,selectInitialActionViews,step1DiscoveryPlan,sectionSelectionSummary,inventoryForExcerpt,passageFitsShotSequence,
    stableSignature,semanticSignature,initialDiscoveryFps:()=>3,restoreInitialSectionResponse,geminiEnabled:true,analysisFps:3,analysisHeight:480,
    analysisChunkSeconds:180,analysisChunkOverlap:4,MAX_SCENE_SECONDS:30,passageInventoryVersion:4,passageInventoryExcerptVersion:3,
    UNIFIED_DISCOVERY_VERSION:1,outputRoot:'outputs',geminiRequestTimeoutMs:180000,
    geminiWorkloadModel:()=> 'configured',sourceContentFingerprint:async()=> 'hash',join:(...v)=>v.join('/'),
    readFile:async path=>{if(path.startsWith('proxy'))return Buffer.from('video');if(!files.has(path))throw Error('ENOENT');return files.get(path);},
    writeFile:async(path,value)=>files.set(path,value),mkdir:async()=>{},
    loadBroadcastShotInventory:async()=>[{shotId:'shot-0001',startTime:0,endTime:625,duration:625}],
    loadSoccerNetActionAnchors:async()=>({anchors:[]}),createGeminiClient:()=>({}),
    createAnalysisProxies:async(...args)=>{proxyProfiles.push(args.at(-1));return sections.map((section,index)=>({...section,path:'proxy-'+index}));},
    readJob:async()=>({sourceName:'two-teams.mp4'}),updateJob:async(_job,_stage,_percent,patch)=>progress.push(patch),
    buildPassageInventoryPrompt:()=> 'initial contract',footballVideoPart:(data,fps)=>({video:data,videoMetadata:{fps}}),geminiVideoDeadline:()=>180000,
    generateGeminiJson:async(_client,request,label,attempts)=>{calls.push({request,label,attempts});
      return {parsed:{watchedThroughSeconds:sections[Number(label.match(/section (\d+)/)[1])-1].duration,uncertainties:[],
        moments:[draft({shotIds:['shot-0001'],...(label.endsWith('section 1')?{eventType:'penalty'}:{})})]}};},
    normalizeInventoryPassages:(items,_media,section)=>items.map(item=>({...item,
      startTime:item.startTime+section.startTime,endTime:item.endTime+section.startTime,
      trackingBrief:{...item.trackingBrief,contactTime:item.trackingBrief.contactTime+section.startTime}})),
    normalizeMasks:()=>[],mergeOverlayMasks:v=>v,mergeAnalyzedMoments:v=>v,unifiedDiscoverySummary:v=>v,
  });
  const analyze=vm.runInContext(`${body}\nanalyzePassageInventoryWithGemini`,context);
  const result=await analyze('source',{duration:625},60,'job');
  assert.equal(result.moments[0].eventType,'goal');assert.equal(result.moments[0].restartType,'penalty_kick');
  assert.equal(result.moments[0].restartNormalization.sourceEventType,'penalty');
  assert.equal(calls.length,4);assert.ok(calls.every(call=>call.attempts===1));
  assert.equal(new Set(result.moments.map(scene=>scene.id)).size,4);
  assert.equal(result.moments[1].startTime,152);
  assert.ok(result.moments.every(scene=>scene.sourceSelectionEvidence.independentReview===false));
  assert.equal(result.passageInventorySummary.completedSections,4);
  assert.equal(progress.filter(patch=>patch.moments).length,4);
  await analyze('source',{duration:625},60,'job');assert.equal(calls.length,4);
  // Simulate a pre-metadata legacy checkpoint with only its first two sections
  // completed, then deploy Flash/2fps. Never re-send those two Pro/3fps calls.
  files.delete('outputs/job/passage-inventory.json');
  for(const index of [1,2]) {
    const path=`outputs/job/inventory-excerpts/excerpt-00${index}.json`;
    const value=JSON.parse(files.get(path));delete value.workload;delete value.inputKey;
    files.set(path,JSON.stringify(value));
  }
  for(const index of [3,4]) {
    files.delete(`outputs/job/inventory-excerpts/excerpt-00${index}.json`);
    files.delete(`outputs/job/inventory-excerpts/selection-00${index}.json`);
  }
  context.geminiWorkloadModel=role=>role==='framing'?'configured':'flash';
  context.initialDiscoveryFps=()=>2;
  const mixed=await analyze('source',{duration:625},60,'job');
  assert.equal(calls.length,6);
  assert.deepEqual(calls.slice(4).map(call=>call.label),['Gemini initial source section 3','Gemini initial source section 4']);
  assert.ok(calls.slice(4).every(call=>call.request.model==='flash'&&call.request.contents[0].videoMetadata.fps===2));
  assert.deepEqual(proxyProfiles,[3,2]);
  assert.deepEqual(Array.from(mixed.moments,scene=>scene.sourceSelectionEvidence.model),['configured','configured','flash','flash']);
  assert.deepEqual(Array.from(mixed.moments,scene=>scene.sourceSelectionEvidence.fps),[3,3,2,2]);
  await analyze('source',{duration:625},60,'job');assert.equal(calls.length,6);
});
