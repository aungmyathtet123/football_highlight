import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from 'node:fs';
import { durationOnlyRecovery, durationRecoveryWindowLimit, boundedRecoveryWindows, coverageCandidateState, coverageRecoveryWindows, isDurationRecoveryAction, scenesNeedingCoverageRecovery, goalRecoveryWindow } from "../local-processor/coverage-recovery.mjs";

test('a small duration deficit does not reopen rejected goal guesses after real goal coverage',()=>{
  const ledger={anchors:[{id:'goal',status:'provisional',before:{time:90},after:{time:110}}]};
  const goal={startTime:94,endTime:99,eventType:'goal',semanticVerified:true,actionComplete:true,keepDecision:'keep'};
  assert.equal(durationOnlyRecovery(ledger,[goal]),true);
  for(const patch of [{semanticVerified:false},{actionComplete:false},{isReplay:true}])
    assert.equal(durationOnlyRecovery(ledger,[{...goal,...patch}]),false);
  assert.equal(durationOnlyRecovery({anchors:[]},[]),false);
  assert.equal(durationRecoveryWindowLimit(1.1),1);
  assert.equal(durationRecoveryWindowLimit(20),2);
  assert.equal(durationRecoveryWindowLimit(80),4);
});

test('a partial scorebug ledger cannot suppress missing-goal recovery for an explicitly scored upload',()=>{
  const ledger={anchors:[{id:'fourth',status:'provisional',before:{time:90},after:{time:110}}]};
  const goal={id:'g4',storyId:'g4',startTime:94,endTime:99,eventType:'goal',semanticVerified:true,actionComplete:true,keepDecision:'keep'};
  assert.equal(durationOnlyRecovery(ledger,[goal],4),false);
  assert.equal(durationOnlyRecovery(ledger,[goal],1),true);
});

test('long recovery searches retain all source coverage in bounded overlapping previews', () => {
  const windows=boundedRecoveryWindows([{startTime:39.6,endTime:182}],338.9);
  assert.equal(windows[0].startTime,39.6);
  assert.equal(windows.at(-1).endTime,182);
  assert.ok(windows.every(w=>w.endTime-w.startTime<=42));
  for(let time=39.6;time<=182;time+=.1) assert.ok(windows.some(w=>time>=w.startTime&&time<=w.endTime));
  for(let i=1;i<windows.length;i++) assert.ok(windows[i-1].endTime-windows[i].startTime>=9.99);
  assert.deepEqual(boundedRecoveryWindows([{startTime:-3,endTime:900},{startTime:0,endTime:900}],20),[{startTime:0,endTime:20}]);
  assert.deepEqual(boundedRecoveryWindows([{startTime:NaN,endTime:5},{startTime:5,endTime:4},{startTime:0,endTime:1}],20),[]);
});

test('recovery encoder bounds bitrate and regenerates oversized cached previews',()=>{
  const server=readFileSync(new URL('../local-processor/server.mjs',import.meta.url),'utf8');
  const start=server.indexOf('async function createRecoveryProxies');
  const body=server.slice(start,server.indexOf('function buildAnalysisPrompt',start));
  assert.ok(body.includes('boundedRecoveryWindows(windows, media.duration)'));
  assert.ok(body.includes('info.size > 15 * 1024 * 1024'));
  assert.ok(body.includes('"-maxrate", "850k", "-bufsize", "1700k"'));
});

test('unreviewed and deferred proposals never conceal missing duration coverage',()=>{
  const base={startTime:0,endTime:90,keepDecision:'keep'};
  assert.equal(coverageCandidateState(base),'pending');
  assert.equal(coverageCandidateState({...base,semanticVerified:true}),'verified');
  for(const patch of [{sourceAngleDeferred:true},{sourceSupportDeferred:true},{actionComplete:false},
    {goalOutcomeCrosscheck:{verified:false}}]) {
    assert.equal(coverageCandidateState({...base,semanticVerified:true,...patch}),'pending');
  }
  assert.equal(coverageCandidateState({...base,semanticVerified:false}),'rejected');
  const verified={startTime:90,endTime:100,semanticVerified:true};
  for(const candidate of [base,{...base,semanticVerified:true,sourceAngleDeferred:true}]) {
    const windows=coverageRecoveryWindows([candidate,verified],100);
    assert.ok(windows.some(window=>window.startTime<=30&&window.endTime>=30));
    assert.ok(windows.every(window=>window.endTime<=90));
  }
});

test("goal recovery does not re-search rejected optional actions when coverage is sufficient", () => {
  const scenes=[{eventType:'goal'},{eventType:'save'},{eventType:'disallowed_goal'},{eventType:'shot_off_target'}];
  assert.deepEqual(scenesNeedingCoverageRecovery(scenes,0),[scenes[0],scenes[2]]);
  assert.deepEqual(scenesNeedingCoverageRecovery(scenes,4),scenes);
});

test("a later replay's recovery includes the live buildup rather than starting at its finish", () => {
  const window=goalRecoveryWindow(141.8,148.42,338.9,5);
  assert.ok(window.startTime<90);
  assert.equal(window.endTime,153.42);
  assert.equal(goalRecoveryWindow(27,36,60).startTime,0);
  assert.equal(goalRecoveryWindow(55,59,60).endTime,60);
});

test("completed recovery excerpts are saved independently and restored only with matching evidence", () => {
  const server=readFileSync(new URL('../local-processor/server.mjs',import.meta.url),'utf8');
  const start=server.indexOf('async function discoverAdditionalCandidatesWithGemini');
  const discovery=server.slice(start,server.indexOf('async function createRecoveryProxies',start));
  assert.ok(discovery.includes('sourcePath,size:sourceInfo.size,modified:sourceInfo.mtimeMs'));
  assert.ok(discovery.includes('saved.key === recoveryKey'));
  assert.ok(discovery.includes('await writeFile(recoveryCachePath, JSON.stringify({key:recoveryKey,parsed}))'));
  assert.ok(discovery.indexOf('await writeFile(recoveryCachePath')<discovery.indexOf('return filterUnprovedRecoveryGoals'));
});

test("duration recovery targets unselected action between verified scenes", () => {
  const windows = coverageRecoveryWindows([
    { startTime: 47.7, endTime: 59.4, keepDecision: "keep", semanticVerified: true },
    { startTime: 83.3, endTime: 103.5, keepDecision: "keep", semanticVerified: true },
    { startTime: 106.3, endTime: 156.9, keepDecision: "keep", semanticVerified: true },
  ], 162);
  assert.ok(windows.some(window => window.startTime < 15 && window.endTime > 15));
  assert.ok(windows.some(window => window.startTime < 35 && window.endTime > 35));
  assert.ok(windows.some(window => window.startTime < 70 && window.endTime > 70));
  assert.ok(windows.every(window => window.endTime - window.startTime <= 45));
});

test("recovery does not search fully covered footage or tiny trailing gaps", () => {
  assert.deepEqual(coverageRecoveryWindows([{ startTime: 0, endTime: 60, semanticVerified: true }], 65), []);
  assert.deepEqual(coverageRecoveryWindows([{ startTime: 0, endTime: 60, semanticVerified: true }], 60), []);
});
test('a small duration shortfall searches between football actions before a longer full-time tail',()=>{
  const scene=(startTime,endTime)=>({startTime,endTime,semanticVerified:true,actionComplete:true,eventType:'save'});
  const windows=coverageRecoveryWindows([scene(10,15),scene(25,30),scene(48,54),scene(70,80)],120,{limit:1});
  assert.deepEqual(windows,[{startTime:30,endTime:48}]);
});
test('short interior gaps cannot repeatedly hide the opening match chances',()=>{
  const scene=(startTime,endTime)=>({startTime,endTime,semanticVerified:true,actionComplete:true,eventType:'save'});
  const windows=coverageRecoveryWindows([scene(26.35,29.95),scene(30.45,33.35),
    scene(43.9,47),scene(49.01,52.5),scene(64,69.25),scene(79.6,83.25),
    scene(89.5,98.2),scene(108.5,114.8)],162,{limit:2,contextSeconds:2});
  assert.ok(windows.some(window=>window.startTime===0&&window.endTime>=26.35));
  assert.ok(windows.every(window=>window.endTime<116.8));
});
test('duration-only recovery cannot use celebrations, statistics or repeated goals as extra gameplay',()=>{
  for(const eventType of ['save','tackle','normal_play','shot_on_target','free_kick'])
    assert.equal(isDurationRecoveryAction({eventType,storyPhase:'action'}),true);
  for(const eventType of ['celebration','goal','disallowed_goal','var','offside','red_card','unknown'])
    assert.equal(isDurationRecoveryAction({eventType,storyPhase:'action'}),false);
  assert.equal(isDurationRecoveryAction({eventType:'normal_play',storyPhase:'reaction'}),false);
});

test('completed searches rotate to another gap and eventually exhaust rather than repeat',()=>{
  const scene=(startTime,endTime)=>({startTime,endTime,semanticVerified:true});
  const candidates=[scene(10,15),scene(25,30),scene(48,54),scene(70,80)];
  const searchedWindows=[];
  for(let i=0;i<20;i++) {
    const windows=coverageRecoveryWindows(candidates,100,{limit:1,minimumGap:4,contextSeconds:2,searchedWindows});
    if(!windows.length) break;
    assert.ok(!searchedWindows.some(w=>w.startTime===windows[0].startTime&&w.endTime===windows[0].endTime));
    searchedWindows.push(...windows);
  }
  assert.ok(searchedWindows.length>3,'must not stop at an arbitrary three attempts');
  assert.deepEqual(coverageRecoveryWindows(candidates,100,{limit:1,minimumGap:4,contextSeconds:2,searchedWindows}),[]);
});

test('overlapping search history is unioned without double-counting coverage',()=>{
  const candidates=[{startTime:20,endTime:25,semanticVerified:true}];
  const windows=coverageRecoveryWindows(candidates,25,{limit:1,
    searchedWindows:[{startTime:0,endTime:8},{startTime:2,endTime:10}]});
  assert.deepEqual(windows,[{startTime:0,endTime:20}]);
});

test('dense recovery encodes the same fps that Gemini observes and persists completed window history',()=>{
  const server=readFileSync(new URL('../local-processor/server.mjs',import.meta.url),'utf8');
  assert.ok(server.includes("(purpose==='action_duration'||purpose==='goal_count') ? 8 : analysisFps"));
  assert.ok(server.includes('recoveryWindows, recoveryFps)'));
  assert.ok(server.includes('fps=${fps}:start_time=0:round=up'));
  assert.ok(server.includes('searchedWindows:await completedDurationSearchWindows(id)'));
  assert.ok(!server.includes('recoveryPass > 3'));
});
