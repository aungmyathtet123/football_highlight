import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {renderedNarrationManifest,narrationSections,narrationSlotBudgets,recordTimedNarration,normalizeRecapResultEnding} from '../local-processor/completed-video-narration.mjs';
import {workflowPhase} from '../local-processor/workflow-progress.mjs';

const manifest={moments:[
  {candidateId:'goal',storyId:'one',eventType:'goal',output:{startTime:0,endTime:8}},
  {candidateId:'reaction',storyId:'one',eventType:'celebration',output:{startTime:7.8,endTime:10}},
  {candidateId:'chance',storyId:'two',eventType:'save',output:{startTime:9.8,endTime:15}},
]};
const result={timelineDuration:15,synchronization:[
  {momentId:'goal',visualStart:0,visualDuration:8},
  {momentId:'reaction',visualStart:8,visualDuration:2},
  {momentId:'chance',visualStart:10,visualDuration:5},
]};
const content={contentBeats:[
  {evidenceNeed:'goal',narration:'The early pass opens space for the finish.'},
  {evidenceNeed:'reaction',narration:'A quick start.'},
  {evidenceNeed:'chance',narration:'The goalkeeper pushes this dangerous strike away from goal.'},
]};

test('the ending separates a visible chance from an externally verified final result',()=>{
  const original={contentBeats:[{evidenceNeed:'chance',narration:'A free kick goes wide, sealing a two-two draw.'}]};
  const corrected=normalizeRecapResultEnding(original,{status:'verified',finalScore:'2-2'});
  assert.equal(corrected.contentScript,'A free kick goes wide. The match ends 2-2.');
  assert.equal(original.contentBeats[0].narration,'A free kick goes wide, sealing a two-two draw.');
  assert.equal(normalizeRecapResultEnding(original,{status:'unverified',finalScore:'2-2'}),original);
  assert.equal(normalizeRecapResultEnding(content,{status:'verified',finalScore:'2-2'}),content);
  assert.equal(normalizeRecapResultEnding({contentBeats:[{narration:'The shot misses. That seals the draw.'}]},
    {status:'verified',finalScore:'1-1'}).contentScript,'The shot misses. The match ends 1-1.');
  assert.equal(normalizeRecapResultEnding(original,{status:'verified',finalScore:'unknown'}),original);
});

test('the actual rendered clock replaces estimated overlap; missing or reordered footage cannot pass',()=>{
  const fixed=renderedNarrationManifest(manifest,result,15.03);
  assert.deepEqual(fixed.moments.map(scene=>scene.output.startTime),[0,8,10]);
  assert.equal(fixed.moments.at(-1).output.endTime,15.03);
  assert.equal(fixed.clockSource,'rendered_video');
  assert.throws(()=>renderedNarrationManifest(manifest,{...result,synchronization:result.synchronization.slice(1)},15));
  assert.throws(()=>renderedNarrationManifest(manifest,result,16));
  assert.throws(()=>renderedNarrationManifest(manifest,{...result,synchronization:[...result.synchronization].reverse()},15));
});

test('only a linked reaction shares a recording; a different chance always starts its own window',()=>{
  const fixed=renderedNarrationManifest(manifest,result,15);
  const sections=narrationSections(content,fixed);
  assert.equal(sections.length,2);
  assert.deepEqual(sections[0].ids,['goal','reaction']);
  assert.equal(sections[0].duration,10);
  assert.equal(sections[1].startTime,10);
  assert.throws(()=>narrationSections({contentBeats:content.contentBeats.slice(1)},fixed));
  const budgets=narrationSlotBudgets({slots:fixed.moments.map(scene=>({candidateId:scene.candidateId,...scene.output}))});
  assert.ok(budgets[0].suggestedWords>budgets[1].suggestedWords);
});

test('one overlong section is shortened while approved speech and every visual boundary remain unchanged',async()=>{
  const fixed=renderedNarrationManifest(manifest,result,15);
  const before=JSON.stringify(fixed);
  const calls=[],rewrites=[];
  const takes=await recordTimedNarration(content,fixed,{
    record:async section=>{calls.push(section.id);return {path:`${section.id}.wav`,duration:section.id==='chance'&&calls.filter(id=>id==='chance').length===1?7:section.duration-.15};},
    rewrite:async failed=>{rewrites.push(failed);return {chance:'The goalkeeper stops the shot.'};},
  });
  assert.deepEqual(calls,['goal','chance','chance']);
  assert.equal(rewrites.length,1);
  assert.deepEqual(rewrites[0].map(section=>section.id),['chance']);
  assert.equal(takes[0].startTime,0);assert.equal(takes[1].startTime,10);
  assert.equal(JSON.stringify(fixed),before);
});

test('a successful first recording makes no correction calls and never speeds up speech',async()=>{
  const takes=await recordTimedNarration(content,renderedNarrationManifest(manifest,result,15),{
    record:async section=>({path:`${section.id}.wav`,duration:section.duration-.05}),
    rewrite:async()=>assert.fail('No rewrite is required'),
  });
  assert.equal(takes.length,2);
  assert.ok(takes.every(take=>take.duration<take.endTime-take.startTime));
});

test('the production complete-recap path watches a video and muxes the existing pictures rather than re-editing',async()=>{
  const source=await readFile(new URL('../local-processor/server.mjs',import.meta.url),'utf8');
  assert.ok(source.indexOf('completedVisual = await prepareCompletedVisualNarration')<source.indexOf('const lockedEvidenceDuration = availableVerifiedEvidenceDuration(lockedNarrationCandidates)'));
  assert.match(source,/completedVisual\?\.videoPart \|\| null/);
  assert.match(source,/if \(completedVisual\) \{[\s\S]*?makeCompletedTimelineSpeech/);
  const finish=source.slice(source.indexOf('async function finishCompletedVisualNarration'),source.indexOf('async function writeAnalysisContentWithGemini'));
  assert.doesNotMatch(finish,/atempo|setpts|crop=|renderVideoV2/);
  assert.match(finish,/completed\.path/);
  assert.equal(workflowPhase({stage:'editing',narrationProductionVersion:1,narrationRecorded:false}),'effects');
  assert.equal(workflowPhase({stage:'editing',narrationProductionVersion:1,narrationRecorded:true}),'render');
});
