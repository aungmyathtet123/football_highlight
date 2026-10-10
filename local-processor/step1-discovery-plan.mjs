import {analysisProxyWindows} from './passage-inventory.mjs';

// Quotas guide observation, not selection. Empty sections donate their budget;
// only independently verified, distinct source actions count toward the lock.
export function step1DiscoveryPlan(duration,minimumSeconds=60,sectionSeconds=180,overlapSeconds=6) {
  const source=Number(duration);
  if(!Number.isFinite(source)||source<=0) return {minimumSeconds,plannedSeconds:0,sections:[]};
  const minimum=Math.max(0,Number(minimumSeconds)||0);
  const planned=Math.min(source,minimum+Math.max(20,minimum*.5));
  const windows=analysisProxyWindows(source,sectionSeconds,overlapSeconds);
  const sections=windows.map((window,index)=>{
    const coreEnd=index+1<windows.length?windows[index+1].startTime:source;
    return {...window,index:index+1,coreEnd,
      requestedSeconds:Number((planned*(coreEnd-window.startTime)/source).toFixed(3))};
  });
  return {version:1,minimumSeconds:minimum,plannedSeconds:planned,sections};
}

function belongsToSection(scene,section) {
  const time=(Number(scene.startTime)+Number(scene.endTime))/2;
  return time>=section.startTime&&time<section.coreEnd;
}

// Input must already be deduplicated and source-verified. Keep mandatory goals,
// then meet each section's soft budget before filling the global remainder.
export function selectSectionSceneIds(ranked,mandatoryIds,plan,capacity) {
  const selected=new Set(mandatoryIds);
  for(const section of plan.sections) {
    const local=ranked.filter(scene=>belongsToSection(scene,section));
    let seconds=local.filter(scene=>selected.has(scene.id)).reduce((sum,scene)=>sum+capacity(scene),0);
    for(const scene of local) {
      if(seconds>=section.requestedSeconds) break;
      if(selected.has(scene.id)) continue;
      selected.add(scene.id);seconds+=capacity(scene);
    }
  }
  return selected;
}

export function sectionSelectionSummary(scenes,plan) {
  return plan.sections.map(section=>{
    const local=scenes.filter(scene=>belongsToSection(scene,section));
    return {index:section.index,startTime:section.startTime,endTime:section.coreEnd,
      targetSeconds:section.requestedSeconds,sceneCount:local.length,
      selectedSeconds:Number(local.reduce((sum,scene)=>sum+scene.endTime-scene.startTime,0).toFixed(3))};
  });
}

// A broad negative excerpt is not an exhaustive observation of each camera
// shot. Revisit whole shots once at dense FPS before declaring source exhausted.
export function unobservedSourceShotWindows(candidates,shots,duration,searched=[],limit=4) {
  const covered=(candidates||[]).filter(scene=>scene.semanticVerified===true&&scene.actionComplete===true
    &&scene.keepDecision!=='reject'&&!scene.sourceAngleDeferred&&!scene.sourceSupportDeferred);
  const overlap=(a,b)=>Math.max(0,Math.min(a.endTime,b.endTime)-Math.max(a.startTime,b.startTime));
  const observed=shot=>{
    let cursor=shot.startTime,total=0;
    for(const prior of [...searched].sort((a,b)=>a.startTime-b.startTime)) {
      const start=Math.max(cursor,prior.startTime),end=Math.min(shot.endTime,prior.endTime);
      if(end>start) {total+=end-start;cursor=end;}
    }
    return total>=shot.endTime-shot.startTime-.1;
  };
  return (shots||[]).map(shot=>({startTime:Math.max(0,Number(shot.startTime)),
    endTime:Math.min(Number(duration),Number(shot.endTime))}))
    .filter(shot=>Number.isFinite(shot.startTime)&&Number.isFinite(shot.endTime)&&shot.endTime-shot.startTime>=2)
    .filter(shot=>!observed(shot))
    // Keep partly covered shots: their earlier initiating pass may be missing.
    .filter(shot=>!covered.some(scene=>overlap(shot,scene)>=(shot.endTime-shot.startTime)*.95))
    .sort((a,b)=>(b.endTime-b.startTime)-(a.endTime-a.startTime)||a.startTime-b.startTime)
    .slice(0,limit).sort((a,b)=>a.startTime-b.startTime);
}
