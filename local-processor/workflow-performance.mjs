// Diagnostic timing only. Never changes scheduling, evidence or retry policy.
export function performanceWorkload(label='') {
  if (/hybrid crop outcome/i.test(label)) return 'crop_finish';
  if (/hybrid rendered crop|visual keyframes|video keyframes/i.test(label)) return 'crop_review';
  if (/Semantic ball route/i.test(label)) return 'source_action_guide';
  if (/narration|recap.*script|content draft/i.test(label)) return 'script';
  if (/research|fixture|match context/i.test(label)) return 'research';
  if (/initial|section|inventory|discovery/i.test(label)) return 'source_discovery';
  return 'other';
}

export function createWorkflowPerformance({now=Date.now}={}) {
  const jobs=new Map();
  const ensure=(id,saved)=>{
    if(!jobs.has(id)) jobs.set(id,{data:saved?.version===1?structuredClone(saved):{
      version:1,startedAt:new Date(now()).toISOString(),phaseMs:{},gemini:{}},cursor:null});
    return jobs.get(id);
  };
  return {
    observe(job,saved=job.performance) {
      const state=ensure(job.id,saved),time=now();
      if(state.cursor) {
        const elapsed=Math.max(0,time-state.cursor.at);
        const key=state.cursor.phase;
        state.data.phaseMs[key]=(state.data.phaseMs[key]||0)+elapsed;
      }
      // Restarts do not count offline time as CPU/provider processing.
      state.cursor=job.stage==='completed'?null:{at:time,phase:job.workflowPhase||job.stage};
      state.data.updatedAt=new Date(time).toISOString();
      state.data.completed=job.stage==='completed';
      state.data.observedWallMs=Object.values(state.data.phaseMs).reduce((a,b)=>a+b,0);
      return structuredClone(state.data);
    },
    request(id,{label,model,status,gateWaitMs,providerMs,usage={},providerStartedAt,limitEvidence},saved) {
      if(!id) return;
      const state=ensure(id,saved),key=performanceWorkload(label);
      const stats=state.data.gemini[key]||={attempts:0,succeeded:0,capacityErrors:0,
        timeoutErrors:0,otherErrors:0,gateWaitMs:0,providerMs:0,promptTokens:0,outputTokens:0,thinkingTokens:0,models:[]};
      stats.attempts++;
      stats[status==='success'?'succeeded':status==='capacity'?'capacityErrors':status==='timeout'?'timeoutErrors':'otherErrors']++;
      stats.gateWaitMs+=Math.max(0,Number(gateWaitMs)||0);
      stats.providerMs+=Math.max(0,Number(providerMs)||0);
      for(const [field,usageField] of [['promptTokens','promptTokenCount'],['outputTokens','candidatesTokenCount'],['thinkingTokens','thoughtsTokenCount'],['cachedTokens','cachedContentTokenCount']])
        stats[field]=(stats[field]||0)+Math.max(0,Number(usage[usageField])||0);
      // Cached input is a subset of promptTokens, never additional input.
      // A failed request without usage is not treated as billed prompt usage.
      if(typeof model==='string'&&!stats.models.includes(model))stats.models.push(model);
      // Aggregate by the actual model as well as workload. Completion time is
      // not request admission time; use the real provider start for RPM buckets.
      if(typeof model==='string') {
        const models=state.data.modelRequests||={};
        const row=models[model]||={attempts:0,succeeded:0,resourceExhausted:0,
          explicitQuotaErrors:0,explicitCapacityErrors:0,unspecified429:0,
          promptTokens:0,outputTokens:0,thinkingTokens:0,cachedTokens:0,minutes:{}};
        row.attempts++;if(status==='success')row.succeeded++;
        if(status==='capacity') {
          row.resourceExhausted++;
          row[limitEvidence?.kind==='quota'?'explicitQuotaErrors':limitEvidence?.kind==='capacity'?'explicitCapacityErrors':'unspecified429']++;
        }
        for(const [field,usageField] of [['promptTokens','promptTokenCount'],['outputTokens','candidatesTokenCount'],['thinkingTokens','thoughtsTokenCount'],['cachedTokens','cachedContentTokenCount']])
          row[field]+=Math.max(0,Number(usage[usageField])||0);
        const at=Number.isFinite(providerStartedAt)?providerStartedAt:now();
        const minute=String(Math.floor(at/60000)*60000);
        const bucket=row.minutes[minute]||={requests:0,promptTokens:0,outputTokens:0,thinkingTokens:0,resourceExhausted:0};
        bucket.requests++;if(status==='capacity')bucket.resourceExhausted++;
        for(const [field,usageField] of [['promptTokens','promptTokenCount'],['outputTokens','candidatesTokenCount'],['thinkingTokens','thoughtsTokenCount']])
          bucket[field]+=Math.max(0,Number(usage[usageField])||0);
        for(const old of Object.keys(row.minutes).sort((a,b)=>Number(b)-Number(a)).slice(60))delete row.minutes[old];
      }
      // Parallel request totals are resource time, not additive wall time.
    },
  };
}
