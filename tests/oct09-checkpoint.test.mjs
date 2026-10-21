import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {MINIMUM_SOURCE_SECONDS,sourceDurationProblem} from '../local-processor/source-duration-policy.mjs';
import {WORKFLOW_STEPS,buildWorkflowProgress} from '../local-processor/workflow-progress.mjs';
import {fixedSceneQueue,assertFixedSceneQueue} from '../local-processor/fixed-scene-queue.mjs';

const root=new URL('../',import.meta.url);
const checkpoint=JSON.parse(await readFile(new URL('docs/checkpoints/2026-10-09-source.json',root),'utf8'));

test('application source matches both successful October 9 build archives',async()=>{
  for(const item of checkpoint.files){
    if(item.path==='package.json')continue;
    const bytes=await readFile(new URL(item.path,root));
    const sha=value=>createHash('sha256').update(value).digest('hex');
    // Git may convert text line endings on a Windows checkout. Permit only
    // that transport normalization; all other source content must be exact.
    const variants=[sha(bytes)];
    if(!bytes.includes(0)){
      const lf=bytes.toString('utf8').replace(/\r\n/g,'\n');
      variants.push(sha(lf),sha(lf.replace(/\n/g,'\r\n')));
    }
    assert.ok(variants.includes(item.sha256),item.path);
  }
  // The sole package change adds a local verification command, not a dependency
  // or runtime/script change from another application version.
  const pkg=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
  delete pkg.scripts['test:restore'];
  assert.deepEqual(pkg,checkpoint.originalPackage);
});

test('all restored processor and deployment JavaScript passes Node syntax checks',async()=>{
  for(const directory of ['local-processor/','deploy/cloud-run/']){
    for(const name of await readdir(new URL(directory,root))){
      if(!name.endsWith('.mjs'))continue;
      const result=spawnSync(process.execPath,['--check',fileURLToPath(new URL(directory+name,root))],{encoding:'utf8',timeout:15000});
      assert.equal(result.status,0,directory+name+' '+result.stderr);
    }
  }
});

test('historical source eligibility is three minutes, not the newer zero minimum',()=>{
  assert.equal(MINIMUM_SOURCE_SECONDS,180);
  assert.match(sourceDurationProblem(179),/at least 3 minutes/);
  assert.equal(sourceDurationProblem(180),null);
});

test('scene-by-scene workflow retains split, tracking, effects, script and voice order',()=>{
  assert.deepEqual(WORKFLOW_STEPS.map(step=>step.id),['split','tracking','effects','script','voice','render','review']);
  const scenes=[{id:'a',selectionLocked:true,startTime:0,endTime:6,sourceSceneAsset:{path:'a.mp4'},trackingPassed:true},
    {id:'b',selectionLocked:true,startTime:20,endTime:26,sourceSceneAsset:{path:'b.mp4'},trackingPassed:false}];
  const queue=fixedSceneQueue(scenes);
  assert.equal(queue.trackingOrder,'one_scene_at_a_time');
  assert.deepEqual(assertFixedSceneQueue(queue,scenes).pending,['b']);
  assert.throws(()=>assertFixedSceneQueue(queue,[scenes[0]]),/changed the split scene list/);
  const progress=buildWorkflowProgress({stage:'tracking',moments:scenes});
  assert.equal(progress.scenes.length,2);
  assert.equal(progress.scenes[0].status,'verified');
  assert.equal(progress.scenes[1].status,'pending');
});
