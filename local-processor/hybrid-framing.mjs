import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { trackedPositionExpression } from './tracked-position.mjs';
import { filterGraphFileArgs } from './ffmpeg-compat.mjs';
import { footballVideoPart } from './gemini-media-policy.mjs';
import {cropMediaPreflight} from './crop-media-preflight.mjs';
import { HYBRID_TRACKING_VERSION } from './hybrid-tracking-policy.mjs';
import { isDisciplinaryAction, DISCIPLINARY_ACTION_CONTRACT } from './disciplinary-action.mjs';
import { reviewedFramingEvent } from './gemini-framing.mjs';

const supportOnly = scene => scene.eventType === 'celebration' || scene.storyPhase === 'reaction';
export function hybridActionReviewContract(scene) {
  if (supportOnly(scene)) return 'This is a verified support reaction, NOT gameplay. Require the involved subject face and torso in view and stable camera movement. outcomeVisible means this visible reaction is shown clearly, not that a shot outcome is shown again. Do not demand ball, setup, contact or flight in a reaction. Irrelevant gameplay flags may be false without failing passed. Record reaction phaseChecks with truthful visibility. Never infer a goal or identity from this reaction alone.';
  if (isDisciplinaryAction(scene)) return DISCIPLINARY_ACTION_CONTRACT + ' Record setup and infringement contact with the carrier/ball, and payoff with the visible decision subject. Do not demand shot flight. Phase hints are not proof.';
  if(scene.eventType==='normal_play') return 'This is a NON-FINISHING football action, not an assumed shot. Identify the actual action from the pixels: a pass, clearance, press, interception, recovery or dribble. Require the relevant player with the real match ball, visible decisive contact, followed continuation and a directly observed resolution. A completed pass resolves with receiver control; a recovery with regained control; a successful clearance with the ball visibly escaping the immediate challenge. A blocked pass or clearance is a different actual result: it resolves when the pressing player visibly blocks the match ball and its redirected path is visible. Judge ballFollowed through that actual resolution. Do not reject an already resolved block because later ball movement or a later possession leaves the view. Include the initial release and blocking touch as separate contact checks, followed by the redirected-flight and block-resolution payoff checks. Do not invent a shot, goal, keeper save or receiving player. Do not demand a shooting/header contact in a non-finishing action. Report observedOutcome.type=not_applicable and describe the actual visible non-shot resolution. Off-screen ball movement or an unrelated camera cut does not prove a completed action. Source cuts can reset position; within-shot movement must remain stable.';
  return 'Require the starting carrier with the real football, complete touch, followed ball flight, receiver or keeper and resolved outcome. Reject unrelated player-only footage, off-screen football and shaky movement. Source cuts can reset position; within-shot movement must be stable. For each setup/contact/flight/payoff phase, record phaseChecks ONLY when the actual moving match ball and relevant subject are visibly identifiable in this crop. Do not call a boot, static spare ball or white logo the ball. If the ball cannot be visually followed through a gap, reject; never fill the report from phase hints. An assisted finish has TWO different contacts: the initial pass/cross release and the later receiving shot/header. Include separate contact phaseChecks for BOTH visible touches. If the final touch is not visually identifiable, reject contactVisible even if the initial pass is clear. Cite the actual resolved result time in a payoff phaseCheck; timestamps need not equal the estimated phase boundary.';
}
const finite = value => typeof value === 'number' && Number.isFinite(value);
export function hybridEvidenceWindowMatches(scene,evidence) {
  return [['startTime','sourceStartTime'],['endTime','sourceEndTime']].every(([key,sourceKey])=>{
    const value=evidence?.[sourceKey];
    return value===undefined || finite(value) && finite(scene[key]) && Math.abs(value-scene[key])<=.001;
  });
}
export const FINISHING_ACTION_PAYOFF = 'Resolve the selected action, not every later possession: a save is complete when the keeper visibly stops or deflects the shot and its redirected path is seen; a block is complete when the interception and redirected ball are seen; a miss is complete when the ball visibly passes wide or over. Do not reject a clearly observed save merely because the later rebound recovery or next possession leaves the frame. A goal requires the actual ball entering the goal. Never infer an unobserved keeper touch or goal.';
export const NEUTRAL_CROP_VERDICT = 'passed judges visible, complete, correctly framed action and stable movement, NOT whether the attacker scored. A clearly observed save, block, woodwork, wide or over is a successful framing result when setup, contact, flight and its real payoff are visible. ballEnteredGoal=false alone is NEVER a framing failure. Do not assume the clip is a goal. Report observedOutcome from these pixels: goal, keeper_save, woodwork, blocked, wide, over, uncertain, or not_applicable for a non-finishing action. keeperContactVisible is true only for a directly visible keeper interaction with the match ball. Unknown or off-screen outcomes still fail; never turn an uncertain result into a success.';
export function hybridReviewInstructions(scene) {
  // Shot instructions contradicted the reaction contract and caused reviews
  // to demand an unseen shot in an otherwise correctly framed celebration.
  return hybridActionReviewContract(scene) + (supportOnly(scene)||isDisciplinaryAction(scene)||scene.eventType==='normal_play' ? ''
    : `\n${FINISHING_ACTION_PAYOFF}\n${NEUTRAL_CROP_VERDICT}\nA ball hitting the SIDE or BACK of the net from outside the posts is a miss, not a goal. Identify the plane between the posts and follow the match ball relative to that plane; a diving keeper and moving net alone prove nothing.`);
}
export function hybridDetailIndexes(scene,count,fps=3,maximum=8) {
  if (!(count>0)) return [];
  const brief=scene.trackingBrief||{};
  const local=key=>finite(brief[key])?brief[key]-scene.startTime:null;
  const contact=local('contactTime'),release=local('flightStartTime');
  const times=[0,(count-1)/fps,release,contact,local('payoffStartTime'),local('payoffEndTime'),
    contact==null?null:contact-1/fps,contact==null?null:contact+1/fps,
    release==null?null:release-1/fps,release==null?null:release+1/fps];
  const indexes=new Set();
  for(const time of times) if(finite(time)&&indexes.size<maximum)
    indexes.add(Math.max(0,Math.min(count-1,Math.round(time*fps))));
  for(let index=0;indexes.size<Math.min(count,maximum)&&index<maximum;index++)
    indexes.add(Math.round(index*(count-1)/Math.max(1,maximum-1)));
  return [...indexes].sort((a,b)=>a-b);
}
const reviewFlags = ['passed','correctSubject','stableCamera','outcomeVisible','ballFollowed',
  'setupVisible','contactVisible','ballEnteredGoal'];
export function needsCropOutcomeDetail(scene,review) {
  const finishingEvent=['goal','save','shot_on_target','shot_off_target','big_chance'].includes(scene.eventType);
  const contradictory=scene.eventType==='goal' ? review?.ballEnteredGoal===false : review?.ballEnteredGoal===true;
  // A negative verdict with all visibility checks true is internally inconsistent.
  // Reobserve the pixels rather than changing that negative verdict in code.
  const inconsistentVerdict=review?.passed===false && review?.outcomeVisible===true;
  return finishingEvent && (contradictory || inconsistentVerdict)
    && review.correctSubject===true && review.stableCamera===true
    && review.ballFollowed===true && review.contactVisible===true
    && review.outcomeVisible===true;
}
export function hybridOutcomeVideoWindow(scene,review) {
  const duration=scene.endTime-scene.startTime;
  const contacts=(review?.phaseChecks||[]).filter(check=>check.phase==='contact'&&finite(check.time)
    &&check.time>=0&&check.time<=duration).map(check=>check.time);
  const contact=contacts.length?Math.max(...contacts):finite(scene.trackingBrief?.contactTime)
    ? scene.trackingBrief.contactTime-scene.startTime:Math.max(0,duration-2.5);
  const payoff=review?.phaseChecks?.find(check=>check.phase==='payoff'&&finite(check.time)
    &&check.time>=contact&&check.time<=duration)?.time;
  const start=Math.max(0,Math.min(duration-.1,contact-.5));
  return {start,end:Math.min(duration,Math.max(start+3,(payoff??contact)+.75))};
}
export function normalizeHybridReview(value) {
  const review = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (!review || Array.isArray(review) || typeof review !== 'object'
    || reviewFlags.some(key=>typeof review[key] !== 'boolean')
    || !Array.isArray(review.observations) || !Array.isArray(review.phaseChecks))
    throw new Error('Hybrid crop review returned an invalid evidence object');
  return review; // Preserve false verdicts; never turn a parser repair into approval.
}

// Phase hints can be wrong even when the camera is right. Bind editorial
// timing to a complete, independently observed action in that SAME crop.
// This never changes scene boundaries, coordinates, or a negative verdict.
export function reviewedHybridPhaseBrief(scene, evidence) {
  const review=evidence?.renderReview;
  if (!review || ['passed','correctSubject','stableCamera','outcomeVisible','ballFollowed','setupVisible','contactVisible']
    .some(key=>review[key]!==true) || review.issues?.length
    || scene.eventType==='goal' && review.ballEnteredGoal!==true
    || ['save','shot_on_target','shot_off_target','big_chance'].includes(scene.eventType) && review.ballEnteredGoal!==false) return null;
  const duration=scene.endTime-scene.startTime;
  const checks=(review.phaseChecks||[]).filter(check=>finite(check.time) && check.time>=0 && check.time<=duration
    && check.ballVisible===true && typeof check.description==='string' && check.description.trim().length>=12);
  const setups=checks.filter(check=>check.phase==='setup' && check.playerVisible===true).sort((a,b)=>a.time-b.time);
  const payoff=checks.filter(check=>check.phase==='payoff').sort((a,b)=>a.time-b.time)[0];
  const contacts=checks.filter(check=>check.phase==='contact' && check.playerVisible===true
    && payoff && check.time<payoff.time).sort((a,b)=>a.time-b.time);
  const contact=contacts.at(-1);
  const flight=checks.filter(check=>check.phase==='flight' && contact && payoff
    && check.time>=contact.time && check.time<payoff.time).sort((a,b)=>a.time-b.time)[0];
  if (!setups.length || !contact || !flight || !payoff || setups[0].time>contact.time) return null;
  const absolute=time=>+(scene.startTime+time).toFixed(3);
  return {...scene.trackingBrief, originTime:absolute(setups[0].time),
    contactTime:absolute(contact.time), flightStartTime:absolute(contact.time),
    handoffTime:absolute(flight.time), payoffStartTime:absolute(payoff.time), payoffEndTime:absolute(payoff.time),
    annotationStartTime:absolute(Math.max(0,contact.time-.6)),
    annotationEndTime:absolute(Math.min(duration,contact.time+.3)),
    payoffEvidence:scene.trackingBrief?.payoffEvidence ? {...scene.trackingBrief.payoffEvidence,
      startTime:absolute(payoff.time),endTime:absolute(Math.min(duration,payoff.time+1/8))}:null,
    timingEvidence:'independent_actual_crop_phase_checks'};
}
export const HYBRID_REVIEW_SCHEMA = {type:'object',required:[...reviewFlags,'issues','observations','phaseChecks','observedOutcome','keeperContactVisible'],
  properties:{...Object.fromEntries(reviewFlags.map(key=>[key,{type:'boolean'}])),
    keeperContactVisible:{type:'boolean'},
    observedOutcome:{type:'object',required:['type','time','description'],properties:{
      type:{type:'string',enum:['goal','keeper_save','woodwork','blocked','wide','over','uncertain','not_applicable']},
      time:{type:'number'},description:{type:'string'}}},
    issues:{type:'array',items:{type:'string'}},
    observations:{type:'array',items:{type:'object',required:['time','description'],
      properties:{time:{type:'number'},description:{type:'string'}}}},
    phaseChecks:{type:'array',items:{type:'object',required:['phase','time','ballVisible','playerVisible','description'],
      properties:{phase:{type:'string',enum:['setup','contact','flight','payoff']},time:{type:'number'},
        ballVisible:{type:'boolean'},playerVisible:{type:'boolean'},description:{type:'string'}}}}}};

export const HYBRID_FINISH_REVIEW_SCHEMA = {
  ...HYBRID_REVIEW_SCHEMA,
  required:HYBRID_REVIEW_SCHEMA.required.filter(key=>key!=='setupVisible'),
  properties:Object.fromEntries(Object.entries(HYBRID_REVIEW_SCHEMA.properties).filter(([key])=>key!=='setupVisible')),
};
export function mergeHybridOutcomeReview(earlier,finish,{start,end}) {
  normalizeHybridReview(earlier);
  if (!finish || reviewFlags.filter(key=>key!=='setupVisible').some(key=>typeof finish[key]!=='boolean')
    || !Array.isArray(finish.phaseChecks) || !Array.isArray(finish.observations)
    || !Array.isArray(finish.issues) || typeof finish.keeperContactVisible!=='boolean')
    throw new Error('Hybrid finish review returned invalid evidence');
  const within=time=>finite(time)&&time>=start-.001&&time<=end+.001;
  if (!within(finish.observedOutcome?.time)
    || [...finish.phaseChecks,...finish.observations].some(check=>!within(check.time))
    || finish.phaseChecks.some(check=>!['contact','flight','payoff'].includes(check.phase)))
    throw new Error('Hybrid finish review cited evidence outside the supplied finish window');
  // Earlier visibility is immutable: a short finish cannot reapprove unseen
  // setup, a missed first pass, or an unstable opening camera.
  const preserved=['correctSubject','stableCamera','ballFollowed','contactVisible'];
  const combined={...finish,setupVisible:earlier.setupVisible,
    ...Object.fromEntries(preserved.map(key=>[key,earlier[key]===true&&finish[key]===true])),
    issues:[...new Set([...(earlier.issues||[]),...finish.issues])],
    observations:[...earlier.observations.filter(check=>finite(check.time)&&check.time<start),...finish.observations],
    phaseChecks:[...earlier.phaseChecks.filter(check=>finite(check.time)&&check.time<start&&check.phase!=='payoff'),...finish.phaseChecks]};
  combined.passed=finish.passed===true&&combined.setupVisible===true
    &&preserved.every(key=>combined[key]===true)&&combined.issues.length===0;
  return normalizeHybridReview(combined);
}

// Measure the camera subject, not the optional annotation subject. A ring may
// identify a later scorer; it must never make an unrelated opening player count
// as a verified ball carrier. A model approval cannot override this evidence.
export function hybridGeometry(scene, evidence) {
  if(!hybridEvidenceWindowMatches(scene,evidence))
    return {usable:false,issues:['native_evidence_scene_window_mismatch'],violations:['native_evidence_scene_window_mismatch']};
  if (!evidence?.sourceRecords?.length || !evidence?.keyframes?.length
    || evidence.sourceRecords.length !== evidence.keyframes.length)
    return { usable: false, issues: ['missing_native_observations'] };
  const records = evidence.sourceRecords;
  const frames = evidence.keyframes;
  const samples = records.map((record, index) => {
    const frame = frames[index], crop = frame?.cropBox;
    if (!Array.isArray(crop) || crop.length !== 4) return { time: record.time, phase: record.action_phase };
    const inside = (x, y) => finite(x) && finite(y)
      && x >= crop[0] + (crop[0]<=.000001?0:.008)
      && x <= crop[2] - (crop[2]>=.999999?0:.008)
      && y >= crop[1] && y <= crop[3];
    const ball = record.direct_ball === true && inside(record.ball_x, record.ball_y);
    const player = record.player_track_id != null
      && inside(record.player_x1, record.player_top) && inside(record.player_x2, record.player_bottom);
    return { time: record.time, phase: record.action_phase, ball, player,
      cut: Boolean(record.scene_cut), cameraX: frame.cameraX };
  });
  const issues = [];
  const violations = [];
  const phases = {};
  const brief = scene.trackingBrief || evidence.trackingBrief || {};
  const localTime = key => finite(brief[key]) && finite(scene.startTime) ? brief[key] - scene.startTime : null;
  const contact = localTime('contactTime');
  const payoffStart = localTime('payoffStartTime'), payoffEnd = localTime('payoffEndTime');
  for (const phase of ['setup', 'contact', 'flight', 'payoff']) {
    // Release can be instantaneous: flightStartTime === contactTime is valid.
    // Observe the touch's neighbouring frames, not a zero-length phase interval.
    // Likewise a celebration after the documented result need not contain ball.
    const group = samples.filter(sample => phase === 'contact' && contact != null
      ? sample.time >= contact - .30 && sample.time <= contact + .25
      : phase === 'payoff' && payoffStart != null && payoffEnd != null
        ? sample.time >= payoffStart && sample.time <= payoffEnd
        : sample.phase === phase);
    phases[phase] = { samples: group.length,
      ball: group.filter(sample => sample.ball).length / Math.max(1, group.length),
      joint: group.filter(sample => sample.ball && sample.player).length / Math.max(1, group.length) };
  }
  if (!supportOnly(scene)) {
    if (!samples.some(sample => sample.time <= .8 && sample.ball && sample.player)) issues.push('opening_carrier_and_ball_missing');
    if (!phases.contact.samples || phases.contact.joint < .5) issues.push('contact_carrier_and_ball_unverified');
    if (phases.setup.samples && phases.setup.joint < .5) issues.push('setup_carrier_and_ball_unverified');
    if (!isDisciplinaryAction(scene) && phases.flight.samples && phases.flight.ball < .5) issues.push('ball_flight_unverified');
    if (!phases.payoff.samples || phases.payoff.ball < .4) issues.push('resolved_action_ball_unverified');
  }
  if (samples.some((sample,index) => records[index].direct_ball === true && !sample.ball))
    violations.push('observed_ball_outside_safe_crop');
  for (let index = 1; index < samples.length; index++) {
    const current = samples[index], previous = samples[index - 1];
    const dt = current.time - previous.time;
    if (!current.cut && dt > 0 && finite(current.cameraX) && finite(previous.cameraX)
      && Math.abs(current.cameraX - previous.cameraX) / dt > .35 + .002) {
      violations.push('within_shot_camera_speed_exceeded'); break;
    }
  }
  // A missing detector response is unknown, not proof that pixels lack a ball.
  // Only an actual independent crop observation can resolve those phase gaps.
  // Known off-screen measurements and excessive camera motion remain hard errors.
  return { usable: !violations.length, fullyMeasured: !issues.length,
    issues: [...violations, ...issues], violations, phases };
}

export function assessHybridFraming(scene, evidence) {
  if (evidence?.provider !== 'hybrid-football') return null;
  if (evidence.hybridTrackingVersion !== HYBRID_TRACKING_VERSION)
    return { usable: false, mode: 'hybrid_cache_version_mismatch' };
  if (evidence.reviewRepairError)
    return { usable: false, mode: 'hybrid_review_unavailable', issues: [evidence.reviewRepairError] };
  // Step 1 locks the source interval, not an infallible event label. Use an
  // independently verified crop outcome for the event-specific checks below.
  const correctedEvent=reviewedFramingEvent(scene,evidence);
  if(correctedEvent && correctedEvent!==scene.eventType) scene={...scene,eventType:correctedEvent};
  const reviewedBrief=reviewedHybridPhaseBrief(scene,evidence);
  if (reviewedBrief) scene={...scene,trackingBrief:reviewedBrief};
  const geometry = hybridGeometry(scene, evidence);
  if (!geometry.usable) return { usable: false, mode: geometry.issues[0], issues: geometry.issues };
  const review = evidence.renderReview;
  const checks = ['passed', 'correctSubject', 'stableCamera', 'outcomeVisible'];
  if (!supportOnly(scene)) checks.push('ballFollowed', 'setupVisible', 'contactVisible');
  if (scene.eventType === 'goal') checks.push('ballEnteredGoal');
  const missing = checks.filter(key => review?.[key] !== true);
  if (['save','shot_on_target','shot_off_target','big_chance'].includes(scene.eventType) && review?.ballEnteredGoal===true)
    missing.push('crop_outcome_contradicts_selected_non_goal');
  if (review?.observedOutcome && ['goal','save','shot_on_target','shot_off_target','big_chance'].includes(scene.eventType)) {
    const outcome=review.observedOutcome;
    const duration=scene.endTime-scene.startTime;
    if (!finite(outcome.time) || outcome.time<0 || outcome.time>duration
      || typeof outcome.description!=='string' || outcome.description.trim().length<12
      || !['goal','keeper_save','woodwork','blocked','wide','over'].includes(outcome.type))
      missing.push('unobserved_finishing_outcome');
    if (scene.eventType==='goal' && outcome.type!=='goal') missing.push('crop_outcome_contradicts_selected_goal');
    if (scene.eventType!=='goal' && outcome.type==='goal') missing.push('crop_outcome_contradicts_selected_non_goal');
    if (outcome.type==='keeper_save' && review.keeperContactVisible!==true)
      missing.push('keeper_touch_unobserved');
  }
  const brief = scene.trackingBrief || evidence.trackingBrief || {};
  const duration = scene.endTime - scene.startTime;
  const contact = finite(brief.contactTime) ? brief.contactTime - scene.startTime : null;
  const release = finite(brief.flightStartTime) ? brief.flightStartTime - scene.startTime : contact;
  const payoff = finite(brief.payoffStartTime) ? brief.payoffStartTime - scene.startTime : null;
  const inPhase = (phase,time) => {
    // Native missed samples are unknown, not proof that setup is absent.
    // A complete positive independent crop review supplies its observed phase
    // clock. An aerial reception can have visible setup after the first .8s;
    // it must still precede the actual decisive contact. Incomplete reviews
    // retain the conservative opening-gap rule, and hard containment/motion
    // violations above can never be overridden by this timing reconciliation.
    if (phase === 'setup') return time <= (geometry.issues.includes('opening_carrier_and_ball_missing') && !reviewedBrief
      ? .8 : Math.min(contact ?? duration,release ?? duration));
    if (phase === 'contact' && contact != null) return time >= contact - .30 && time <= contact + .25;
    if (phase === 'flight' && release != null) return time >= release && time <= (payoff ?? duration);
    // Video observations are sampled at 8fps. A visible outcome one sample
    // before the semantic estimate is still direct evidence of that outcome.
    if (phase === 'payoff' && payoff != null) return time >= payoff - 1/8;
    return true;
  };
  const phaseForIssue = { opening_carrier_and_ball_missing:'setup', setup_carrier_and_ball_unverified:'setup',
    contact_carrier_and_ball_unverified:'contact', ball_flight_unverified:'flight', resolved_action_ball_unverified:'payoff' };
  for (const phase of new Set(geometry.issues.map(issue=>phaseForIssue[issue]).filter(Boolean))) {
    const observed = (review?.phaseChecks || []).filter(check => check.phase === phase
      && finite(check.time) && check.time >= 0 && check.time <= scene.endTime - scene.startTime
      && inPhase(phase,check.time)
      && typeof check.description === 'string' && check.description.trim().length >= 12
      && (isDisciplinaryAction(scene) && phase === 'payoff' ? check.playerVisible === true : check.ballVisible === true)
      && (!['setup','contact'].includes(phase) || check.playerVisible === true));
    if (!observed.length) missing.push(`unobserved_${phase}_gap`);
  }
  if (missing.length || !Array.isArray(review?.observations) || review.observations.length < 2)
    return { usable: false, mode: 'hybrid_render_review_incomplete', issues: missing };
  return { usable: true, mode: 'hybrid_crop_verified' };
}

// A positive crop verdict can omit a final-flight timestamp. Reusing that
// incomplete JSON forever cannot fix it. Observe the decisive interval once;
// never use this path to shop for a positive verdict on a rejected camera.
export function needsHybridPhaseDetail(scene, evidence) {
  if (!['goal','disallowed_goal','save','shot_on_target','shot_off_target','big_chance'].includes(scene.eventType)) return false;
  const review=evidence?.renderReview;
  if (!review || ['passed','correctSubject','stableCamera','outcomeVisible','ballFollowed','setupVisible','contactVisible']
    .some(key=>review[key]!==true) || review.issues?.length
    || review.phaseChecks?.some(check=>check.ballVisible!==true)) return false;
  const assessment=assessHybridFraming(scene,evidence);
  return !assessment.usable && assessment.issues?.length>0
    && assessment.issues.every(issue=>/^unobserved_(?:contact|flight|payoff)_gap$/.test(issue));
}

// Shared by production and the bounded, video-only quality canary. The canary
// must inspect exactly the same pixels, contract and detail as production.
export function hybridCropReviewRequest({model,scene,videoData,geometryIssues=[],detail=[],videoOnly=true}) {
  return {model,contents:[footballVideoPart(videoData,videoOnly?12:8),...detail,
    {text:`Independently inspect this ACTUAL rendered crop. No claimed score or player name is supplied. Use neutral roles only in observations and descriptions, never inferred player names, team names or scorelines; framing is not identity verification.
${hybridReviewInstructions(scene)}
Do not infer a goal from celebration, a scoreboard, a spare ball or a shot wide/over. ballEnteredGoal is true only when the moving match ball visibly crosses the goal line inside the goal. Cite concrete scene-local timestamps.
Native detector gaps need independent pixel evidence, not automatic approval: ${JSON.stringify(geometryIssues)}.
The following are scene-local phase hints, NOT proof of the action or coordinates: ${JSON.stringify(Object.fromEntries(Object.entries(scene.trackingBrief || {}).filter(([key,value])=>/Time$/.test(key)&&finite(value)).map(([key,value])=>[key,value-scene.startTime])))}.
${videoOnly?'The supplied native-detail video contains the complete actual crop at 12fps. Inspect ball movement, receiving touches and finish directly from this video.':'The labelled high-detail stills show the SAME actual crop before preview downsampling; use them to inspect the small ball and contact, and use the video to judge movement.'} No source outside the crop is supplied. Return ONE JSON object, not an array, with boolean passed, correctSubject, stableCamera, outcomeVisible, ballFollowed, setupVisible, contactVisible, ballEnteredGoal; issues:[string]; observations:[{time:number,description:string}]; phaseChecks:[{phase:string,time:number,ballVisible:boolean,playerVisible:boolean,description:string}].`}],
    config:{responseMimeType:'application/json',responseJsonSchema:HYBRID_REVIEW_SCHEMA,temperature:0,
      maxOutputTokens:8192,thinkingConfig:{thinkingLevel:'MEDIUM'}}};
}

export async function reviewHybridCrop({ sourcePath, sourceFingerprint, scene, evidence, media,
  ratio, directory, ffmpeg, run, model, generate, videoOnly = false,
  probeVideo,
  filterGraphArgs = filterGraphFileArgs }) {
  const geometry = hybridGeometry(scene, evidence);
  const result = { ...evidence, provider: 'hybrid-football', hybridTrackingVersion: HYBRID_TRACKING_VERSION,
    geometryReview: geometry, geometryVerified:geometry.usable === true, finalCropVerified: false };
  if (!geometry.usable) return result; // Never pay for approval of known bad geometry.
  const key = createHash('sha256').update(JSON.stringify({ sourceFingerprint, model,
    version: HYBRID_TRACKING_VERSION, videoOnly, reviewVersion:scene.eventType==='normal_play'?6:4, start: scene.startTime, end: scene.endTime,
    ratio, supportOnly: supportOnly(scene), trackingBrief: scene.trackingBrief,
    geometryIssues: geometry.issues, keyframes: evidence.keyframes })).digest('hex');
  const folder = join(directory, key);
  await mkdir(folder, { recursive: true });
  const reviewPath = join(folder, 'review.json');
  let review;
  try { review = normalizeHybridReview(JSON.parse(await readFile(reviewPath, 'utf8'))); } catch { /* fresh camera */ }
  if (!review) {
    const x = trackedPositionExpression(evidence.keyframes, 'cameraX', .5);
    const crop = media.width / media.height >= ratio
      ? `crop=ih*${ratio}:ih:x='max(0,min(iw-ow,iw*(${x})-ow/2))':y=0`
      : `crop=iw:iw/${ratio}:x=0:y='(ih-oh)/2'`;
    const graph = join(folder, 'crop-filter.txt'), video = join(folder, 'crop.mp4');
    const stillHeight = 2*Math.floor((media.width/media.height>=ratio?media.height:media.width/ratio)/2);
    const stillWidth = 2*Math.round(stillHeight*ratio/2);
    await writeFile(graph, videoOnly
      ? `[0:v]setpts=PTS-STARTPTS,${crop},scale=${stillWidth}:${stillHeight},fps=12[v]`
      : `[0:v]setpts=PTS-STARTPTS,${crop},split=2[c][q];[c]scale=-2:720,fps=8[v];[q]fps=3,scale=${stillWidth}:${stillHeight}[qa]`);
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(scene.startTime),
      '-i', sourcePath, '-t', String(scene.endTime - scene.startTime),
      ...await filterGraphArgs(ffmpeg, graph), '-map', '[v]', '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', video,
      ...(videoOnly?[]:['-map','[qa]','-an','-c:v','mjpeg','-q:v','3','-frames:v',String(Math.ceil((scene.endTime-scene.startTime)*3)),join(folder,'frame-%03d.jpg')])]);
    if(probeVideo) {
      const preflight=cropMediaPreflight(scene,await probeVideo(video),videoOnly?12:8);
      result.cropMediaPreflight=preflight;
      await writeFile(join(folder,'crop-media-preflight.json'),JSON.stringify(preflight));
      if(!preflight.usable)return result; // Remains unverified; no model call.
    }
    const stills=(await readdir(folder)).filter(name=>/^frame-\d+\.jpg$/.test(name)).sort();
    const detail=[];
    for (const index of videoOnly?[]:hybridDetailIndexes(scene,stills.length)) {
      const name=stills[index];
      detail.push({text:`ACTUAL CROP detail frame at scene-local ${(index/3).toFixed(3)} seconds. No labels or target coordinates added.`},
        {inlineData:{mimeType:'image/jpeg',data:(await readFile(join(folder,name))).toString('base64')},
          mediaResolution:{level:'MEDIA_RESOLUTION_HIGH'}});
    }
    review = normalizeHybridReview(await generate(hybridCropReviewRequest({model,scene,
      videoData:(await readFile(video)).toString('base64'),geometryIssues:geometry.issues,detail,videoOnly}),
      `hybrid rendered crop ${scene.id}`));
    await writeFile(reviewPath, JSON.stringify(review));
  }
  result.renderReview = review;
  const phaseDetail=videoOnly && needsHybridPhaseDetail(scene,result);
  if(videoOnly && (needsCropOutcomeDetail(scene,review) || phaseDetail)) {
    // A goal/non-goal disagreement is an outcome ambiguity, not a reason to
    // repeat scene selection, run another tracker or reuse the same verdict.
    // Inspect one higher-temporal-detail finish from this exact crop and source.
    // The wide reference establishes the goal plane, never crop visibility.
    const detailPath=join(folder,phaseDetail?'phase-video-review-v2.json':'outcome-video-review-v3.json');
    const window=hybridOutcomeVideoWindow(scene,review);
    let detailed;
    try {detailed=mergeHybridOutcomeReview(review,JSON.parse(await readFile(detailPath,'utf8')),window);} catch { /* New finish evidence. */ }
    if(!detailed) {
      const {start,end}=window;
      const cropVideo=join(folder,'finish-crop.mp4'),sourceVideo=join(folder,'finish-source.mp4');
      const graph=join(folder,'finish-video-filter.txt');
      const x=trackedPositionExpression(evidence.keyframes,'cameraX',.5);
      const crop=media.width/media.height>=ratio
        ? `crop=ih*${ratio}:ih:x='max(0,min(iw-ow,iw*(${x})-ow/2))':y=0`
        : `crop=iw:iw/${ratio}:x=0:y='(ih-oh)/2'`;
      const height=2*Math.floor((media.width/media.height>=ratio?media.height:media.width/ratio)/2);
      const width=2*Math.round(height*ratio/2);
      await writeFile(graph,`[0:v]setpts=PTS-STARTPTS,split=2[c][s];[c]${crop},trim=start=${start}:end=${end},setpts=PTS-STARTPTS,scale=${width}:${height},fps=12[cv];[s]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,fps=12[sv]`);
      await run(ffmpeg,['-hide_banner','-loglevel','error','-y','-ss',String(scene.startTime),'-i',sourcePath,
        '-t',String(scene.endTime-scene.startTime),...await filterGraphArgs(ffmpeg,graph),
        '-map','[cv]','-an','-c:v','libx264','-preset','veryfast','-crf','18',cropVideo,
        '-map','[sv]','-an','-c:v','libx264','-preset','veryfast','-crf','18',sourceVideo]);
      let finish;
      try { finish=await generate({model,contents:[
        {text:`ACTUAL PORTRAIT FINISH, at 12fps. Excerpt 0 corresponds to scene-local ${start}s; it ends at ${end}s. Earlier action has already been independently reviewed and is not supplied here. Judge only this finish, not the unseen opening setup.`},
        footballVideoPart((await readFile(cropVideo)).toString('base64'),12),
        {text:`ORIGINAL WIDE SOURCE REFERENCE for the same ${start}-${end}s interval. This is NOT part of the edited crop. Use it only to locate the plane between both posts and below the crossbar and distinguish side/back net, misses, saves and rebounds. Source-only visibility MUST NOT approve any crop phase or ballFollowed/outcomeVisible flag.`},
        footballVideoPart((await readFile(sourceVideo)).toString('base64'),12),
        {text:`Independently observe the real moving match ball through final contact, flight and resolution. No prior outcome verdict or score is supplied. A ball hitting side/back net from OUTSIDE the goal, or passing above/beside the posts, is NOT a goal. Report an actual goal only if it crosses the FRONT goal plane between the posts and under the bar. Confirm that the PORTRAIT crop itself shows the result; a result visible only in the wide reference must fail outcomeVisible. ${FINISHING_ACTION_PAYOFF} ${NEUTRAL_CROP_VERDICT} correctSubject, stableCamera, ballFollowed and contactVisible judge only this supplied portrait interval. Return finish review JSON using scene-local timestamps, adding ${start}s to times read in the excerpts. Include only contact, flight and payoff phaseChecks and observations within ${start}-${end}s. Record a separate flight check AFTER the LAST receiving shot/header touch and BEFORE the resolved payoff, only if the actual match ball is identifiable. Initial-cross flight cannot stand in for final-shot flight. If that flight or touch is not visible, report false rather than inventing a timestamp. Do not report or infer earlier setup or passes. Reject uncertainty or missing crop action; do not assume an outcome to make this pass.`},
      ],config:{responseMimeType:'application/json',responseJsonSchema:HYBRID_FINISH_REVIEW_SCHEMA,temperature:0,
        maxOutputTokens:16384,thinkingConfig:{thinkingLevel:'MEDIUM'}}},`hybrid crop outcome video ${scene.id}`); }
      catch(error) {
        // A service timeout cannot convert a disputed goal/miss into crop
        // approval. Save the native track and first review for a scene-only
        // retry, while letting other locked scenes finish their own reviews.
        const aborted=error?.name==='AbortError' || error?.cause?.name==='AbortError';
        if(!aborted && ![408,429,500,502,503,504].includes(Number(error?.status||error?.code))) throw error;
        result.reviewRepairError=`Finish review unavailable (${aborted?'timeout':error.status||error.code}); outcome unverified.`;
        result.finalCropVerified=false;
        return result;
      }
      detailed=mergeHybridOutcomeReview(review,finish,window);
      await writeFile(detailPath,JSON.stringify(finish));
    }
    result.initialRenderReview=review;
    result.renderReview=detailed;
  }
  // A coherent action review can still misread a fast final touch. Reobserve
  // only that actual crop's decisive interval; never borrow the source verdict
  // or turn a negative answer into approval without new pixel evidence.
  if (!videoOnly && needsCropOutcomeDetail(scene,review)) {
    const detailPath=join(folder,'outcome-detail-review-v6.json');
    let detailed;
    try { detailed=normalizeHybridReview(JSON.parse(await readFile(detailPath,'utf8'))); } catch { /* fresh detail */ }
    if (!detailed) {
      const duration=scene.endTime-scene.startTime;
      const contact=scene.trackingBrief?.contactTime-scene.startTime;
      const start=Math.max(0,finite(contact)?contact-.375:duration-2.5);
      const end=Math.min(duration,start+2.5);
      const x=trackedPositionExpression(evidence.keyframes,'cameraX',.5);
      const crop=media.width/media.height>=ratio
        ? `crop=ih*${ratio}:ih:x='max(0,min(iw-ow,iw*(${x})-ow/2))':y=0`
        : `crop=iw:iw/${ratio}:x=0:y='(ih-oh)/2'`;
      const graph=join(folder,'outcome-detail-filter.txt');
      await writeFile(graph,`[0:v]setpts=PTS-STARTPTS,${crop},trim=start=${start}:end=${end},setpts=PTS-STARTPTS,fps=8[v]`);
      await run(ffmpeg,['-hide_banner','-loglevel','error','-y','-ss',String(scene.startTime),'-i',sourcePath,
        ...await filterGraphArgs(ffmpeg,graph),'-map','[v]','-an','-c:v','mjpeg','-q:v','3',
        '-frames:v',String(Math.ceil((end-start)*8)),join(folder,'outcome-%03d.jpg')]);
      const names=(await readdir(folder)).filter(name=>/^outcome-\d+\.jpg$/.test(name)).sort();
      const parts=[];
      for(let index=0;index<names.length;index++) parts.push(
        {text:`Actual same-crop frame at scene-local ${(start+index/8).toFixed(3)} seconds.`},
        {inlineData:{mimeType:'image/jpeg',data:(await readFile(join(folder,names[index]))).toString('base64')},
          mediaResolution:{level:'MEDIA_RESOLUTION_HIGH'}});
      detailed=normalizeHybridReview(await generate({model,contents:[...parts,{text:
        `Independently observe the decisive contact, subsequent flight and outcome using these chronological native-detail frames of ONE portrait crop. No earlier outcome claim, original wide view or claimed score is supplied. Set ballEnteredGoal true ONLY if these pixels clearly show the moving match ball crossing the line INSIDE the goal. Otherwise describe the observed save, block or miss; if the outcome is unobservable reject outcomeVisible. ${FINISHING_ACTION_PAYOFF} ${NEUTRAL_CROP_VERDICT} A keeper diving and a ball heading toward the goal are not proof it entered: follow the actual ball AFTER the keeper interaction. Distinguish a rebound out into the penalty area from a ball going into the net. Do not treat a deflected ball, spare ball, net occlusion or celebration as scoring proof. The independently observed earlier setup ONLY is ${JSON.stringify((review.phaseChecks||[]).filter(check=>check.phase==='setup'))}; preserve this setup only if not contradicted. Report final-contact, final-flight and payoff observations solely from the supplied chronological pixels with their labelled scene-local times. Include a separate flight phaseCheck after the final touch only if the real ball is identifiable. Return the complete review JSON schema, including all booleans, issues, observations, phaseChecks and observedOutcome. Never approve an unobservable finish.`}],
        config:{responseMimeType:'application/json',responseJsonSchema:HYBRID_REVIEW_SCHEMA,temperature:0,
          thinkingConfig:{thinkingLevel:'HIGH'}}},`hybrid crop outcome detail ${scene.id}`));
      await writeFile(detailPath,JSON.stringify(detailed));
    }
    result.initialRenderReview=review;
    result.renderReview=detailed;
  }
  result.finalCropVerified = assessHybridFraming(scene, result).usable;
  return result;
}
