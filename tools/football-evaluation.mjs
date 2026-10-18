import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {buildFootballEvaluationReport,summarizeFootballEvaluation} from '../local-processor/football-evaluation.mjs';
import {assessHybridFraming} from '../local-processor/hybrid-framing.mjs';

const [command,...args]=process.argv.slice(2);
const readJson=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
if(command==='collect' && args.length===3) {
  const [jobPath,trackingPath,outputDirectory]=args;
  const report=buildFootballEvaluationReport(await readJson(jobPath),await readJson(trackingPath),assessHybridFraming);
  await mkdir(outputDirectory,{recursive:true});
  await writeFile(join(outputDirectory,`${report.jobId}.json`),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report.summary,null,2));
} else if(command==='collect-status' && args.length>=2 && args.length<=3) {
  const [jobPath,outputDirectory,sourcePath]=args;
  let sourceFingerprint;
  if(sourcePath){const hash=createHash('sha256');for await(const chunk of createReadStream(sourcePath))hash.update(chunk);sourceFingerprint=hash.digest('hex');}
  const report=buildFootballEvaluationReport(await readJson(jobPath),{},scene=>({usable:scene.trackingPassed===true,mode:scene.trackingDecision}),{sourceFingerprint});
  await mkdir(outputDirectory,{recursive:true});
  await writeFile(join(outputDirectory,`${report.jobId}.json`),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report.summary,null,2));
} else if(command==='summary' && args.length>=1 && args.length<=2) {
  const [directory,labelsPath]=args;
  const reports=await Promise.all((await readdir(directory)).filter(name=>name.endsWith('.json')).map(name=>readJson(join(directory,name))));
  console.log(JSON.stringify(summarizeFootballEvaluation(reports,labelsPath?await readJson(labelsPath):[]),null,2));
} else throw new Error('Usage: node tools/football-evaluation.mjs collect JOB_JSON TRACKING_JSON OUTPUT_DIR | summary REPORT_DIR [HUMAN_LABELS_JSON]');
