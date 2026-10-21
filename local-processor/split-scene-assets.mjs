import {mkdir,readFile,writeFile,stat,rename} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {trackedPositionExpression} from './tracked-position.mjs';

export const SPLIT_SCENE_ASSET_VERSION=1;

export function splitSceneKey(scene,fingerprint) {
  if(!scene?.selectionLocked || !Number.isFinite(scene.startTime) || !Number.isFinite(scene.endTime)
    || scene.endTime<=scene.startTime || !fingerprint) throw new Error('Split clips require a locked source interval.');
  return createHash('sha256').update(JSON.stringify([SPLIT_SCENE_ASSET_VERSION,fingerprint,
    String(scene.id),scene.startTime,scene.endTime])).digest('hex');
}

export function splitSceneInput(scene,directory) {
  const asset=scene?.sourceSceneAsset;
  if(!asset) return null;
  if(asset.version!==SPLIT_SCENE_ASSET_VERSION || !/^[a-f0-9]{64}\.mp4$/.test(asset.fileName)
    || asset.fileName!==basename(asset.fileName)
    || asset.sourceStartTime!==scene.startTime || asset.sourceEndTime!==scene.endTime)
    throw new Error(`Split clip for ${scene.id} does not match its locked interval.`);
  return {path:join(directory,asset.fileName),startTime:0,duration:scene.endTime-scene.startTime};
}

export function sceneWithLocalClock(scene) {
  const offset=scene.startTime;
  const shift=value=>Number.isFinite(value)?value-offset:value;
  const brief={...(scene.trackingBrief||{})};
  for(const key of ['originTime','contactTime','flightStartTime','handoffTime','payoffStartTime',
    'payoffEndTime','annotationStartTime','annotationEndTime']) if(key in brief) brief[key]=shift(brief[key]);
  if(brief.payoffEvidence) brief.payoffEvidence={...brief.payoffEvidence,
    startTime:shift(brief.payoffEvidence.startTime),endTime:shift(brief.payoffEvidence.endTime)};
  return {...scene,startTime:0,endTime:scene.endTime-offset,trackingBrief:brief};
}

export async function prepareSplitSceneAssets({sourcePath,fingerprint,candidates,media,directory,ffmpeg,run,probe,report=async()=>{},onScenePrepared=async()=>{}}) {
  await mkdir(directory,{recursive:true});
  const result=[];
  const slots=candidates.filter(scene=>scene.selectionLocked).sort((a,b)=>a.startTime-b.startTime);
  for(const [index,scene] of slots.entries()) {
    const key=splitSceneKey(scene,fingerprint),fileName=`${key}.mp4`,path=join(directory,fileName);
    const manifestPath=join(directory,`${key}.json`);
    let saved;
    try {saved=JSON.parse(await readFile(manifestPath,'utf8'));
      if(saved.key!==key || (await stat(path)).size<1024) saved=null;
    } catch {saved=null;}
    await report(`Preparing separate source scene ${index+1}/${slots.length}; original frame, normal speed, no combining.`);
    if(!saved) {
      const pending=join(directory,`${key}.pending.mp4`);
      await run(ffmpeg,['-hide_banner','-loglevel','error','-y','-ss',String(scene.startTime),'-i',sourcePath,
        '-t',String(scene.endTime-scene.startTime),'-map','0:v:0','-an',
        '-vf','setpts=PTS-STARTPTS','-c:v','libx264','-preset','veryfast','-crf','16',
        '-pix_fmt','yuv420p','-movflags','+faststart',pending]);
      const actual=await probe(pending);
      if(actual.width!==media.width || actual.height!==media.height
        || Math.abs(actual.duration-(scene.endTime-scene.startTime))>.12)
        throw new Error(`Separate source clip ${scene.id} changed dimensions or action duration.`);
      await rename(pending,path);
      saved={key,version:SPLIT_SCENE_ASSET_VERSION,fileName,sourceStartTime:scene.startTime,
        sourceEndTime:scene.endTime,width:actual.width,height:actual.height,duration:actual.duration,normalSpeed:true,muted:true};
      await writeFile(manifestPath,JSON.stringify(saved));
    }
    result.push({...scene,sourceSceneAsset:saved});
    await onScenePrepared(result.at(-1),index+1,slots.length);
  }
  const byId=new Map(result.map(scene=>[scene.id,scene]));
  await writeFile(join(directory,'manifest.json'),JSON.stringify({version:SPLIT_SCENE_ASSET_VERSION,
    sourceFingerprint:fingerprint,combined:false,stage:'source_split',
    combinePolicy:'after_tracking_effects_transitions_captions_narration',
    scenes:result.map(scene=>({id:scene.id,...scene.sourceSceneAsset}))},null,2));
  return candidates.map(scene=>byId.get(scene.id)||scene);
}

export async function savePortraitSceneAsset({scene,sourceDirectory,directory,evidence,dimensions,ffmpeg,run,probe}) {
  const source=splitSceneInput(scene,sourceDirectory);
  if(!source || evidence.finalCropVerified!==true || evidence.geometryVerified!==true)
    throw new Error('A portrait scene asset requires its own verified camera path.');
  await mkdir(directory,{recursive:true});
  const key=createHash('sha256').update(JSON.stringify([1,scene.sourceSceneAsset.key,evidence.keyframes,
    evidence.geminiFramingVersion,evidence.outcomeConsistencyVersion,dimensions])).digest('hex');
  const fileName=`${key}.mp4`,path=join(directory,fileName),manifestPath=join(directory,`${key}.json`);
  let saved;
  try {saved=JSON.parse(await readFile(manifestPath,'utf8'));if(saved.key!==key||(await stat(path)).size<1024)saved=null;} catch {saved=null;}
  if(!saved) {
    const ratio=dimensions.width/dimensions.height;
    const x=trackedPositionExpression(evidence.keyframes,'cameraX',.5);
    const y=trackedPositionExpression(evidence.keyframes,'cameraY',.5);
    const sourceRatio=scene.sourceSceneAsset.width/scene.sourceSceneAsset.height;
    const crop=sourceRatio>=ratio?`crop=ih*${ratio}:ih:x='max(0,min(iw-ow,iw*(${x})-ow/2))':y=0`
      :`crop=iw:iw/${ratio}:x=0:y='max(0,min(ih-oh,ih*(${y})-oh/2))'`;
    const pending=join(directory,`${key}.pending.mp4`);
    await run(ffmpeg,['-hide_banner','-loglevel','error','-y','-i',source.path,'-t',String(source.duration),
      '-an','-vf',`setpts=PTS-STARTPTS,${crop},scale=${dimensions.width}:${dimensions.height}:flags=lanczos,setsar=1`,
      '-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',pending]);
    const actual=await probe(pending);
    if(actual.width!==dimensions.width||actual.height!==dimensions.height||Math.abs(actual.duration-source.duration)>.12)
      throw new Error(`Portrait asset for ${scene.id} changed the selected action duration.`);
    await rename(pending,path);
    saved={version:1,key,fileName,sceneId:scene.id,width:actual.width,height:actual.height,duration:actual.duration,
      sourceStartTime:scene.startTime,sourceEndTime:scene.endTime,verifiedCamera:true,normalSpeed:true,combined:false};
    await writeFile(manifestPath,JSON.stringify(saved));
  }
  return saved;
}

export async function repairSplitScene({attempt,onRepair=async()=>{},isRepairError,maximumRounds=3}) {
  let lastError;
  for(let round=0;round<maximumRounds;round++) {
    try {return await attempt(round);} catch(error) {
      if(!isRepairError(error)) throw error;
      lastError=error;
      await onRepair(error,round+1,round+1<maximumRounds);
    }
  }
  throw lastError;
}
