// Explicit workload defaults. Transport-only failover records requested and
// actual model provenance; it never overrides a semantic or visual verdict.
export function geminiWorkloadModel(role,env=process.env) {
  if(role==='research') return String(env.GEMINI_RESEARCH_MODEL||'').trim()
    ||String(env.GEMINI_DISCOVERY_MODEL||'').trim()||env.GEMINI_MODEL;
  const key={discovery:'GEMINI_DISCOVERY_MODEL',script:'GEMINI_SCRIPT_MODEL',framing:'GEMINI_KEYFRAME_MODEL'}[role];
  return (key&&String(env[key]||'').trim())||env.GEMINI_MODEL;
}

// Only initial source discovery is sampled more economically. Precise scene
// framing owns its independent video profile and is deliberately unchanged.
export function initialDiscoveryFps(env=process.env) {
  const value=Number(env.GEMINI_DISCOVERY_FPS||2);
  return Number.isFinite(value)?Math.max(1,Math.min(3,value)):2;
}

// A model/profile update is not a reason to repeat an already paid source
// observation. Authenticate its old identity against the SAME source/contract/
// section/shots; retain the actual workload rather than relabeling the evidence.
export function restoreInitialSectionResponse(saved,{version,inputKey,keyForWorkload,currentWorkload,legacyModels=[]}) {
  if(saved?.version!==version||saved.rawDraft===undefined) return undefined;
  const valid=profile=>typeof profile?.model==='string'&&profile.model.trim()
    &&Number.isFinite(profile.fps)&&profile.fps>=1&&profile.fps<=3
    &&Number.isFinite(profile.height)&&profile.height>0;
  if(saved.inputKey!==undefined) {
    if(saved.inputKey!==inputKey||!valid(saved.workload)||saved.key!==keyForWorkload(saved.workload)) return undefined;
    return {rawDraft:saved.rawDraft,workload:saved.workload};
  }
  const profiles=[currentWorkload,...legacyModels.flatMap(model=>[1,2,3].map(fps=>({model,fps,height:currentWorkload.height})))];
  const workload=profiles.find(profile=>valid(profile)&&saved.key===keyForWorkload(profile));
  return workload?{rawDraft:saved.rawDraft,workload}:undefined;
}

export const UNIFIED_DISCOVERY_VERSION=1;
export function needsBroadExtraDiscovery(candidates,summary) {
  return summary?.unifiedDiscoveryVersion!==UNIFIED_DISCOVERY_VERSION
    && !(candidates||[]).some(scene=>scene.sourceDiscoveryPassVersion===UNIFIED_DISCOVERY_VERSION);
}

export function unifiedDiscoverySummary(summary={}) {
  return {...summary,unifiedDiscoveryVersion:UNIFIED_DISCOVERY_VERSION};
}
