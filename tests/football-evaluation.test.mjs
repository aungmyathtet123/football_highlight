import assert from 'node:assert/strict';
import test from 'node:test';
import {buildFootballEvaluationReport,summarizeFootballEvaluation,validateFootballLabels} from '../local-processor/football-evaluation.mjs';

test('pipeline approvals are never counted as labelled accuracy',()=>{
  const job={id:'run-a',settings:{aspectRatio:'9:16'},moments:[{id:'scene',startTime:1,endTime:3,
    eventType:'save',selectionLocked:true,sourceSelectionEvidence:{sourceFingerprint:{sha256:'video-a'}}}]};
  const report=buildFootballEvaluationReport(job,{},()=>({usable:true,mode:'saved_verdict'}));
  assert.equal(report.cases[0].nativeDirectBallCoverage,null);
  assert.equal(report.cases[0].groundTruth,null);
  const summary=summarizeFootballEvaluation([report]);
  assert.equal(summary.humanVerified,0);assert.equal(summary.cropVerdictAccuracy,null);
  assert.equal(summary.falseApprovals,null);assert.equal(summary.broadReleaseEvidenceReady,false);
});

test('random frames from one match cannot leak between training and test',()=>{
  const label={verifiedByHuman:true,matchGroup:'same-game',cropShouldPass:true};
  assert.throws(()=>validateFootballLabels([{...label,caseId:'frame-1',split:'train'},
    {...label,caseId:'frame-2',split:'test'}]),/disjoint/);
  assert.doesNotThrow(()=>validateFootballLabels([{...label,caseId:'frame-1',split:'train'},
    {...label,caseId:'frame-2',matchGroup:'other-game',split:'test'}]));
});

test('false approvals and regressions are measured against human labels',()=>{
  const reports=[{createdAt:'2026-01-01',cases:[{caseId:'a',sourceId:'video-a',pipelineApproved:false},
    {caseId:'b',sourceId:'video-b',pipelineApproved:false}]},
    {createdAt:'2026-01-02',cases:[{caseId:'a',sourceId:'video-a',pipelineApproved:true}]}];
  const labels=[{caseId:'a',verifiedByHuman:true,matchGroup:'a',split:'test',cropShouldPass:false,categories:['save']},
    {caseId:'b',verifiedByHuman:true,matchGroup:'b',split:'test',cropShouldPass:true,categories:['header']}];
  const summary=summarizeFootballEvaluation(reports,labels);
  assert.equal(summary.cases,2);assert.equal(summary.sources,2);
  assert.equal(summary.falseApprovals,1);assert.equal(summary.falseRejections,1);
  assert.equal(summary.cropVerdictAccuracy,0);assert.equal(summary.broadReleaseEvidenceReady,false);
});
