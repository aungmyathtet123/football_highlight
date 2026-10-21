import {createGeminiRequestGate} from './gemini-request-scheduler.mjs';

// A busy model must not consume a healthy model's admission slots while it
// sleeps. All actual network work still shares the SAME global concurrency cap.
export function createGeminiModelGate(options={}) {
  const now=options.now||Date.now;
  const shared=createGeminiRequestGate({...options,adaptive:false});
  const models=new Map();
  const lane=model=>{
    const key=String(model||'default');
    if(!models.has(key)) models.set(key,createGeminiRequestGate(options));
    return models.get(key);
  };
  return {
    schedule:(task,model)=>lane(model).schedule(()=>shared.schedule(task)),
    scheduleAvailable:(task,model)=>lane(model).schedule(()=>shared.schedule(()=>{
      // A different scene may reject this endpoint while we queue behind the
      // shared network cap. Reroute without sending another known-busy request.
      if(lane(model).status().nextRequestAt>now())throw Object.assign(
        new Error('Model entered cooldown before network admission'),{code:'GEMINI_MODEL_COOLDOWN'});
      return task();
    }),{rejectOnCooldown:true}),
    defer:(milliseconds,model)=>lane(model).defer(milliseconds),
    status:model=>{
      if(model!==undefined) return lane(model).status();
      const global=shared.status();
      const states=Object.fromEntries([...models].map(([name,gate])=>[name,gate.status()]));
      const all=Object.values(states);
      return {...global,queued:all.reduce((n,state)=>n+state.queued,0),
        // Current concurrency is per-model; model-specific states are the
        // authoritative cooldowns, not a fictitious shared retry deadline.
        currentConcurrency:all.length===1?all[0].currentConcurrency:global.currentConcurrency,
        overloads:all.reduce((n,state)=>n+state.overloads,0),
        serviceFailures:all.reduce((n,state)=>n+state.serviceFailures,0),
        nextRequestAt:all.length===1?all[0].nextRequestAt:0,models:states};
    },
  };
}
