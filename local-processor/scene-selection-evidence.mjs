// Source-draft confidence is provisional. A later independent source review
// can approve that action without fabricating a new numeric confidence.
// Selection and locking must use the same evidence predicate.
export function hasInitialSceneEvidence(moment, {requireSemanticVerification=false, minimumSeconds=.5}={}) {
  const duration=Number(moment.endTime)-Number(moment.startTime);
  if(moment.keepDecision==='reject' || moment.semanticVerified===false || moment.actionComplete===false
    || moment.sourceAngleDeferred || moment.sourceSupportDeferred
    || !Number.isFinite(duration) || duration<minimumSeconds) return false;
  if(requireSemanticVerification) return moment.semanticVerified===true;
  return moment.semanticVerified===true || Number(moment.confidence||0)>=.4;
}
