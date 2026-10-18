import {createHash} from 'node:crypto';

export const FOOTBALL_EVALUATION_VERSION=1;
const idFor=value=>createHash('sha256').update(value).digest('hex').slice(0,24);

// Pipeline verdicts are observations to audit, not training ground truth.
export function buildFootballEvaluationReport(job,tracking,assess,{now=new Date().toISOString(),sourceFingerprint}={}) {
  const scenes=(job.moments||[]).filter(scene=>scene.selectionLocked===true);
  const fingerprint=sourceFingerprint||scenes.find(scene=>scene.sourceSelectionEvidence?.sourceFingerprint?.sha256)
    ?.sourceSelectionEvidence.sourceFingerprint.sha256;
  const sourceId=fingerprint||`job:${job.id}`;
  const cases=scenes.map(scene=>{
    const evidence=tracking?.moments?.[scene.id]||{},assessment=assess(scene,evidence);
    const records=evidence.sourceRecords||[],review=evidence.renderReview||{};
    return {caseId:idFor(`${sourceId}:${scene.startTime}:${scene.endTime}`),sceneId:scene.id,
      sourceId,aspectRatio:job.settings?.aspectRatio||null,startTime:scene.startTime,endTime:scene.endTime,
      sourceEventClaim:scene.sourceEventTypeBeforeCropReview||scene.eventType,
      currentEventClaim:scene.eventType,observedOutcomeClaim:review.observedOutcome?.type||null,
      pipelineApproved:assessment.usable===true,assessment:assessment.mode,
      failureReasons:[...new Set([...(assessment.issues||[]),...(review.issues||[])])],
      evidenceLevel:evidence.sourceRecords?.length?'native_and_review':'job_status_only',
      nativeDirectBallCoverage:records.length?records.filter(record=>record.direct_ball===true).length/records.length:null,
      nativeSampleCount:records.length,hardGeometryViolations:evidence.geometryReview?.violations||[],
      detector:evidence.detector||null,reviewModel:review.generationProvenance?.actualModel||null,
      trackerVersion:evidence.hybridTrackingVersion||null,
      repairAttempts:(evidence.cameraRepairHistory||[]).map(({strategy,status})=>({strategy,status})),
      annotationStatus:'needs_human_verification',groundTruth:null};
  });
  return {version:FOOTBALL_EVALUATION_VERSION,createdAt:now,jobId:job.id,sourceId,sourceIdentityVerified:Boolean(fingerprint),
    aspectRatio:job.settings?.aspectRatio||null,cases,summary:{scenes:cases.length,
      pipelineApproved:cases.filter(item=>item.pipelineApproved).length,
      needsRepair:cases.filter(item=>!item.pipelineApproved).length,
      humanVerified:0,accuracy:null}};
}

export function validateFootballLabels(labels) {
  const splits=new Map(),ids=new Set();
  for(const label of labels) {
    if(!label.caseId||ids.has(label.caseId))throw new Error('Every annotation needs a unique caseId.');
    ids.add(label.caseId);
    if(label.verifiedByHuman!==true)continue;
    if(!label.matchGroup || typeof label.cropShouldPass!=='boolean'
      || !['train','validation','test','regression'].includes(label.split))
      throw new Error('Verified annotations need a match group, split and crop verdict.');
    const group=splits.get(label.matchGroup)||new Set();group.add(label.split);splits.set(label.matchGroup,group);
  }
  for(const group of splits.values()) {
    const partitions=[...group].filter(split=>split!=='regression');
    if(partitions.length>1)throw new Error('Training, validation and test matches must be disjoint.');
  }
}

export function summarizeFootballEvaluation(reports,labels=[]) {
  validateFootballLabels(labels);
  const latest=new Map();
  for(const report of [...reports].sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))))
    for(const item of report.cases||[])latest.set(item.caseId,item);
  const cases=[...latest.values()],byId=new Map(cases.map(item=>[item.caseId,item]));
  const verified=labels.filter(label=>label.verifiedByHuman===true&&byId.has(label.caseId));
  const evaluated=verified.map(label=>({label,result:byId.get(label.caseId)}));
  const falseApprovals=evaluated.filter(({label,result})=>!label.cropShouldPass&&result.pipelineApproved).length;
  const falseRejections=evaluated.filter(({label,result})=>label.cropShouldPass&&!result.pipelineApproved).length;
  const categories=[...new Set(verified.flatMap(label=>label.categories||[]))].sort();
  const required=['goal','header','save','miss','penalty','occlusion','fast_pan','replay','low_light'];
  const matches=new Set(verified.map(label=>label.matchGroup)).size;
  return {sources:new Set(cases.map(item=>item.sourceId)).size,cases:cases.length,
    portraitCases:cases.filter(item=>item.aspectRatio==='9:16').length,
    pipelineApproved:cases.filter(item=>item.pipelineApproved).length,
    needsRepair:cases.filter(item=>!item.pipelineApproved).length,
    humanVerified:verified.length,verifiedMatches:matches,categories,
    missingCategories:required.filter(category=>!categories.includes(category)),
    falseApprovals:verified.length?falseApprovals:null,falseRejections:verified.length?falseRejections:null,
    cropVerdictAccuracy:verified.length?(verified.length-falseApprovals-falseRejections)/verified.length:null,
    // This is an initial release gate, not a claim that any finite corpus
    // guarantees success for every possible football recording.
    broadReleaseEvidenceReady:verified.length>=50&&matches>=10&&falseApprovals===0
      &&falseRejections===0&&required.every(category=>categories.includes(category))};
}
