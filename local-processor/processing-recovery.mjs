import {geminiServiceFailure} from './gemini-request-scheduler.mjs';

export function interruptionKind(error) {
  const message=String(error?.message||error),code=String(error?.code||'');
  if(code==='INITIAL_FRAMING_PLAN') return 'initial_plan';
  if(code==='SOURCE_SELECTION_CONFLICT') return 'source_selection';
  if(code==='FIXED_SCENE_FRAMING_PENDING') return 'unchanged_framing';
  if(code==='SOURCE_VALIDATION'||/No video stream|Could not read the video duration|uploaded video was empty|saved source video is missing/i.test(message)) return 'source';
  if(/TTS_CONFIGURATION|TTS_AUTHENTICATION|TTS_PERMISSION/.test(code)
    ||/permission.?denied|unauthenticated|invalid api key|default credentials|not configured|(?:API key|credentials) (?:is|are) required|must be google_cloud|spawn .+ ENOENT|Unrecognized option|Unknown (?:filter|encoder)/i.test(message)) return 'configuration';
  if(geminiServiceFailure(error)||['TTS_TRANSIENT','PROCESSOR_RESTART'].includes(code)||/ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(code)
    ||/429|RESOURCE_EXHAUSTED|504|503|502|ETIMEDOUT|ECONNRESET|fetch failed|temporarily unavailable|(?:Gemini|Google|TTS|request).*(?:timed out|timeout|deadline exceeded)/i.test(message)) return 'service';
  if(/framing|tracking|keyframe|verified|coverage|scene|semantic|narration|script|JSON|duration|alignment|synchronization|loudness/i.test(message)) return 'repair';
  return 'technical';
}

function progressSignature(job) {
  return JSON.stringify({phase:job.workflowPhase,flags:[job.sceneSelectionComplete,job.visualEditLocked,job.narrationScriptApproved,job.narrationRecorded,job.renderCompleted],
    evidence:(job.moments||[]).filter(scene=>scene.semanticVerified||scene.trackingPassed)
      .map(scene=>[scene.id,scene.startTime,scene.endTime,scene.semanticVerified,scene.trackingPassed]).sort()});
}

export function processingInterruption(job,error,now=Date.now()) {
  const kind=interruptionKind(error),message=String(error?.message||error);
  if(kind==='source') return {stage:'failed',error:{code:'SOURCE_VALIDATION',message,retryable:false}};
  const previous=job.processingRecovery||{},signature=progressSignature(job);
  const repeated=previous.kind===kind&&previous.progressSignature===signature?Number(previous.repeated||0)+1:1;
  const attempt=Number(previous.attempt||0)+1;
  // Never spin forever on a deterministic contradiction. Keep all work and
  // report the precise intervention needed, without falsely completing it.
  const attention=kind==='configuration'||kind==='initial_plan'||kind==='source_selection'||kind==='unchanged_framing'||(kind!=='service'&&repeated>=3);
  // Loading new worker code is not a Google outage. Resume saved checkpoints
  // promptly; model-specific provider cooldowns are restored independently.
  const delayMs=error?.code==='PROCESSOR_RESTART'?5000:Math.min(180000,5000*2**Math.min(5,attempt-1));
  const phase=job.workflowPhase||'split';
  const recovery={version:1,status:attention?'attention':'waiting',kind,attempt,repeated,progressSignature:signature,
    resumePhase:phase,action:phase==='render'||phase==='review'?'render':'analysis',lastError:message,
    retryAt:attention?null:new Date(now+delayMs).toISOString()};
  return {stage:attention?'attention_required':'waiting_retry',workflowPhase:phase,error:undefined,
    processingRecovery:recovery,progressDetail:attention
      ? `${kind==='configuration'?'Configuration needs attention':kind==='initial_plan'?'Initial framing plan needs attention; automatic repair is disabled':kind==='source_selection'?'Source outcome evidence needs attention; identical saved observations will not be repeated':kind==='unchanged_framing'?'Framing needs a changed camera plan; identical attempts will not be repeated':'Automatic repair has not made measurable progress'}. Saved scenes and completed work are preserved. ${message}`
      : `Saved ${phase} work. Automatically retrying the interrupted step in ${Math.ceil(delayMs/1000)} seconds (attempt ${attempt}). ${message}`};
}

// Queue retries after the current execution releases its reservation. Other
// jobs are free to run during a provider wait; only one timer owns this job.
export function createRecoveryScheduler({readJob,isQueued,retry,onError=console.error,
  setTimer=setTimeout,clearTimer=clearTimeout,now=Date.now}) {
  const timers=new Map();
  const cancel=id=>{if(timers.has(id))clearTimer(timers.get(id));timers.delete(id);};
  const schedule=(id,at)=>{
    cancel(id);
    const timer=setTimer(async()=>{
      timers.delete(id);
      try {
        const job=await readJob(id);
        if(job.stage!=='waiting_retry'||job.processingRecovery?.status!=='waiting')return;
        if(isQueued(id)) {schedule(id,now()+1000);return;}
        await retry(job);
      } catch(error) {try{await onError(error,id);}catch(reportError){console.error('Could not save automatic recovery error',id,reportError);}}
    },Math.max(0,Number(at)-now()));
    timer?.unref?.();timers.set(id,timer);
  };
  return {schedule,cancel,size:()=>timers.size};
}
