// Processor snapshots may omit a cleared error/detail. A plain spread retains
// the previous cloud failure forever, even when recovery is making progress.
export function mergeCloudJobStatus(previous, incoming, context = {}, updatedAt = new Date().toISOString()) {
  const clean = {...previous, ...context, ...incoming, updatedAt};
  if (incoming.stage && incoming.stage !== 'failed' && !incoming.error) delete clean.error;
  if (incoming.stage && incoming.stage !== previous.stage
    && !Object.hasOwn(incoming, 'progressDetail')) delete clean.progressDetail;
  delete clean.sourceKey;
  delete clean.outputKey;
  return JSON.parse(JSON.stringify(clean));
}
