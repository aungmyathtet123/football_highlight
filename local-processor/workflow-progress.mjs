// Shared by the processor, cloud gateway and UI. No simulated progress timers.
export const WORKFLOW_STEPS=[
  {id:'split',title:'Choose & save separate source scenes',detail:'Observe each source section once, choose complete actions locally, and save separate original-ratio clips. Do not combine scenes.'},
  {id:'tracking',title:'Track each 9:16 scene',detail:'Follow the ball and involved player using a separate camera path.'},
  {id:'effects',title:'Finish the visual edit',detail:'Apply effects and transitions, then render the complete muted edit with its exact scene clock.'},
  {id:'script',title:'Watch the edit & write the recap',detail:'Review the whole completed video once; write engaging basic English for its exact scene windows.'},
  {id:'voice',title:'Record timed narration',detail:'Record normal-speed voice for each window. Only an overlong section needs shorter wording; pictures stay unchanged.'},
  {id:'render',title:'Add narration & export',detail:'Add timed voice and subtitles to the completed visual edit, without changing its scenes or playback speed.'},
  {id:'review',title:'Check the final video',detail:'Verify the output, captions, sound and complete actions.'},
];

export function workflowPhase(job={}) {
  const stage=job.stage;
  if(['failed','waiting_retry','attention_required','queued','restoring','downloading'].includes(stage)) return job.workflowPhase||'split';
  if(stage==='completed'||stage==='validating') return 'review';
  if(stage==='editing' && job.narrationProductionVersion===1 && job.narrationRecorded===false) return 'effects';
  if(stage==='rendering'||stage==='editing') return 'render';
  if(stage==='generating_commentary') return 'voice';
  if(stage==='writing_content') return 'script';
  if(stage==='aligning_content'||stage==='ranking') return 'effects';
  const locked=(job.moments||[]).filter(scene=>scene.selectionLocked===true);
  if(stage==='tracking' && locked.length && locked.every(scene=>scene.sourceSceneAsset)) return 'tracking';
  return 'split';
}

export function buildWorkflowProgress(job={}) {
  const locked=(job.moments||[]).filter(scene=>scene.selectionLocked===true)
    .sort((a,b)=>a.startTime-b.startTime);
  const states=job.sceneTrackingStates||{};
  const active=job.activeTrackingScene;
  const scenes=locked.map((scene,index)=>{
    const saved=states[scene.id];
    const verified=scene.trackingPassed===true||saved?.status==='verified';
    const current=active?.id===scene.id && !verified;
    const status=verified?'verified':current&&job.stage==='failed'?'needs_repair':current&&active.status==='repairing'?'repairing'
      :current&&active.status==='tracking'?'tracking':saved?.status==='needs_repair'?'needs_repair':'pending';
    return {id:scene.id,index:index+1,startTime:scene.startTime,endTime:scene.endTime,
      duration:Math.max(0,scene.endTime-scene.startTime),eventType:scene.eventType,
      description:scene.description||'',sourcePrepared:Boolean(scene.sourceSceneAsset),status,
      round:current?Number(active.round||active.attempt||1):Number(saved?.round||0),
      detail:current?job.progressDetail||'':saved?.detail||scene.trackingRepairError||''};
  });
  const sourcePrepared=scenes.filter(scene=>scene.sourcePrepared).length;
  const verified=scenes.filter(scene=>scene.status==='verified').length;
  const phase=workflowPhase(job),phaseIndex=WORKFLOW_STEPS.findIndex(step=>step.id===phase);
  const complete=job.stage==='completed';
  const trackingDone=scenes.length>0&&verified===scenes.length;
  const sourceVerified=(job.moments||[]).filter(scene=>scene.semanticVerified===true
    && scene.actionComplete===true && scene.keepDecision!=='reject'
    && !scene.sourceAngleDeferred && !scene.sourceSupportDeferred);
  // Saved section summaries may be from an earlier retry's provisional pool.
  // Once locked, derive them from the same scene list as the headline metrics.
  const sections=(job.sourceSections||[]).map(section=>{
    if(!locked.length&&!sourceVerified.length)return section;
    const local=(locked.length?scenes:sourceVerified).filter(scene=>{
      const midpoint=(scene.startTime+scene.endTime)/2;
      return midpoint>=section.startTime&&midpoint<section.endTime;
    });
    return {...section,sceneCount:local.length,selectedSeconds:local.reduce((sum,scene)=>sum+scene.endTime-scene.startTime,0)};
  });
  const wait=job.aiCapacityWait?.active?job.aiCapacityWait
    :job.stage==='waiting_retry'?job.processingRecovery:null;
  const hasVoice=job.settings?.commentary!==false;
  const steps=WORKFLOW_STEPS.map((step,index)=>{
    // Source/camera completion comes from evidence, not a percentage or stage order.
    const done=complete||step.id==='split'&&scenes.length>0&&sourcePrepared===scenes.length
      ||step.id==='tracking'&&trackingDone
      ||step.id==='effects'&&(job.narrationProductionVersion===1?job.completedVisualReady===true:job.visualEditLocked===true)
      ||step.id==='script'&&job.narrationScriptApproved===true
      ||step.id==='voice'&&job.narrationRecorded===true
      ||step.id==='render'&&job.renderCompleted===true;
    const skipped=step.id==='voice'&&!hasVoice;
    return {...step,number:index+1,status:skipped?'skipped':done?'complete'
      :index===phaseIndex?(['failed','attention_required'].includes(job.stage)?'paused':job.stage==='waiting_retry'||job.aiCapacityWait?.active?'waiting':'active'):'pending'};
  });
  return {version:1,phase,steps,scenes,sections,selectedCount:scenes.length,sourcePrepared,verified,
    sourceVerifiedCount:sourceVerified.length,
    sourceVerifiedDuration:sourceVerified.reduce((sum,scene)=>sum+Math.max(0,scene.endTime-scene.startTime),0),
    selectedDuration:scenes.reduce((sum,scene)=>sum+scene.duration,0),
    sourceDuration:Number(job.media?.duration||job.sourceDuration||0),
    waiting:job.stage==='waiting_retry'||job.aiCapacityWait?.active===true,retryAt:wait?.retryAt||null,
    waitingReason:wait?.lastError||wait?.reason||null};
}
