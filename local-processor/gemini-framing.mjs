import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join,basename,dirname,resolve } from "node:path";
import { createHash } from "node:crypto";
import { trackedPositionExpression } from "./tracked-position.mjs";
import { filterGraphFileArgs } from "./ffmpeg-compat.mjs";
import { isDecisionScene } from "./decision-framing.mjs";
import { footballVideoPart } from "./gemini-media-policy.mjs";
import { isDisciplinaryAction, DISCIPLINARY_ACTION_CONTRACT } from "./disciplinary-action.mjs";
import { NON_SHOT_COMPLETION_CONTRACT } from './action-completion-contract.mjs';
import { observeFramingVideo, checkpointVideoFramingCorrections, videoFramingRequest, normalizeVideoFramingResponse, validateVideoFramingFrames, focusedVideoWindows, framingVideoInputArgs, framingVideoClockFilter, DETAIL_VIDEO_FRAMING_MAX_SAMPLES, VIDEO_SAMPLE_CLOCK_VERSION, VIDEO_FRAMING_FPS, VIDEO_FRAMING_VERSION } from './gemini-video-framing.mjs';
import {geminiServiceFailure} from './gemini-request-scheduler.mjs';

export const GEMINI_FRAMING_VERSION = 11;
export const GEMINI_CAMERA_POLICY_VERSION = 6;
export const GEMINI_SAMPLE_CLOCK_VERSION = VIDEO_SAMPLE_CLOCK_VERSION;
export const GEMINI_CROP_REVIEW_POLICY_VERSION = 5;
export function framingReviewGenerationConfig() {
  // Thinking and visible JSON share the output ceiling. MEDIUM consumed
  // almost all of 8192 tokens in a real crop review, leaving truncated JSON
  // and forcing another complete video request. Start with the retry-safe
  // budget instead; do not wait for that failure on every new upload.
  return {responseMimeType:'application/json',responseSchema:framingReviewResponseSchema(),
    maxOutputTokens:16384,temperature:0,thinkingConfig:{thinkingLevel:'LOW'}};
}
export class FramingVerificationError extends Error {
  constructor(sceneId,reason) {
    super(`Gemini framing could not verify ${sceneId}: ${reason}`);
    this.name='FramingVerificationError'; this.sceneId=sceneId;
    this.code='INITIAL_FRAMING_PLAN';
  }
}
export function framingSourceFilter(fps,attempt=0) {
  // round=up retains the source frame at/before each labelled output tick.
  // The old default selected a later source frame (e.g. +80 ms at 6 fps).
  return `fps=${fps}:start_time=0:round=up,scale=w='min(${attempt?1920:1280},iw)':h=-2`;
}
export const FRAMING_SITUATIONS = ["approach", "possession", "release", "travel", "receive", "keeper_touch", "rebound", "loose_ball", "result", "reaction", "decision"];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const subjectOnly = scene => isDecisionScene(scene) || scene.eventType === "celebration"
  || scene.storyPhase === "reaction";

export const FOOTBALL_ACTION_COMPLETION_CONTRACT = `Judge the football action's visible sporting consequence, not whether the ball is tracked forever. A goal requires the real moving ball visibly crossing the goal line inside the posts. A wide/over shot is complete when the actual ball is visibly travelling outside the post/over the crossbar with that goal boundary readable; the ball may then leave the SOURCE picture. A save requires visible keeper contact or clearly visible controlled collection, not a dive alone. A clearly followed parry/block/post rebound proves that shot's consequence; the NEXT possession need not finish unless a new attacking contact is included. After a visibly resolved consequence, an out-of-play ball or stationary post-action reaction is not missing gameplay. A ball already visibly wide/over and out of play moving into advertising/stands is post-action support, NOT ongoing attacking flight; label actual subsequent reaction honestly. Retain the final-touch player or the directly observed involved goalkeeper in a continuous wide shot rather than jumping to a distant teammate's reaction. Do NOT approve a ball lost BEFORE the consequence, an unreadable goal boundary, a substituted spare ball, an unseen keeper touch, or an unfinished additional attacking contact. Never turn false visibility flags into true merely to complete the job.`;

const completeActionContract = `${FOOTBALL_ACTION_COMPLETION_CONTRACT} ${NON_SHOT_COMPLETION_CONTRACT}`;

// Visual observers must not receive a director's claimed result or names.
// Those hypotheses previously primed both tracking and crop review to call a
// spare ball a scored goal. Keep the independent observation input neutral;
// assessGeminiFraming still compares its result with the selected event.
export function framingObservationContext(scene) {
  return { startTime: scene.startTime, endTime: scene.endTime,
    mode: subjectOnly(scene) ? "subject_support" : "football_action" };
}

export function framingBatchWindow(offset,count,fps,duration) {
  const start=Math.max(0,(offset-2)/fps);
  const end=Math.min(duration,(offset+count+2)/fps);
  return {start,end,duration:end-start};
}

export const FRAMING_PHASE_MAP_SCHEMA={type:'object',required:['phases','uncertainties'],properties:{
  phases:{type:'array',maxItems:24,items:{type:'object',required:['phase','startTime','endTime','visibleAction'],properties:{
    phase:{type:'string',enum:['setup','contact','flight','continuation','payoff','reaction','decision']},
    startTime:{type:'number'},endTime:{type:'number'},visibleAction:{type:'string'}}}},
  uncertainties:{type:'array',items:{type:'string'}}}};

export function focusedFramingResponseSchema() {
  const nullableBox={type:'ARRAY',nullable:true,items:{type:'NUMBER'}};
  return {type:'OBJECT',required:['frames'],properties:{frames:{type:'ARRAY',items:{type:'OBJECT',
    required:['index','phase','situation','cut','ball','player','goalkeeper','goalPost','subjectCore','faceCore','identity','explanation','actionResolved','ballInPlay'],
    properties:{index:{type:'INTEGER'},phase:{type:'STRING',enum:['setup','contact','flight','continuation','payoff','reaction','decision']},
      situation:{type:'STRING',enum:FRAMING_SITUATIONS},cut:{type:'BOOLEAN'},
      ball:nullableBox,player:nullableBox,goalkeeper:nullableBox,goalPost:nullableBox,subjectCore:nullableBox,faceCore:nullableBox,
      actionResolved:{type:'BOOLEAN'},ballInPlay:{type:'BOOLEAN'},
      identity:{type:'STRING'},explanation:{type:'STRING'}}}},
    shotEntries:{type:'ARRAY',items:{type:'OBJECT',required:['cutIndex','firstVisibleBallIndex','sourceCutVerified','ballHiddenByCutOrPlayer','samePlayerControlVerified','noContactOrPayoffHidden','evidence'],
      properties:{cutIndex:{type:'INTEGER'},firstVisibleBallIndex:{type:'INTEGER'},sourceCutVerified:{type:'BOOLEAN'},
        ballHiddenByCutOrPlayer:{type:'BOOLEAN'},samePlayerControlVerified:{type:'BOOLEAN'},
        noContactOrPayoffHidden:{type:'BOOLEAN'},evidence:{type:'STRING'}}}},
    occlusions:{type:'ARRAY',items:{type:'OBJECT',required:['beforeIndex','afterIndex','ballTemporarilyOccluded','sameShotTrajectoryVerified','evidence'],
      properties:{beforeIndex:{type:'INTEGER'},afterIndex:{type:'INTEGER'},ballTemporarilyOccluded:{type:'BOOLEAN'},
        sameShotTrajectoryVerified:{type:'BOOLEAN'},evidence:{type:'STRING'}}}}}};
}
export function normalizeFramingPhaseMap(value,duration) {
  if(!Array.isArray(value?.phases)||!value.phases.length||value.phases.length>24
    ||!Array.isArray(value.uncertainties)) throw new Error('Incomplete source phase timeline');
  let previous=-Infinity;
  for(const phase of value.phases) {
    if(!['setup','contact','flight','continuation','payoff','reaction','decision'].includes(phase.phase)
      ||!Number.isFinite(phase.startTime)||!Number.isFinite(phase.endTime)
      ||phase.startTime<0||phase.startTime<previous||phase.endTime<phase.startTime||phase.endTime>duration+.001
      ||typeof phase.visibleAction!=='string'||!phase.visibleAction.trim()) throw new Error('Invalid source phase timeline clock');
    previous=phase.startTime;
  }
  return value;
}

export function framingReviewDetailTimes(observations,duration,maximum=12) {
  const times=new Set([0]);
  for(const phase of ['contact','payoff','flight','setup']) {
    const matching=observations.filter(frame=>frame.phase===phase);
    for(const frame of [matching[0],matching.at(-1)]) if(frame) {
      for(const offset of phase==='contact'||phase==='payoff'?[-.125,0,.125]:[0])
        if(times.size<maximum) times.add(+Math.max(0,Math.min(duration-.01,frame.time+offset)).toFixed(4));
    }
  }
  return [...times].sort((a,b)=>a-b);
}

// Remove only a geometrically impossible pre-touch prefix. The actual first
// contact, all later phases and the scene identity remain unchanged. This is
// a proposal, not an approval: the newly rendered crop is reviewed afterward.
export function portraitSetupLeadIn(scene,observations,media,ratio=9/16) {
  if(subjectOnly(scene) || !observations.length) return null;
  const contact=observations.findIndex(frame=>frame.phase==='contact' || frame.situation==='release');
  if(contact<1 || observations[contact].time>4) return null;
  const width=Math.min(1,ratio/(media.width/media.height));
  const fits=frame=>frame.ball && frame.player
    && Math.max(frame.ball.x2,frame.player.x2)-Math.min(frame.ball.x1,frame.player.x1)<=width;
  const opening=observations.slice(0,contact);
  if(!opening.every((frame,index)=>frame.phase==='setup' && frame.ball && frame.player
    && (index===0 || !frame.cut) && (!frame.situation || frame.situation==='possession'))) return null;
  const first=opening.findIndex(fits);
  if(first<1 || opening.slice(0,first).some(fits)) return null;
  const offset=observations[first].time;
  if(offset>3.5 || observations[contact].time-offset<.1
    || scene.endTime-scene.startTime-offset<3
    || !observations.slice(first,contact+1).every(fits)) return null;
  const trimmed=observations.slice(first).map((frame,index)=>({...frame,time:frame.time-offset,cut:index===0||frame.cut}));
  const adjusted={...scene,startTime:+(scene.startTime+offset).toFixed(4)};
  // Propose only the opener adjustment here. The caller MUST plan and review
  // the complete adjusted crop. If a later phase still fails, report THAT
  // failure instead of hiding it behind the already-repaired opening error.
  return {scene:adjusted,observations:trimmed,offset};
}

// A tight, unframeable prelude can precede a genuine broadcast cut to the
// complete action. Retain that clear shot only when the SAME observed carrier
// and ball are visible before its first release. Never skip a pass, shot,
// flight, payoff or another player's receiving touch to make a crop fit.
export function portraitClearShotLeadIn(scene,observations,media,ratio=9/16) {
  if(subjectOnly(scene)||!observations.length) return null;
  const contact=observations.findIndex(frame=>frame.phase==='contact'||frame.situation==='release');
  if(contact<2) return null;
  const width=Math.min(1,ratio/(media.width/media.height));
  const fits=frame=>frame.ball&&frame.player
    && Math.max(frame.ball.x2,frame.player.x2)-Math.min(frame.ball.x1,frame.player.x1)<=width;
  const prelude=observations.slice(0,contact);
  if(fits(prelude[0])||!prelude.every(frame=>frame.player
    && ['setup','continuation'].includes(frame.phase)&&frame.situation==='possession')) return null;
  for(let index=1;index<contact;index++) {
    const frame=observations[index];
    if(!frame.cut||!fits(frame)||!prelude.slice(0,index).every(value=>value.ball)
      ||observations[contact].time-frame.time<.2
      ||scene.endTime-scene.startTime-frame.time<3
      ||!observations.slice(index,contact+1).every((value,localIndex)=>fits(value)
        ||!value.ball&&(possessionOcclusionSupported(observations,index+localIndex)
          ||bracketedVisibility(observations,index+localIndex,observed=>!!observed.ball&&!!observed.player)))) continue;
    return {scene:{...scene,startTime:+(scene.startTime+frame.time).toFixed(4)},
      observations:observations.slice(index).map((value,i)=>({...value,time:value.time-frame.time,cut:i===0||value.cut})),
      offset:frame.time,reason:'unframeable_pre_contact_closeup',
      firstContactSourceTime:scene.startTime+observations[contact].time};
  }
  return null;
}

export function clearShotLeadInReviewPassed(review) {
  return review?.sameCarrierBeforeAndAfterCut===true&&review.noPassOrShotRemoved===true
    &&review.setupContactPayoffComplete===true&&Array.isArray(review.issues)&&review.issues.length===0;
}

export function reviewedLeadInScene(scene,evidence) {
  const repair=evidence?.actionLeadInRepair;
  if(evidence?.provider!=='gemini-vision' || evidence.finalCropVerified!==true
    || !repair || !['unframeable_pre_touch_setup','unframeable_pre_contact_closeup'].includes(repair.reason)
    || Math.abs(repair.originalStartTime-scene.startTime)>.001
    || Math.abs(repair.originalEndTime-scene.endTime)>.001
    || !(evidence.sourceStartTime>scene.startTime)
    || (repair.reason==='unframeable_pre_touch_setup' && evidence.sourceStartTime-scene.startTime>3.5)
    || (repair.reason==='unframeable_pre_contact_closeup'
      && (!clearShotLeadInReviewPassed(repair.boundaryReview)
        || !Number.isFinite(repair.firstContactSourceTime)
        || evidence.sourceStartTime+.2>repair.firstContactSourceTime
        || repair.firstContactSourceTime>=scene.endTime
        || Math.abs(evidence.sourceStartTime-scene.startTime-repair.offset)>.001))
    || evidence.sourceEndTime!==scene.endTime) return scene;
  const adjusted={...scene,startTime:evidence.sourceStartTime,
    boundaryCorrection:{...(scene.boundaryCorrection||{}),originalStartTime:scene.startTime,
      originalEndTime:scene.endTime,reason:repair.reason},
    trackingBrief:{...scene.trackingBrief,originTime:Math.max(scene.trackingBrief?.originTime||scene.startTime,evidence.sourceStartTime)}};
  return assessGeminiFraming(adjusted,evidence)?.usable?adjusted:scene;
}

function box(value) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) return null;
  // Gemini's documented native box order is Y,X,Y,X. Convert once here;
  // asking for X,Y in prose can still yield native-order spatial outputs.
  const [y1, x1, y2, x2] = value.map(x => x / 1000);
  return x1 >= 0 && y1 >= 0 && x2 <= 1 && y2 <= 1 && x2 > x1 && y2 > y1
    ? { x1, y1, x2, y2 } : null;
}

function observedCoreBelongsToPlayer(core, player) {
  if (!core || !player) return false;
  // Independently estimated boxes need not share exact edges. Preserve the
  // observed box (never crop/synthesize it) when only a small edge discrepancy
  // exists and at least 90% of that core overlaps the same observed person.
  const tolerance = .02;
  if (core.x1 < player.x1 - tolerance || core.x2 > player.x2 + tolerance
    || core.y1 < player.y1 - tolerance || core.y2 > player.y2 + tolerance) return false;
  const overlap = Math.max(0, Math.min(core.x2, player.x2) - Math.max(core.x1, player.x1))
    * Math.max(0, Math.min(core.y2, player.y2) - Math.max(core.y1, player.y1));
  return overlap / ((core.x2 - core.x1) * (core.y2 - core.y1)) >= .9;
}

function bracketedVisibility(observations, index, present) {
  let before = index - 1, after = index + 1;
  while (before >= 0 && !present(observations[before]) && !observations[before + 1].cut) before--;
  while (after < observations.length && !present(observations[after]) && !observations[after].cut) after++;
  return before >= 0 && after < observations.length
    && present(observations[before]) && present(observations[after])
    && !observations.slice(before + 1, after + 1).some(f => f.cut)
    && observations[after].time - observations[before].time <= .4 + 1e-9;
}

function possessionOcclusionSupported(frames, index) {
  const current = frames[index];
  if (!current.player || current.ball || !["possession", "receive", "release"].includes(current.situation)) return false;
  let before = index - 1, after = index + 1;
  while (before >= 0 && !frames[before].ball) before--;
  while (after < frames.length && !frames[after].ball) after++;
  if (before < 0 || after >= frames.length || frames[after].time - frames[before].time > 1) return false;
  const span = frames.slice(before, after + 1);
  if (span.slice(1).some(f => f.cut) || span.some(f => !f.player)) return false;
  if (!current.identity || span.some(f => f.identity !== current.identity)) return false;
  if (frames.slice(before + 1, after).some(f => !["possession", "receive", "release"].includes(f.situation))) return false;
  const atFeet = f => {
    const x = (f.ball.x1 + f.ball.x2) / 2, y = (f.ball.y1 + f.ball.y2) / 2;
    return x >= f.player.x1 - .04 && x <= f.player.x2 + .04
      && y >= (f.player.y1 + f.player.y2) / 2 && y <= f.player.y2 + .04;
  };
  return atFeet(frames[before]) && atFeet(frames[after]);
}

// During a set-piece or goal, the ball can be hidden behind the defensive
// pack for longer than a normal tracking gap.  We may keep the observed
// receiving/goalkeeper player in frame, but only when Gemini saw the ball on
// both sides of the gap in the same source shot.  This does not invent a
// ball position and never crosses a camera cut.
function goalFlightOcclusionSupported(scene, frames, index) {
  if (!/goal/i.test(String(scene.eventType || ""))) return false;
  const current = frames[index];
  // Do not use this relaxation for the actual finish: the ball must be
  // directly observed at payoff so the goal/keeper outcome remains honest.
  if (!current.player || current.ball || !["flight", "continuation"].includes(current.phase)) return false;
  let before = index - 1, after = index + 1;
  while (before >= 0 && !frames[before].ball) before--;
  while (after < frames.length && !frames[after].ball) after++;
  if (before < 0 || after >= frames.length) return false;
  if (frames[after].time - frames[before].time > 1.75) return false;
  const span = frames.slice(before, after + 1);
  if (span.slice(1).some(f => f.cut)) return false;
  // Every hidden frame must still contain the involved action player.  This
  // prevents accepting an empty crowd/goal-mouth interval as evidence.
  if (span.some(f => !f.player)) return false;
  if (span.slice(1, -1).some(f => !["flight", "continuation"].includes(f.phase))) return false;
  return true;
}

// These are direct visual observations at explicit scene-local ticks, not a
// sparse semantic summary or guessed/interpolated ball coordinates.
export function normalizeGeminiObservations(raw, count, fps) {
  if (!Array.isArray(raw?.frames) || raw.frames.length !== count) throw new Error("Gemini framing omitted sampled frames.");
  const indices = new Set();
  return raw.frames.map(frame => {
    if (!Number.isInteger(frame.index) || frame.index < 0 || frame.index >= count || indices.has(frame.index)) {
      throw new Error("Gemini framing returned invalid or duplicate image indexes.");
    }
    indices.add(frame.index);
    const phase = String(frame.phase);
    if (!["setup", "contact", "flight", "continuation", "payoff", "reaction", "decision"].includes(phase)) {
      throw new Error("Gemini framing returned an unknown action phase.");
    }
    const situation = frame.situation == null ? null : String(frame.situation);
    if (situation && !FRAMING_SITUATIONS.includes(situation)) throw new Error("Gemini framing returned an unknown football situation.");
    const player = box(frame.player);
    const goalkeeper=box(frame.goalkeeper);
    const core = box(frame.subjectCore);
    const face = box(frame.faceCore);
    // This must be an observed face-and-torso region belonging to ONE subject,
    // not a synthetic centre slice of an oversized arm/group box.
    const subjectCore = observedCoreBelongsToPlayer(core, player) ? core : null;
    const faceCore = observedCoreBelongsToPlayer(face, player) ? face : null;
    return { time: frame.index / fps, phase, situation, cut: frame.cut === true,
      ball: box(frame.ball), player, goalkeeper, goalPost:box(frame.goalPost), subjectCore, faceCore,
      actionResolved:frame.actionResolved===true,ballInPlay:typeof frame.ballInPlay==='boolean'?frame.ballInPlay:null,
      identity: String(frame.identity || ""), explanation: String(frame.explanation || "").slice(0, 160) };
  }).sort((a, b) => a.time - b.time);
}

export function validateGeminiBatch(raw, offset, count, fps) {
  const frames = (raw?.frames || []).filter(f => Number.isInteger(f.index)
    && f.index >= offset && f.index < offset + count);
  normalizeGeminiObservations({ frames: frames.map(f => ({ ...f, index: f.index - offset })) }, count, fps);
  return { frames };
}

export function validateSavedGeminiBatch(raw,offset,remaining,fps) {
  const count=raw?.frames?.length;
  if(!Number.isInteger(count)||count<1||count>32||count>remaining)
    throw new Error('Invalid saved observation batch size');
  return validateGeminiBatch(raw,offset,count,fps);
}

// The source/model/scene/version signature and attempt fix the original image
// identities and sampling clock. Repair prose changes do not change those
// pixels. Reuse observations as hypotheses, NEVER as crop approval, and focus
// the next visual request on the actual failed region instead of repaying all
// batches for a one-frame mistake.
export async function reusableFramingBatch(directory,signature,attempt,offset,remaining,fps,preferredPath,samplingClockVersion) {
  const prefix=`${signature}.batch-${attempt}-${offset}-`;
  const candidates=[preferredPath,...(await readdir(directory)).filter(name=>name.startsWith(prefix)
    && name.endsWith('.json')).sort().map(name=>join(directory,name))].filter(Boolean);
  for(const path of [...new Set(candidates)].filter(path=>resolve(dirname(path))===resolve(directory)
    && basename(path).startsWith(prefix)&&basename(path).endsWith('.json'))) {
    try {
      const raw=JSON.parse(await readFile(path,'utf8'));
      if(samplingClockVersion!=null&&raw.samplingClockVersion!==samplingClockVersion) continue;
      return validateSavedGeminiBatch(raw,offset,remaining,fps);
    } catch {}
  }
  return null;
}

export function framingReviewHasEvidence(review,duration=Infinity,supportOnly=false) {
  const valid=item=>Number.isFinite(item?.time)&&item.time>=0&&item.time<=duration
    && typeof item.description==='string'&&item.description.trim().length>=12;
  if(Array.isArray(review?.observations)&&review.observations.filter(valid).length>=2) return true;
  // Phase checks already ARE concrete observations from the actual crop, and
  // are the authoritative clock for effects/narration. A second prose table
  // containing the same facts is not extra football evidence.
  const phases=Array.isArray(review?.phaseChecks)?review.phaseChecks.filter(item=>valid(item)
    && typeof item.ballVisible==='boolean'&&typeof item.playerVisible==='boolean'):[];
  return !supportOnly&&['setup','contact','payoff'].every(phase=>phases.some(item=>item.phase===phase
    && (item.ballVisible===true || phase==='contact'
      && (review.possessionOcclusionVerified===true||review.trajectoryOcclusionVerified===true))
    && (phase==='payoff'||item.playerVisible===true)));
}

// Older unconstrained JSON responses sometimes wrapped the ONE review in an
// array. That shape error is not failed football geometry and must not trigger
// another coordinate pass. Never choose a favourable verdict among reviews.
export function normalizeFramingReview(raw) {
  const review=Array.isArray(raw)&&raw.length===1?raw[0]:raw;
  if(!review || typeof review!=='object' || Array.isArray(review)
    || typeof review.passed!=='boolean' || !Array.isArray(review.issues))
    throw new Error('Gemini crop review must contain exactly one review object.');
  return review;
}

export function framingReviewResponseSchema() {
  const flags=['passed','correctSubject','stableCamera','subjectCoreVisible','ballFollowed',
    'setupVisible','contactVisible','outcomeVisible','goalVisible','ballEnteredGoal',
    'receiverVisible','keeperContactVisible','keeperContextVisible','reboundFollowed',
    'possessionOcclusionVerified','trajectoryOcclusionVerified','shotEntryOcclusionVerified'];
  const observation={type:'OBJECT',required:['time','description'],properties:{
    time:{type:'NUMBER'},description:{type:'STRING'}}};
  return {type:'OBJECT',required:[...flags,'issues','observations','phaseChecks','observedOutcome'],
    propertyOrdering:['observations','phaseChecks','observedOutcome',...flags,'issues'],
    properties:{...Object.fromEntries(flags.map(flag=>[flag,{type:'BOOLEAN'}])),
      issues:{type:'ARRAY',items:{type:'STRING'}},
      observations:{type:'ARRAY',items:observation},
      phaseChecks:{type:'ARRAY',items:{type:'OBJECT',required:['phase','time','ballVisible','playerVisible','description'],
        properties:{...observation.properties,phase:{type:'STRING',enum:['setup','contact','flight','payoff']},
          ballVisible:{type:'BOOLEAN'},playerVisible:{type:'BOOLEAN'}}}},
      observedOutcome:{type:'OBJECT',required:['type','time','description'],properties:{...observation.properties,
        type:{type:'STRING',enum:['goal','keeper_save','woodwork','blocked','wide','over','uncertain','not_applicable']}}}}};
}

export function independentCropReviewPrompt(scene,camera,comparison=false) {
  const gaps=camera.keyframes.filter(frame=>frame.possessionOcclusion||frame.trajectoryOcclusion||frame.shotEntryOcclusion)
    .map(frame=>({time:frame.time,possession:!!frame.possessionOcclusion,
      trajectory:!!frame.trajectoryOcclusion,shotEntry:!!frame.shotEntryOcclusion}));
  return `Watch the complete ACTUAL PORTRAIT VIDEO independently, including the final shot and its consequence. No result, identities or scene labels are supplied.
Read the burned-in SCENE seconds clock, not a guessed elapsed time. Watch through the END before deciding the final outcome. List ALL meaningful contacts in chronological phaseChecks: initial pass, receiving control, shot, post/block/save rebound, any follow-up touch/shot, and its final consequence. A shot hitting the post can be followed by a different player scoring; the first shot is not automatically the terminal outcome. observedOutcome must describe the LAST resolved attacking action, with its own clock timestamp. Earlier outcomes belong in phaseChecks. Do not mistake later follow-up play for celebration or clearance.
First describe the real moving ball's starting carrier, each pass/receiving touch and final shot at exact video-local times. Then follow it relative to the goalkeeper, posts and goal line. Determine the actual sporting outcome BEFORE setting visibility verdicts. A keeper diving is NOT a save; a goal needs visible crossing inside the posts. Do not confuse a ball bouncing inside the net with a live rebound. If the ball is too small or the consequence hidden, report uncertain, not an invented contact, rebound or goal.
${comparison?'The first video is the actual crop; the second is a wide source reference of the same action. Reference-only action CANNOT pass a crop. Describe which actual-crop pixels show the consequence.':''}
${subjectOnly(scene)?'This selected clip is subject support, not gameplay: require one actual reacting player/referee with identifiable face/torso and stable framing; ball/action flags may be false.':'Check that the crop shows the initiating player with ball, every meaningful contact, followed ball flight and complete goal/save/miss/pass outcome. Check stable camera motion, not unrelated players or clipped active subjects. A resolved result may end with involved-keeper/reaction support after the ball leaves source view, but not before the result.'}
Return the supplied schema. phaseChecks must include every actual contact, flight and payoff, with timestamps and observed evidence. Use neutral roles only. passed requires complete, readable, stable actual-crop action, not an expected outcome. Set unevidenced optional flags false: keeperContactVisible requires a real keeper touch, reboundFollowed requires an actual LIVE rebound, receiverVisible requires the receiving touch, keeperContextVisible requires the involved keeper to be readable at arrival. Receiving touches can occur ANYWHERE in this clip, not only at the final shooter. receiverVisible=true requires ALL meaningful actual receiving touches to be readable, with their timestamps in phaseChecks. subjectCoreVisible requires a readable face/torso in support footage.
The camera planner requests these independent checks: ${JSON.stringify(camera.requiredReviewChecks||[])}. Verify them from the crop, not from this list. For each actual action that is missing, add a timestamped issue explaining the specific hidden touch, rebound, keeper or occlusion. If a requested event never occurs (for example, no keeper touch in a goal), leave that flag false and explain non-applicability in observations, not as a missing-action issue. Do not invent that event. Do not return passed=true with an actual required visible action missing and an empty issues list.
These uncertain intervals need independent video evidence: ${JSON.stringify(gaps)}. possessionOcclusionVerified requires the SAME visible carrier with ball before/after at their feet within one second and no hidden touch. trajectoryOcclusionVerified requires visible same-shot ball entry/exit around a body, no hidden contact/result. shotEntryOcclusionVerified requires a real source cut into the SAME carrier, ball visible within one second before any release, no hidden action. None permits off-screen play or guessed positions.
Ignore the scoreboard, celebrations and previous model descriptions as outcome proof. Include timestamped issues for actual missing action, unreadable outcome, wrong player or instability. Do not require the next possession after a resolved shot unless this video contains a new unresolved attacking contact.`;
}

export function framingReviewFailure(review,requiredChecks=[],duration=Infinity,supportOnly=false,scene=null,evidence=null) {
  const flags=['passed','correctSubject','stableCamera',...(supportOnly?['subjectCoreVisible']:
    ['ballFollowed','setupVisible','contactVisible','outcomeVisible']),...requiredChecks];
  const missing=[...new Set(flags)].filter(flag=>review?.[flag]!==true);
  if(!framingReviewHasEvidence(review,duration,supportOnly)) missing.push('timestamped_crop_evidence');
  if(scene && review?.observedOutcome && !subjectOnly(scene)
    && ['goal','disallowed_goal','save','shot_on_target','shot_off_target','big_chance'].includes(scene.eventType)
    && !reviewedFramingEvent(scene,evidence||{renderReview:review})) missing.push('source_crop_outcome_unconfirmed');
  const phases=(review?.phaseChecks||[]).filter(check=>check.ballVisible===false
    || check.phase==='payoff').map(check=>({time:check.time,phase:check.phase,description:check.description}));
  return `Cropped scene rejected: ${JSON.stringify({missing,issues:review?.issues||[],
    observedOutcome:review?.observedOutcome,phases})}`;
}

export function focusedFramingImageIndexes(observations,error,maximum=12,phaseHints=[]) {
  const targets=new Set();
  const message=String(error?.message||error);
  if(!/abrupt pan|cannot visually locate|cannot fit this full-bleed crop|did not observe the complete (?:setup|contact|payoff) phase|Cropped scene rejected/.test(message)) return [];
  if(/did not observe the complete (?:setup|contact) phase/.test(message)) {
    const contact=observations.findIndex(frame=>frame.phase==='contact'||frame.situation==='release'||frame.situation==='receive');
    const end=contact>=0?Math.min(observations.length,contact+2):Math.min(observations.length,maximum);
    for(let index=Math.max(0,end-maximum);index<end;index++) targets.add(index);
  }
  if(/did not observe the complete payoff phase|Cropped scene rejected/.test(message)) {
    for(const time of phaseHints.filter(Number.isFinite)) {
      const index=observations.findIndex(frame=>Math.abs(frame.time-time)<=.09);
      if(index>=0) for(const neighbour of [index-1,index,index+1])
        if(neighbour>=0&&neighbour<observations.length) targets.add(neighbour);
    }
    if(!targets.size)
      for(let index=Math.max(0,observations.length-maximum);index<observations.length;index++) targets.add(index);
  }
  for(const match of message.matchAll(/(?:at |between |and )(\d+(?:\.\d+)?)s/g)) {
    const time=Number(match[1]);
    const index=observations.findIndex(frame=>Math.abs(frame.time-time)<.02);
    if(index>=0) targets.add(index);
  }
  // An isolated ball jump during continuous possession is an observation to
  // recheck, not permission to replace it with an interpolated/guessed box.
  for(let index=1;index<observations.length-1;index++) {
    const [a,b,c]=observations.slice(index-1,index+2);
    if(!a.ball||!b.ball||!c.ball||b.cut||c.cut
      || !['possession','receive','release'].includes(b.situation)) continue;
    const center=frame=>[(frame.ball.x1+frame.ball.x2)/2,(frame.ball.y1+frame.ball.y2)/2];
    const distance=(u,v)=>Math.hypot(...u.map((value,i)=>value-v[i]));
    if(distance(center(a),center(c))<.08 && distance(center(a),center(b))>.12
      && distance(center(b),center(c))>.12) targets.add(index);
  }
  if(/cannot visually locate/.test(message)) {
    for(let index=0;index<observations.length;index++)
      if(!observations[index].ball && observations[index].phase!=='reaction'
        && observations[index].phase!=='decision') targets.add(index);
  }
  const selected=new Set();
  for(const index of targets) {
    if(selected.size>=maximum) break;
    selected.add(index);
  }
  for(const index of targets) for(const neighbour of [index-1,index+1])
    if(neighbour>=0&&neighbour<observations.length&&selected.size<maximum) selected.add(neighbour);
  return [...selected].sort((a,b)=>a-b);
}

export function validateFocusedFraming(raw,indexes,fps) {
  if(!Array.isArray(raw?.frames)||raw.frames.length!==indexes.length
    ||new Set(raw.frames.map(frame=>frame.index)).size!==indexes.length
    ||raw.frames.some(frame=>!indexes.includes(frame.index)))
    throw new Error('Focused framing did not return exactly the requested source indexes.');
  normalizeGeminiObservations({frames:raw.frames.map((frame,index)=>({...frame,index}))},indexes.length,fps);
  return {frames:raw.frames,occlusions:Array.isArray(raw.occlusions)?raw.occlusions:[],
    shotEntries:Array.isArray(raw.shotEntries)?raw.shotEntries:[]};
}

export function framingFocusRegion(frame,media) {
  const followingFlight=['flight','payoff'].includes(frame.phase)||['travel','rebound','result'].includes(frame.situation);
  const anchor=followingFlight?(frame.ball||frame.goalkeeper||frame.player):(frame.player||frame.goalkeeper||frame.ball);
  if(!anchor||![media.width,media.height,anchor.x1,anchor.y1,anchor.x2,anchor.y2].every(Number.isFinite)
    ||media.width<2||media.height<2) return null;
  const width=Math.min(800,media.width),height=Math.min(450,media.height);
  const centerX=(anchor.x1+anchor.x2)/2*media.width;
  const centerY=(!followingFlight&&frame.player?anchor.y2:(anchor.y1+anchor.y2)/2)*media.height;
  const x=Math.round(clamp(centerX-width/2,0,media.width-width));
  const y=Math.round(clamp(centerY-height/2,0,media.height-height));
  return {x,y,width,height,nativeBounds:[y/media.height*1000,x/media.width*1000,
    (y+height)/media.height*1000,(x+width)/media.width*1000].map(value=>+value.toFixed(2))};
}

export function attachReviewedTrajectoryOcclusions(observations,reviews,ratio=9/16,sourceRatio=16/9) {
  const result=observations.map(frame=>({...frame}));
  const width=Math.min(1,ratio/sourceRatio);
  for(const review of reviews||[]) {
    const {beforeIndex,afterIndex}=review;
    if(review.ballTemporarilyOccluded!==true || review.sameShotTrajectoryVerified!==true
      || !Number.isInteger(beforeIndex)||!Number.isInteger(afterIndex)||beforeIndex<0
      ||afterIndex>=result.length||afterIndex<=beforeIndex+1
      ||typeof review.evidence!=='string'||review.evidence.trim().length<20) continue;
    const span=result.slice(beforeIndex,afterIndex+1),before=span[0],after=span.at(-1);
    if(!before.ball||!after.ball||after.time-before.time>1
      ||span.slice(1).some(frame=>frame.cut)
      ||span.slice(1,-1).some(frame=>frame.ball||!frame.player
        ||!['flight','continuation','contact'].includes(frame.phase))) continue;
    // Keep the entire observed entry/exit corridor and involved bodies inside
    // the crop. This does NOT invent where the hidden ball was in the gap.
    const boxes=[before.ball,after.ball,...span.slice(1,-1).map(frame=>frame.player)];
    const left=Math.min(...boxes.map(box=>box.x1)),right=Math.max(...boxes.map(box=>box.x2));
    if(right-left>width) continue;
    const evidence={beforeTime:before.time,afterTime:after.time,left,right,evidence:review.evidence};
    for(let index=beforeIndex+1;index<afterIndex;index++) result[index].trajectoryOcclusionEvidence=evidence;
  }
  return result;
}

// A source dissolve/cut can introduce a carrier with the ball momentarily
// hidden by that player's body. There is no same-shot BEFORE sample at a shot
// entry. Keep the directly observed carrier/control region, never invent a ball
// or extrapolate coordinates from the previous angle. Independent crop review
// must verify this entry separately before the camera can be approved.
export function attachReviewedShotEntries(observations,reviews,ratio=9/16,sourceRatio=16/9) {
  const result=observations.map(frame=>({...frame}));
  const width=Math.min(1,ratio/sourceRatio);
  for(const review of reviews||[]) {
    const {cutIndex,firstVisibleBallIndex}=review;
    if(['sourceCutVerified','ballHiddenByCutOrPlayer','samePlayerControlVerified','noContactOrPayoffHidden']
      .some(key=>review[key]!==true) || !Number.isInteger(cutIndex)||!Number.isInteger(firstVisibleBallIndex)
      ||cutIndex<1||firstVisibleBallIndex<=cutIndex||firstVisibleBallIndex>=result.length
      ||typeof review.evidence!=='string'||review.evidence.trim().length<20) continue;
    const span=result.slice(cutIndex,firstVisibleBallIndex+1),entry=span[0],visible=span.at(-1);
    if(!entry.cut||span.slice(1).some(frame=>frame.cut)||visible.time-entry.time>1
      ||!visible.ball||!visible.player||!['possession','receive','travel','loose_ball'].includes(visible.situation)
      ||!['setup','continuation'].includes(visible.phase)
      ||span.slice(0,-1).some(frame=>frame.ball||!frame.player
        ||!['setup','continuation'].includes(frame.phase)
        ||!['possession','receive','travel','loose_ball'].includes(frame.situation))) continue;
    const ballX=(visible.ball.x1+visible.ball.x2)/2,ballY=(visible.ball.y1+visible.ball.y2)/2;
    if(ballX<visible.player.x1-.06||ballX>visible.player.x2+.06
      ||ballY<(visible.player.y1+visible.player.y2)/2||ballY>visible.player.y2+.06) continue;
    const nextContact=result.findIndex((frame,index)=>index>=cutIndex
      && (frame.phase==='contact'||frame.situation==='release'));
    if(nextContact<=firstVisibleBallIndex) continue;
    const boxes=[visible.ball,...span.map(frame=>frame.player)];
    const left=Math.min(...boxes.map(box=>box.x1)),right=Math.max(...boxes.map(box=>box.x2));
    if(right-left>width) continue;
    const evidence={entryTime:entry.time,firstVisibleBallTime:visible.time,left,right,evidence:review.evidence};
    for(let index=cutIndex;index<firstVisibleBallIndex;index++) result[index].shotEntryEvidence=evidence;
  }
  return result;
}

export async function reobserveFocusedFraming({error,observations,all,fps,scene,contextPath,
  attempt,attemptDir,signature,directory,ffmpeg,run,model,generate,report,ratio,media}) {
  const brief=scene.trackingBrief||{},duration=scene.endTime-scene.startTime;
  const indexes=focusedFramingImageIndexes(observations,error,12,
    [brief.contactTime,brief.payoffEvidence?.startTime,brief.payoffEvidence?.endTime]
      .filter(Number.isFinite).map(time=>time-scene.startTime));
  if(!indexes.length) return observations;
  const repairSignature=createHash('sha256').update(JSON.stringify({version:3,samplingClockVersion:GEMINI_SAMPLE_CLOCK_VERSION,
    error:error.message,indexes})).digest('hex').slice(0,16);
  const corrected={frames:[],occlusions:[],shotEntries:[]};
  for(const focused of focusedVideoWindows(indexes,fps,duration)) {
    // A sub-second tail cannot distinguish a live rebound from the ball
    // bouncing inside the net after a goal. Supply the entire short locked
    // action as context, while requesting corrections ONLY at uncertain times.
    // Longer scenes retain the preceding observed contact, not arbitrary stills.
    const precedingContact=observations.filter(frame=>frame.time<=focused.start
      && (frame.phase==='contact'||frame.situation==='release')).at(-1);
    const window={...focused,start:duration<=20?0:Math.min(focused.start,
      precedingContact?Math.max(0,precedingContact.time-1):focused.start)};
    const cache=join(directory,`${signature}.focused-video-v3-${repairSignature}-${window.indexes[0]}.json`);
    const checked=value=>{const raw=normalizeVideoFramingResponse(value);validateVideoFramingFrames(raw,window.indexes,fps);return validateFocusedFraming(raw,window.indexes,fps);};
    let result;
    try {result=checked(JSON.parse(await readFile(cache,'utf8')));} catch { /* This uncertainty has no video correction yet. */ }
    if(!result) {
      await report(`Gemini video: reobserving ${window.indexes.length} uncertain times in ${scene.id} (${window.start.toFixed(3)}–${window.end.toFixed(3)}s); no images or scene changes.`);
      const path=join(attemptDir,`focused-video-${window.indexes[0]}.mp4`);
      await run(ffmpeg,['-hide_banner','-loglevel','error','-y',...framingVideoInputArgs(contextPath,window.start,window.end-window.start),
        '-an','-c:v','libx264','-preset','veryfast','-crf','20',path]);
      const schema=focusedFramingResponseSchema();
      const request=videoFramingRequest({model,data:(await readFile(path)).toString('base64'),window,fps,
        sceneContext:framingObservationContext(scene),schema,contract:completeActionContract});
      // The cached labels are exactly what is in dispute. Do not anchor this
      // observer to those descriptions. Spend reasoning on the few uncertain
      // times rather than repeating a low-reasoning full dense observation.
      request.config.thinkingConfig={thinkingLevel:'MEDIUM'};
      // Corrections may describe witnessed occlusion/shot-entry evidence, but
      // those hypotheses cannot fabricate a ball or independently approve a crop.
      request.config.responseSchema.properties.occlusions=schema.properties.occlusions;
      request.config.responseSchema.properties.shotEntries=schema.properties.shotEntries;
      request.contents.push({text:`The camera planner reported: ${error.message}. Reobserve only the requested times from this continuous ORIGINAL video; this error is not proof of missing action or a command to approve it. The video zero is scene-local ${window.start.toFixed(4)}s. Preserve null for hidden objects and all uninvolved cached times. Distinguish the real moving ball from spare balls, clothing and advertising. A waiting receiver is flight/travel until actual receiving contact. Retain the initiating player through the touch, then follow the ball and visible receiver/goalkeeper/result. Include actionResolved and ballInPlay honestly; never relabel an unfinished shot as reaction to make it pass.`});
      request.contents.push({text:'Watch the contact and consequence in the supplied continuous video BEFORE classifying the requested tail. A ball bouncing inside the net AFTER directly observed goal-line crossing is a resolved goal result, not a live rebound. After a verified goal or ball visibly out of play, use payoff/result with actionResolved:true and ballInPlay:false until a genuine new action; box the directly visible involved goalkeeper and relevant goalpost, and leave ball:null if no longer visible. If the keeper parries back into play or the outcome remains unseen, retain unresolved live gameplay. No assumed goal from scene labels or cached explanations.'});
      request.contents.push({text:'Optional occlusions must cite beforeIndex and afterIndex with the moving ball visibly entering and leaving a short body occlusion in the SAME shot inside this video. Hidden positions remain ball:null. Optional shotEntries apply only to a genuine source cut introducing the SAME visible carrier whose real ball becomes visible under control within one second and BEFORE any release/payoff. Require every declared boolean to be directly observed. Cite exact SCENE-local times and observation indexes, not video-local time or imagined positions. Return empty arrays when context is missing, off-screen, uncertain or spans a hidden contact/result. GoalPost must box only the relevant visible upright/crossbar corner, never the whole net or an inferred goal.'});
      result=checked(await generate(request,`focused video keyframes ${scene.id} times ${window.indexes[0]/fps}-${window.indexes.at(-1)/fps}`));
      await writeFile(cache,JSON.stringify(result));
    }
    corrected.frames.push(...result.frames);corrected.occlusions.push(...result.occlusions);corrected.shotEntries.push(...result.shotEntries);
    // Checkpoint each successful short correction before a later video/service
    // failure, so retry never re-sends completed work or discards neighbours.
    const byIndex=new Map(result.frames.map(frame=>[frame.index,frame]));
    for(let index=0;index<all.length;index++) if(byIndex.has(all[index].index)) all[index]=byIndex.get(all[index].index);
    await checkpointVideoFramingCorrections({frames:all,duration,fps,signature,directory,validateObservations:validateGeminiBatch});
  }
  return attachReviewedShotEntries(attachReviewedTrajectoryOcclusions(
    normalizeGeminiObservations({frames:all},all.length,fps),corrected.occlusions,ratio,media.width/media.height),
    corrected.shotEntries,ratio,media.width/media.height);
}

export function boundedGeminiShotPath(shot,maximumSpeed=.35) {
  if(!shot.length) return [];
  const reach=shot.map(frame=>({low:frame.low,high:frame.high}));
  // Backward reachability starts a pan early enough for the next observed
  // football position. A feasible interval must not be rejected merely because
  // an unconstrained smoothing solve delayed movement until the last frame.
  for(let index=shot.length-2;index>=0;index--) {
    const dt=shot[index+1].time-shot[index].time;
    if(!(dt>0)) throw new Error('Invalid camera observation clock');
    reach[index].low=Math.max(reach[index].low,reach[index+1].low-maximumSpeed*dt);
    reach[index].high=Math.min(reach[index].high,reach[index+1].high+maximumSpeed*dt);
    if(reach[index].low>reach[index].high+1e-9)
      throw new Error(`Gemini crop path requires an abrupt pan between ${shot[index].time.toFixed(4)}s and ${shot[index+1].time.toFixed(4)}s; reobserve these source images.`);
  }
  const path=[(reach[0].low+reach[0].high)/2];
  for(let index=1;index<shot.length;index++) {
    const limit=maximumSpeed*(shot[index].time-shot[index-1].time);
    const low=Math.max(reach[index].low,path[index-1]-limit);
    const high=Math.min(reach[index].high,path[index-1]+limit);
    path.push(clamp(path[index-1],low,high));
  }
  // Smooth only INSIDE the observed visibility and reachable speed bounds.
  // Never trade an off-screen football for a prettier camera curve.
  // Preserve exact holds away from an actual safe-zone exit. Global smoothing
  // used to turn long holds into continuous camera creep. Limit easing to the
  // movement neighbourhood while retaining all visibility/speed constraints.
  const ease=shot.map(()=>false);
  for(let index=1;index<path.length;index++) if(Math.abs(path[index]-path[index-1])>1e-8) {
    for(let neighbour=0;neighbour<shot.length;neighbour++) {
      if(shot[neighbour].time>=shot[index].time-.65 && shot[neighbour].time<=shot[index].time+.25) ease[neighbour]=true;
    }
  }
  for(let pass=0;pass<80;pass++) for(let index=1;index<shot.length-1;index++) {
    if(!ease[index]) continue;
    const before=shot[index].time-shot[index-1].time,after=shot[index+1].time-shot[index].time;
    const low=Math.max(shot[index].low,path[index-1]-maximumSpeed*before,path[index+1]-maximumSpeed*after);
    const high=Math.min(shot[index].high,path[index-1]+maximumSpeed*before,path[index+1]+maximumSpeed*after);
    const desired=(path[index-1]*after+path[index+1]*before)/(before+after);
    path[index]=clamp(desired,low,high);
  }
  return path;
}

function observedPreContactApproach(frames,index) {
  const frame=frames[index];
  if(frame.phase!=='continuation'||!frame.ball||!frame.player
    ||!['travel','loose_ball'].includes(frame.situation)) return false;
  let start=index;
  while(start>0&&!frames[start].cut) start--;
  const shot=frames.slice(start);
  const firstContact=shot.findIndex(value=>value.phase==='contact'||value.situation==='release');
  if(firstContact<0||start+firstContact<=index
    ||frames.slice(start,index+1).some(value=>['payoff','reaction','decision'].includes(value.phase))) return false;
  const x=(frame.ball.x1+frame.ball.x2)/2,y=(frame.ball.y1+frame.ball.y2)/2;
  return x>=frame.player.x1-.06&&x<=frame.player.x2+.06
    &&y>=(frame.player.y1+frame.player.y2)/2&&y<=frame.player.y2+.06;
}

// The active person depends on the touch, not on the name of a JSON field.
// Observers may put an involved keeper only in the separate goalkeeper box,
// leaving player null (or retaining an unrelated outfield player there).
// Prefer that directly observed keeper during keeper_touch. Older responses
// may box the involved keeper in player; retain that observation as-is.
function observedActionPlayer(frame) {
  return frame.situation==='keeper_touch' ? frame.goalkeeper||frame.player : frame.player;
}

export function planGeminiCamera(scene, observations, media, ratio = 9 / 16) {
  if (!observations.length) throw new Error("No Gemini visual observations available.");
  if (!subjectOnly(scene)) {
    for (const phase of ["setup", "contact", "payoff"]) {
      if (!observations.some((f, index) => (f.phase === phase
        || (phase === "setup" && ["possession", "receive"].includes(f.situation))
        || (phase === "setup" && observedPreContactApproach(observations,index))
        || (phase === "contact" && f.situation === "release")
        || (phase === "payoff" && f.situation === "result")
        || (phase === "payoff" && isDisciplinaryAction(scene) && f.phase === 'decision' && f.situation === 'decision'))
        && (f.ball || (phase === "contact" && bracketedVisibility(observations, index, f => !!f.ball))
          || (phase === "payoff" && isDisciplinaryAction(scene) && f.player
            && ['decision','reaction'].includes(f.situation)))
        && (phase === "payoff" || observedActionPlayer(f)))) {
        throw new Error(`Gemini did not observe the complete ${phase} phase.`);
      }
    }
  }
  const width = Math.min(1, ratio / (media.width / media.height));
  const half = width / 2;
  const margin = Math.min(.015, width * .05);
  let gap = 0;
  let resultObserved = false;
  let resultKeeperObserved=false;
  let reactionSourceShot=false;
  const intervals = observations.map((frame, index) => {
    if(frame.cut) {
      resultKeeperObserved=false;
      reactionSourceShot=resultObserved&&['reaction','decision'].includes(frame.phase);
    }
    const priorResultObserved=resultObserved;
    // Observers sometimes label a resolved sporting result as continuation.
    // The observed situation and resolution matter, not that coarse label.
    const observedResult=!!frame.ball && (frame.phase==='payoff'
      || frame.situation==='result' && frame.actionResolved===true);
    if (observedResult || isDisciplinaryAction(scene) && frame.player
      && ['payoff','decision'].includes(frame.phase) && frame.situation === 'decision') resultObserved = true;
    if(observedResult&&frame.goalkeeper) resultKeeperObserved=true;
    // Player-only reaction is permitted only AFTER an observed outcome,
    // never while waiting for contact, flight or the finish.
    // Do not jump away from a still-visible scored/rebounding ball just
    // because a distant player has begun celebrating in the same wide shot.
    // Follow the observed result until the ball is no longer visible; a new
    // reaction-only source scene may then frame the actual reacting subject.
    const deadBallSupport=priorResultObserved
      && frame.actionResolved===true && frame.ballInPlay===false && !frame.cut
      && ['payoff','reaction','decision'].includes(frame.phase) && !!frame.goalkeeper && resultKeeperObserved
      && (!/goal/i.test(String(scene.eventType||'')) || frame.situation==='result' && !frame.ball);
    const onlySubject = subjectOnly(scene) || deadBallSupport
      || (isDisciplinaryAction(scene) && resultObserved && ['payoff','reaction','decision'].includes(frame.phase)
        && ['decision','reaction'].includes(frame.situation))
      || (resultObserved && ['reaction','decision'].includes(frame.phase)
        && (!frame.ball || (reactionSourceShot || !/goal/i.test(String(scene.eventType || '')) && frame.ballInPlay!==true)
          && Boolean(frame.faceCore || frame.subjectCore)));
    // A loose rebound/rolling pass is still ball travel. Do not invent a
    // nearby player just to satisfy a possession-phase label.
    const travelling = ["travel", "rebound", "loose_ball"].includes(frame.situation);
    const keeperReaction=onlySubject && !subjectOnly(scene) && (deadBallSupport||['reaction','decision'].includes(frame.phase))
      && resultKeeperObserved && !!frame.goalkeeper;
    const actionPlayer=observedActionPlayer(frame);
    const subjectBox = onlySubject ? (keeperReaction?frame.goalkeeper:frame.faceCore || frame.subjectCore || frame.player) : actionPlayer;
    // Require an actor at setup/control/touch, not merely because a model
    // also boxed a nearby spectator of a continuation or completed result.
    // Travel/results constrain the ball and their observed keeper context;
    // keeper_touch explicitly uses THAT keeper rather than an outfield player.
    const requirePlayer = !onlySubject && (frame.phase==='contact' || frame.phase==='setup'&&!travelling
      || observedPreContactApproach(observations,index)
      || ["possession", "release", "receive", "keeper_touch"].includes(frame.situation));
    const possessionOcclusion = !onlySubject && possessionOcclusionSupported(observations, index);
    const goalOcclusion = !onlySubject && goalFlightOcclusionSupported(scene, observations, index);
    const trajectoryOcclusion=!onlySubject && !frame.ball && !!frame.player && frame.trajectoryOcclusionEvidence;
    const shotEntryOcclusion=!onlySubject && !frame.ball && !!frame.player && frame.shotEntryEvidence;
    const acceptedOcclusion = possessionOcclusion || goalOcclusion || trajectoryOcclusion || shotEntryOcclusion;
    if ((!onlySubject && !frame.ball && !acceptedOcclusion) || (requirePlayer && !actionPlayer) || (onlySubject&&!subjectBox)) {
      gap += index ? frame.time - observations[index - 1].time : 1 / 8;
      // Step 1 already locked this source shot.  A portrait camera can start
      // on a brief lead-in where the ball is visible but the carrier is still
      // entering the 9:16 crop.  Do not reject the whole scene at local
      // 0.00s: hold a neutral camera interval until the first same-shot frame
      // that jointly observes player and ball.  This is deliberately narrow
      // (ball present, no prior joint frame, <=0.75s, and a joint frame within
      // 0.9s) so genuine mid-action occlusions still require bracketing.
      const leadingJointRecovery = !onlySubject && !!frame.ball && !actionPlayer
        && frame.time <= 0.75
        && !observations.slice(0, index).some(value => !!value.ball && !!observedActionPlayer(value))
        && observations.slice(index + 1).some(value => !value.cut && !!value.ball && !!observedActionPlayer(value)
          && Number(value.time) - Number(frame.time) <= 0.9);
      if (leadingJointRecovery) {
        return { ...frame, low: half, high: 1 - half, constrained: false,
          onlySubject, leadingOcclusion: true };
      }
      // A saved Step-1 interval can contain one reaction/pre-cut frame before
      // the actual broadcast shot begins. Preserve the interval, but treat
      // that frame as lead-in rather than demanding gameplay coordinates at
      // portrait time 0.00s. Only accept it when a joint football/player
      // observation follows within 0.9s; an isolated missing opening frame
      // remains a real framing failure.
      const leadingReactionLeadIn = !onlySubject && index === 0
        && !frame.ball
        && (frame.phase === "reaction" || frame.situation === "reaction")
        && observations.slice(1).some(value => value.cut === true && !!value.ball && !!value.player
          && Number(value.time) - Number(frame.time) <= 0.9);
      if (leadingReactionLeadIn) {
        return { ...frame, low: half, high: 1 - half, constrained: false,
          onlySubject, leadingLeadIn: true };
      }
      // A brief occlusion may be bracketed by observations in the SAME source
      // shot. Never extrapolate a missing ball from another camera angle.
      const missingBall = !onlySubject && !frame.ball;
      const missingPlayer = requirePlayer && !actionPlayer;
      const bracketed = bracketedVisibility(observations, index,
        f => (!missingBall || !!f.ball) && (!missingPlayer || !!observedActionPlayer(f))
          && (!onlySubject || !!(keeperReaction?f.goalkeeper:f.faceCore||f.subjectCore||f.player)));
      if (gap > .4 || !bracketed) {
        const missing=[missingBall?'football':null,missingPlayer?(frame.situation==='keeper_touch'?'involved goalkeeper':'involved player'):null,
          onlySubject&&!subjectBox?'reaction subject':null].filter(Boolean).join(' and ');
        throw new Error(`Gemini cannot visually locate the required action at ${frame.time.toFixed(2)}s; missing ${missing} observation; occlusion needs same-shot evidence on both sides.`);
      }
      return { ...frame, low: half, high: 1 - half, constrained: false, onlySubject };
    }
    gap = 0;
    // After a completed consequence, an unrelated teammate's reaction
    // in the same wide shot must not pull the crop across half the pitch. Keep
    // the directly observed keeper involved in that result. A real source cut
    // or an explicitly selected reaction scene can still introduce its actor.
    // On arrival, retain a directly observed nearby keeper as context. A
    // ball-only anchor used to keep the ball visible but crop half the keeper
    // out at the goalmouth. A distant keeper never pulls setup off the taker.
    const keeper=frame.goalkeeper,ball=frame.ball;
    const keeperDistance=keeper&&ball?Math.hypot(
      Math.max(0,keeper.x1-ball.x2,ball.x1-keeper.x2),
      Math.max(0,keeper.y1-ball.y2,ball.y1-keeper.y2)):Infinity;
    const keeperContext=!onlySubject && keeper && ball
      && ['flight','continuation','payoff'].includes(frame.phase)
      // After the ball crosses the line it can travel across the net, away
      // from the keeper. Do not discard the observed keeper at precisely
      // that payoff just because the point-to-body distance increases.
      && (keeperDistance<=.08 || frame.phase==='payoff' && frame.situation==='result'
        && /goal|save|shot|chance/.test(String(scene.eventType||''))
        && (frame.ballInPlay===false || /goal/i.test(String(scene.eventType||''))))
      && Math.max(keeper.x2,ball.x2)-Math.min(keeper.x1,ball.x1)<=width;
    // A visible goalpost at the far side of a tackle or loose-ball clearance
    // is NOT the active subject. It used to force impossible joint crops and
    // sudden keeper-to-ball pans after perfectly readable defensive actions.
    const postDistance=ball&&frame.goalPost?Math.hypot(
      Math.max(0,frame.goalPost.x1-ball.x2,ball.x1-frame.goalPost.x2),
      Math.max(0,frame.goalPost.y1-ball.y2,ball.y1-frame.goalPost.y2)):Infinity;
    const goalBoundary=!onlySubject && ball && frame.goalPost
      && ['flight','payoff'].includes(frame.phase) && (postDistance<=.12
        || frame.phase==='payoff' && frame.situation==='result'
          && /goal|save|shot|chance/.test(String(scene.eventType||''))
          && Math.max(ball.x2,frame.goalPost.x2)-Math.min(ball.x1,frame.goalPost.x1)<=width);
    const required = onlySubject
      ? [subjectBox]
      : [...(frame.ball ? [frame.ball] : []), ...((requirePlayer || goalOcclusion || trajectoryOcclusion || shotEntryOcclusion) ? [actionPlayer] : []),
        ...(trajectoryOcclusion?[{x1:trajectoryOcclusion.left,x2:trajectoryOcclusion.right}]:[]),
        ...(shotEntryOcclusion?[{x1:shotEntryOcclusion.left,x2:shotEntryOcclusion.right}]:[]),
        ...(keeperContext?[keeper]:[]),...(goalBoundary?[frame.goalPost]:[])];
    if (!required.length) throw new Error(`Gemini cannot visually locate the required action at ${frame.time.toFixed(2)}s; no observed crop anchor.`);
    const left = Math.min(...required.map(b => b.x1)), right = Math.max(...required.map(b => b.x2));
    // Prefer a margin, but do not declare visible source-edge subjects
    // impossible merely because there is no extra source outside the frame.
    const safeMargin = Math.max(0, Math.min(margin, (width - (right - left)) / 2, left, 1 - right));
    const low = Math.max(half, right - half + safeMargin);
    const high = Math.min(1 - half, left + half - safeMargin);
    if (low > high + 1e-9) {
      const requirement = onlySubject
        ? (frame.faceCore ? "observed face and upper chest" : frame.subjectCore ? "observed face and torso" : "reaction subject (observe its face-and-upper-chest faceCore, not extended arms or teammates)")
        : "required player and ball";
      throw new Error(`The ${requirement} cannot fit this full-bleed crop at ${frame.time.toFixed(2)}s.`);
    }
    return { ...frame, low, high: Math.max(low, high), constrained: true, onlySubject, subjectBox,
      possessionOcclusion, goalOcclusion,trajectoryOcclusion:!!trajectoryOcclusion,
      shotEntryOcclusion:!!shotEntryOcclusion,keeperContext,keeperReaction,goalBoundary,actionPlayer };
  });
  // Solve each source shot independently. One camera position is preferred
  // whenever the intersection of all visible-subject intervals permits it.
  const shots = [];
  for (const frame of intervals) {
    if (!shots.length || frame.cut) shots.push([]);
    shots.at(-1).push(frame);
  }
  const keyframes = [];
  let maxSpeed = 0;
  let maxAllowedSpeed = .35;
  for (const shot of shots) {
    const low = Math.max(...shot.map(f => f.low)), high = Math.min(...shot.map(f => f.high));
    let path;
    if (low <= high) path = shot.map(() => (low + high) / 2);
    else {
      try { path=boundedGeminiShotPath(shot,.22); }
      catch {
        try { path=boundedGeminiShotPath(shot,.35); }
        catch (error) {
          // During a clearly observed ball flight, a broadcast camera may
          // need one short, smooth handoff faster than the normal .35 crop
          // bound. Permit that handoff only when consecutive flight samples
          // show the ball itself moving quickly in the same shot. This never
          // relaxes a player-only jump, a hidden-ball interval, or a source
          // cut, and the path is still solved/smoothed by the bounded planner.
          let fastestBall = 0, flightPairs = 0;
          for (let index = 1; index < shot.length; index += 1) {
            const before = shot[index - 1], current = shot[index];
            if (before.cut || current.cut || before.phase !== "flight" || current.phase !== "flight"
              || !before.ball || !current.ball) continue;
            const beforeX = (before.ball.x1 + before.ball.x2) / 2;
            const currentX = (current.ball.x1 + current.ball.x2) / 2;
            const dt = Number(current.time) - Number(before.time);
            if (!(dt > 0)) continue;
            fastestBall = Math.max(fastestBall, Math.abs(currentX - beforeX) / dt);
            flightPairs += 1;
          }
          // The ball can be nearly stationary in normalized X while the
          // broadcast still needs a small handoff, so use the presence of at
          // least two consecutive, directly observed flight pairs as the
          // guard. This remains narrower than allowing a player-only jump.
          if (flightPairs < 2) throw error;
          // A single 8fps interval can contain a real broadcast pan of just
          // over 0.9 normalized screen-widths/sec. Keep this exception narrow
          // to directly observed, continuous ball flight; normal possession
          // and player-only jumps remain bounded at .35 and still fail safely.
          maxAllowedSpeed = Math.max(maxAllowedSpeed, 1.5);
          try { path = boundedGeminiShotPath(shot, 1.5); }
          catch (handoffError) {
            // A keeper/goalmouth handoff can require a larger one-frame move
            // at 8fps. It is still allowed only when the same shot contains
            // multiple directly observed flight samples; never use this for
            // an unobserved player jump or a missing-ball interval.
            maxAllowedSpeed = Math.max(maxAllowedSpeed, 3);
            path = boundedGeminiShotPath(shot, 3);
          }
        }
      }
    }
    for (let i = 0; i < shot.length; i++) {
      const f = shot[i], x = path[i];
      if (i) maxSpeed = Math.max(maxSpeed, Math.abs(x - path[i - 1]) / (f.time - shot[i - 1].time));
      const inside = b => !!b && b.x1 >= x - half && b.x2 <= x + half;
      keyframes.push({ time: f.time,phase:f.phase, cameraX: x, cameraY: .5, sceneCut: i === 0 ? 1 : 0,
        cameraCut: i === 0 ? 1 : 0, directBall: !!f.ball, ballInFrame: inside(f.ball),
        playerInFrame: inside(f.keeperReaction?f.subjectBox:f.actionPlayer), subjectCoreInFrame: inside(f.subjectCore), faceCoreInFrame: inside(f.faceCore),
        goalkeeperInFrame:inside(f.goalkeeper),
        goalPostInFrame:inside(f.goalPost),
        jointFit: inside(f.ball) && inside(f.actionPlayer), reactionOnly: f.onlySubject || f.leadingLeadIn === true, situation: f.situation,
        actionPlayerRole:f.situation==='keeper_touch'?'goalkeeper':undefined,
        possessionOcclusion: f.possessionOcclusion === true,
        goalOcclusion: f.goalOcclusion === true,
        trajectoryOcclusion:f.trajectoryOcclusion===true,
        trajectoryOcclusionEvidence:f.trajectoryOcclusionEvidence,
        shotEntryOcclusion:f.shotEntryOcclusion===true,
        shotEntryEvidence:f.shotEntryEvidence,
        reactionSubject:f.keeperReaction?'observed_goalkeeper':undefined,
        ballCenterX: f.ball ? (f.ball.x1 + f.ball.x2) / 2 * media.width : undefined,
        ballCenterY: f.ball ? (f.ball.y1 + f.ball.y2) / 2 * media.height : undefined,
        playerCenterX: f.actionPlayer ? (f.actionPlayer.x1 + f.actionPlayer.x2) / 2 * media.width : undefined,
        playerCenterY: f.actionPlayer ? (f.actionPlayer.y1 + f.actionPlayer.y2) / 2 * media.height : undefined });
    }
  }
  if (maxSpeed > maxAllowedSpeed + 1e-9) throw new Error("Gemini crop path requires an abrupt pan; reobserve this scene.");
  const gameplay = keyframes.filter(f => !f.reactionOnly);
  const directlyVerifiable = gameplay.filter(f => !f.possessionOcclusion && !f.goalOcclusion && !f.trajectoryOcclusion && !f.shotEntryOcclusion);
  const coverage = directlyVerifiable.filter(f => f.directBall && f.ballInFrame).length / Math.max(1, directlyVerifiable.length);
  if (!subjectOnly(scene) && coverage < .9) throw new Error("Gemini crop has insufficient observed ball coverage.");
  const requiredReviewChecks = [...new Set([
    ...intervals.filter(f => !f.onlySubject && f.situation === "receive").map(() => "receiverVisible"),
    ...intervals.filter(f => !f.onlySubject && f.situation === "keeper_touch").map(() => "keeperContactVisible"),
    ...intervals.filter(f => !f.onlySubject && f.situation === "rebound").map(() => "reboundFollowed"),
    ...intervals.filter(f => f.possessionOcclusion).map(() => "possessionOcclusionVerified"),
    ...intervals.filter(f=>f.trajectoryOcclusion).map(()=>"trajectoryOcclusionVerified"),
    ...intervals.filter(f=>f.shotEntryOcclusion).map(()=>"shotEntryOcclusionVerified"),
    ...intervals.filter(f=>f.keeperContext).map(()=>"keeperContextVisible"),
    ...(!subjectOnly(scene) && scene.eventType === "save" ? ["keeperContactVisible"] : []),
  ])];
  return { keyframes, maxSpeed, ballCoverage: coverage,
    observedBallCoverage: gameplay.filter(f => f.directBall && f.ballInFrame).length / Math.max(1, gameplay.length),
    geometryVerified: true, requiredReviewChecks };
}

export function reviewedFramingEvent(scene,evidence) {
  const review=evidence?.renderReview, outcome=review?.observedOutcome;
  if(!outcome || ['passed','correctSubject','stableCamera','ballFollowed','setupVisible','contactVisible','outcomeVisible']
    .some(key=>review[key]!==true) || review.issues?.length
    || !Number.isFinite(outcome.time) || outcome.time<0 || outcome.time>scene.endTime-scene.startTime
    || typeof outcome.description!=='string' || outcome.description.trim().length<12) return null;
  if (outcome.type==='not_applicable' && review.ballEnteredGoal===false
    && ['save','shot_on_target','shot_off_target','big_chance'].includes(scene.eventType)
    && ['contact','payoff'].every(phase=>(review.phaseChecks||[]).some(check=>check.phase===phase
      && check.ballVisible===true && check.playerVisible===true
      && Number.isFinite(check.time) && check.time>=0 && check.time<=scene.endTime-scene.startTime)))
    return 'normal_play';
  // Never convert an awarded goal into a different event to satisfy framing.
  if(['goal','disallowed_goal'].includes(scene.eventType)) {
    if (outcome.type === 'goal' && review.ballEnteredGoal === true) return scene.eventType;
    // A single portrait reviewer can mistake a ball rebounding inside the net
    // for a save. A locked source goal needs an independent same-action source
    // verdict before it may be reclassified from the crop's different result.
    const comparison=evidence?.outcomeComparison,source=comparison?.sourceOutcome;
    const sourceAgrees=comparison?.version===1 && comparison.sameActionVerified===true
      && comparison.sourceSceneStartTime===scene.startTime
      && comparison.sourceSceneEndTime===scene.endTime
      && source?.observedOutcome===outcome.type
      && source.goalLineCrossingVerified===false;
    return sourceAgrees
      ? ({keeper_save:review.keeperContactVisible===true?'save':null,
        woodwork:'big_chance',blocked:'big_chance',wide:'shot_off_target',over:'shot_off_target'}[outcome.type] || null)
      : null;
  }
  // The source's INITIAL whole-video observation and the actual crop must
  // independently agree. This upgrades a coarse "shot" classification
  // without another source check, scene replacement or fabricated goal.
  if(['save','shot_on_target','shot_off_target','big_chance'].includes(scene.eventType)
    && outcome.type==='goal' && review.ballEnteredGoal===true && review.goalVisible===true
    && ([...(evidence.initialFocusNotes||[]),...(verifiedPairedGoalOutcome(scene,evidence)?[evidence.outcomeComparison.sourceOutcome]:[])])
      .some(note=>note.observedOutcome==='goal'&&note.goalLineCrossingVerified===true
      && Number.isFinite(note.goalLineCrossingTime)&&note.goalLineCrossingTime>=0
      && note.goalLineCrossingTime<=scene.endTime-scene.startTime
      && typeof note.crossingEvidence==='string'&&note.crossingEvidence.trim().length>=20)) return 'goal';
  if(!['save','shot_on_target','shot_off_target','big_chance'].includes(scene.eventType)
    || review.ballEnteredGoal!==false) return null;
  return {keeper_save:'save',woodwork:'big_chance',blocked:'big_chance',wide:'shot_off_target',over:'shot_off_target'}[outcome.type]||null;
}

export function verifiedPairedGoalOutcome(scene,evidence) {
  const comparison=evidence?.outcomeComparison,source=comparison?.sourceOutcome,
    crop=evidence?.renderReview?.observedOutcome,duration=scene.endTime-scene.startTime;
  return comparison?.version===1 && comparison.sameActionVerified===true
    && comparison.sourceSceneStartTime===scene.startTime && comparison.sourceSceneEndTime===scene.endTime
    && source?.observedOutcome==='goal' && source.goalLineCrossingVerified===true
    && Number.isFinite(source.goalLineCrossingTime) && source.goalLineCrossingTime>=0 && source.goalLineCrossingTime<=duration
    && typeof source.crossingEvidence==='string' && source.crossingEvidence.trim().length>=20
    && crop?.type==='goal' && (evidence.renderReview.goalVisible===true
      || evidence.provider==='hybrid-football' && evidence.renderReview.outcomeVisible===true)
    && evidence.renderReview.ballEnteredGoal===true
    && Number.isFinite(crop.time) && Math.abs(crop.time-source.goalLineCrossingTime)<=.5;
}

export function framingOutcomeComparisonSchema() {
  return {type:'OBJECT',required:['sameActionVerified','sourceOutcome','cropReview'],properties:{
    sameActionVerified:{type:'BOOLEAN'},
    sourceOutcome:{type:'OBJECT',required:['observedOutcome','goalLineCrossingVerified','goalLineCrossingTime','crossingEvidence'],properties:{
      observedOutcome:{type:'STRING',enum:['goal','keeper_save','woodwork','blocked','wide','over','uncertain','not_applicable']},
      goalLineCrossingVerified:{type:'BOOLEAN'},goalLineCrossingTime:{type:'NUMBER',nullable:true},crossingEvidence:{type:'STRING'}}},
    cropReview:framingReviewResponseSchema()}};
}

export async function compareFramingOutcome({scene,camera,evidence,cropped,contextPath,directory,signature,model,generate,report}) {
  // Only a concrete sporting-result disagreement gets this single paired
  // check. No coordinates, scene discovery, retries of a failed camera, or
  // unconditional approval are introduced. An unchanged saved comparison is
  // reused even when rejected, so Resume cannot repeat paid semantic work.
  const prompt=`Two synchronized videos show the SAME selected action, with burned-in SCENE seconds clocks. The FIRST is the actual portrait crop; the SECOND is its full-width original source. Independently observe both complete videos through the END. Determine each actual shot and consequence, including live rebounds and follow-up shots. Do not use the scoreboard, celebrations, jersey names or a keeper diving as goal/save proof. We have conflicting earlier outcome hypotheses; no expected result is supplied.
Return sameActionVerified only if both videos show the same continuous action at matching scene-clock times. sourceOutcome must describe the LAST resolved attacking action in the SECOND video. goalLineCrossingVerified requires the real moving ball crossing inside the posts, with that exact source-clock time and visible crossingEvidence; otherwise false and null. A save needs actual keeper contact or controlled collection; woodwork may be followed by another attempt. cropReview is an independent verdict on FIRST-video pixels only. Full-width-only action cannot pass the portrait crop. Source-only goal proof cannot make crop goalVisible or ballEnteredGoal true. If both show a goal, their crossing times must agree within 0.5 seconds. If evidence is uncertain, report uncertain; never change false flags merely to resolve a conflict.
${independentCropReviewPrompt(scene,camera,true)}`;
  const config={...framingReviewGenerationConfig(),responseSchema:framingOutcomeComparisonSchema()};
  const [cropBytes,sourceBytes]=await Promise.all([readFile(cropped),readFile(contextPath)]);
  const key=createHash('sha256').update(cropBytes).update(sourceBytes)
    .update(JSON.stringify({prompt,config,scene:framingObservationContext(scene)})).digest('hex').slice(0,20);
  const path=join(directory,`${signature}.outcome-comparison-v1-${key}.json`);
  let saved;
  try {saved=JSON.parse(await readFile(path,'utf8'));} catch {}
  if(!saved) {
    await report(`Gemini vision: resolving source/crop sporting-result disagreement for ${scene.id}; camera and scene stay unchanged.`);
    saved=await generate({model,contents:[footballVideoPart(cropBytes.toString('base64'),8),
      footballVideoPart(sourceBytes.toString('base64'),8),{text:prompt}],config},`source/crop outcome comparison ${scene.id}`);
    await writeFile(`${path}.tmp`,JSON.stringify(saved));await rename(`${path}.tmp`,path);
  }
  if(typeof saved?.sameActionVerified!=='boolean' || !saved.sourceOutcome || !saved.cropReview)
    throw new Error('Source/crop outcome comparison is incomplete; saved original verdicts remain unchanged.');
  const review=normalizeFramingReview(saved.cropReview);
  const comparison={version:1,sameActionVerified:saved.sameActionVerified,
    sourceSceneStartTime:scene.startTime,sourceSceneEndTime:scene.endTime,
    sourceOutcome:saved.sourceOutcome,generationProvenance:saved.generationProvenance};
  // Never replace the crop with a second verdict on a different source action.
  if(comparison.sameActionVerified!==true) throw new Error('Source/crop outcome comparison did not verify the same action.');
  if(comparison.sourceOutcome.observedOutcome!==review.observedOutcome?.type)
    throw new Error('Source/crop sporting outcomes remain contradictory after the saved comparison.');
  if(saved.generationProvenance && !review.generationProvenance)
    review.generationProvenance=saved.generationProvenance;
  return {...evidence,renderReview:review,outcomeComparison:comparison,finalCropVerified:review.passed===true};
}

export function cropOutcomeComparisonNeeded(scene,review,observations=[]) {
  if(subjectOnly(scene)||!['goal','disallowed_goal','save','shot_on_target','shot_off_target','big_chance'].includes(scene.eventType)
    || !['correctSubject','stableCamera','ballFollowed','setupVisible','contactVisible'].every(key=>review?.[key]===true)
    || !review?.observedOutcome) return false;
  if(!reviewedFramingEvent(scene,{renderReview:review})) return true;
  // A reviewer can invent a save merely because a keeper is in the picture.
  // Geometry is only a disagreement signal, never an outcome verdict. Ask the
  // independent source/crop observer rather than accepting or rejecting it.
  const type=review.observedOutcome.type;
  if(type==='keeper_save' && observations.length) {
    const keeperContact=observations.some(frame=>Math.abs(frame.time-review.observedOutcome.time)<=.5
      && frame.ball && frame.goalkeeper
      && frame.ball.x1<=frame.goalkeeper.x2+.02 && frame.ball.x2>=frame.goalkeeper.x1-.02
      && frame.ball.y1<=frame.goalkeeper.y2+.02 && frame.ball.y2>=frame.goalkeeper.y1-.02);
    if(!keeperContact) return true;
  }
  return ['woodwork','blocked','wide','over'].includes(type)
    && observations.some(frame=>frame.situation==='keeper_touch' && frame.actionResolved===true);
}

// Spatial review is not player/team research. Its free-form observations may
// contain guessed identities even when the crop itself is good. Use only its
// checked outcome type to correct narration, never promote those names.
export function reviewedFramingNarration(scene,evidence) {
  const event=reviewedFramingEvent(scene,evidence);
  if(!event) return null;
  const description={goal:'The moving ball crosses the goal line inside the goal.',
    keeper_save:'The goalkeeper visibly stops or deflects the shot.',
    woodwork:'The ball strikes the goal frame and stays out.',
    blocked:'The attempt is blocked and the ball stays out.',
    not_applicable:'The visible open-play move resolves without a shot.',
    wide:'The shot passes outside the goalpost.',over:'The shot goes over the crossbar.'}[evidence.renderReview.observedOutcome.type];
  if(!description) return null;
  const setupFacts=(scene.semanticNarrationFacts||[]).filter(fact=>
    !/\b(goal|scores?|scored|saves?|saved|blocks?|blocked|net|crossbar|post|wide|over|stops?|deflects?)\b/i.test(fact));
  return {description,facts:[...setupFacts,description]};
}

export function effectiveFramingReviewChecks(scene,evidence) {
  const review=evidence?.renderReview;
  const observedEvent=reviewedFramingEvent(scene,evidence);
  return (evidence?.requiredReviewChecks||[]).filter(check=>!(check==='keeperContactVisible'
    && observedEvent && ['goal','woodwork','blocked','wide','over'].includes(review.observedOutcome.type))
    && !(check==='reboundFollowed' && observedEvent==='goal' && review.ballEnteredGoal===true)
    // A source label may call an attempt a save while the independent crop
    // proves it went wide/over. In that observed outcome there is no live
    // rebound to verify; do not reject a complete crop for a stale semantic
    // expectation from Step 1.
    && !(check==='reboundFollowed' && observedEvent && ['shot_off_target','big_chance'].includes(observedEvent)));
}

export function assessGeminiFraming(scene, evidence) {
  if (evidence?.provider !== "gemini-vision") return null;
  const review = evidence.renderReview;
  const goal = ["goal", "disallowed_goal"].includes(scene.eventType);
  const observedEvent=reviewedFramingEvent(scene,evidence);
  // Keep the original goal gate when no independent outcome exists. Only a
  // concrete, reviewed miss/woodwork/blocked outcome can downgrade a stale
  // Step-1 goal label.
  const goalConfirmed=goal && (!observedEvent || observedEvent===scene.eventType);
  const hasObservedOutcome=Boolean(review?.observedOutcome);
  const finishingEvent=['goal','disallowed_goal','save','shot_on_target','shot_off_target','big_chance'].includes(scene.eventType);
  const requiredChecks=effectiveFramingReviewChecks(scene,evidence);
  const usable = evidence.geminiFramingVersion === GEMINI_FRAMING_VERSION
    && (evidence.samplingClockVersion==null || evidence.samplingClockVersion===GEMINI_SAMPLE_CLOCK_VERSION)
    && evidence.outcomeConsistencyVersion === 1
    && evidence.geometryVerified === true && scene.semanticVerified === true
    && scene.actionComplete !== false && review?.passed === true
    && review.correctSubject === true && review.stableCamera === true
    && (!subjectOnly(scene) || review.subjectCoreVisible === true)
    && (subjectOnly(scene) || (review.ballFollowed === true && review.setupVisible === true
      && review.contactVisible === true && review.outcomeVisible === true))
    && (!goalConfirmed || (review.goalVisible === true && review.ballEnteredGoal === true))
    && (!finishingEvent || !hasObservedOutcome || Boolean(observedEvent))
    && (observedEvent!=='save' || review.keeperContactVisible===true)
    && Array.isArray(evidence.requiredReviewChecks)
    && requiredChecks.every(check => ["receiverVisible", "keeperContactVisible", "keeperContextVisible", "reboundFollowed", "possessionOcclusionVerified", "trajectoryOcclusionVerified", "shotEntryOcclusionVerified"].includes(check) && review[check] === true)
    && Array.isArray(review.issues) && review.issues.length === 0;
  return { usable, mode: usable ? "gemini_crop_verified" : "gemini_crop_review_incomplete" };
}

export async function trackSceneWithGemini({ sourcePath, sourceFingerprint, scene, media, ratio,
  directory, ffmpeg, run, generate, model, repairRound = 0, report = async () => {}, filterFileArgs=filterGraphFileArgs }) {
  await mkdir(directory, { recursive: true });
  const signature = createHash("sha256").update(JSON.stringify({ sourceFingerprint,
    scene: { id: scene.id, startTime: scene.startTime, endTime: scene.endTime,
      eventType: scene.eventType, storyPhase: scene.storyPhase, trackingBrief: scene.trackingBrief,
      semanticVerificationVersion: scene.semanticVerificationVersion },
    ratio, model, version: GEMINI_FRAMING_VERSION, videoObservationVersion:VIDEO_FRAMING_VERSION,
    disciplinaryGrammarVersion:isDisciplinaryAction(scene)?1:undefined })).digest("hex");
  const cachePath = join(directory, `${signature}.json`);
  const diagnosticPath = join(directory, `${signature}.diagnostic.json`);
  try {
    const saved = JSON.parse(await readFile(cachePath, "utf8"));
    if (saved.samplingClockVersion===GEMINI_SAMPLE_CLOCK_VERSION && assessGeminiFraming(scene, saved)?.usable) return saved;
  } catch { /* No verified cache exists. */ }
  const duration = scene.endTime - scene.startTime;
  // Decoded JPEGs/previews are disposable, unlike the verified JSON cache.
  // The checkpoint store excludes *.tmp directories; do not upload hundreds
  // of generated images again whenever a cloud worker saves progress.
  const scratchDir = join(directory, `${signature}.tmp`);
  await mkdir(scratchDir, { recursive: true });
  const contextPath = join(scratchDir, "source.mp4");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...framingVideoInputArgs(sourcePath,scene.startTime,duration), "-vf", `${framingSourceFilter(VIDEO_FRAMING_FPS,1)},${framingVideoClockFilter()}`, "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", contextPath]);
  // One initial video plan, not three geometry passes or a nested repair
  // ladder. Already verified cameras still return above. Unverified legacy
  // repair rows cannot be stitched into this new first-observation contract.
  const attempt=0;
  {
    const fps = VIDEO_FRAMING_FPS;
    const attemptDir = join(scratchDir, `attempt-${attempt}`);
    await mkdir(attemptDir, { recursive: true });
    const observationOptions={contextPath,duration,fps,scene,signature:`${signature}.initial-v4`,directory,scratchDir,
      maximumSamples:DETAIL_VIDEO_FRAMING_MAX_SAMPLES,detailWindows:true,
      ffmpeg,run,model,generate,report,schema:focusedFramingResponseSchema(),
      contract:`${isDisciplinaryAction(scene)?DISCIPLINARY_ACTION_CONTRACT:''} ${completeActionContract}`,
      validateObservations:validateGeminiBatch};
    const all=await observeFramingVideo(observationOptions).catch(error=>{
        if(/^Video framing still needs|^(Invalid|Incomplete) source action timeline|^Source action timeline omitted/.test(error.message))
          throw new FramingVerificationError(scene.id,error.message);
        throw error;
    });
    const sourceTimeline=all.sourceActionTimeline;
    const count=all.length;
    let finalObservations;
    try {
      const observations = normalizeGeminiObservations({ frames: all }, count, fps);
      finalObservations=observations;
      await writeFile(diagnosticPath, JSON.stringify({ sceneId: scene.id, eventType: scene.eventType,
        version: GEMINI_FRAMING_VERSION, cameraPolicyVersion:GEMINI_CAMERA_POLICY_VERSION,
        cropReviewPolicyVersion:GEMINI_CROP_REVIEW_POLICY_VERSION,attempt, fps, observations }));
      const observedScene=scene,observedFrames=observations;
      const camera = planGeminiCamera(observedScene, observedFrames, media, ratio);
      const x = trackedPositionExpression(camera.keyframes, "cameraX", .5);
      const sourceRatio = media.width / media.height;
      const crop = sourceRatio >= ratio
        ? `crop=ih*${ratio}:ih:x='max(0,min(iw-ow,iw*(${x})-ow/2))':y=0`
        : `crop=iw:iw/${ratio}:x=0:y='(ih-oh)/2'`;
      const graph = join(attemptDir, "review-filter.txt"), cropped = join(attemptDir, "cropped.mp4");
      // Native-detail VIDEO is used on every crop review and repair attempt.
      // Review-only clock: the final render remains clean. Source windows
      // already have this clock; without it crop reviewers guessed an early
      // post rebound was the later goal and missed the follow-up contact.
      await writeFile(graph, `[0:v]setpts=PTS-STARTPTS,${crop},scale=-2:1080,fps=8:start_time=0:round=up,${framingVideoClockFilter()}[v]`);
      await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...framingVideoInputArgs(sourcePath,observedScene.startTime,observedScene.endTime-observedScene.startTime), ...await filterFileArgs(ffmpeg, graph), "-map", "[v]",
        "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", cropped]);
      await report(`Gemini vision: reviewing the actual ${scene.id} portrait crop.`);
      const reviewPrompt=independentCropReviewPrompt(observedScene,camera);
      const reviewSignature=createHash('sha256').update(await readFile(cropped))
        .update(JSON.stringify({camera,scene:framingObservationContext(observedScene),reviewPrompt,
          config:framingReviewGenerationConfig()})).digest('hex').slice(0,20);
      const reviewPath=join(directory,`${signature}.crop-review-video-v${GEMINI_CROP_REVIEW_POLICY_VERSION}-${reviewSignature}.json`);
      let review;
      try { review=normalizeFramingReview(JSON.parse(await readFile(reviewPath,'utf8'))); } catch {}
      if(!review) {
      review = normalizeFramingReview(await generate({ model, contents: [
        footballVideoPart((await readFile(cropped)).toString("base64"), 8),
        {text:reviewPrompt}],
        config:framingReviewGenerationConfig() }, `cropped scene review ${scene.id}`));
      await writeFile(`${reviewPath}.tmp`,JSON.stringify(review));
      await rename(`${reviewPath}.tmp`,reviewPath);
      }
      // A saved Step-1 interval may retain one reaction/pre-cut frame before
      // the real gameplay source cut. If the crop reviewer reports only that
      // harmless lead-in while every football-phase check is positive, treat
      // it as accepted lead-in—not as a framing failure. Never clear issues
      // about the active player, ball, camera stability or payoff.
      const leadInKeyframe = camera.keyframes?.[0]?.reactionOnly === true
        && Number(camera.keyframes?.[1]?.cameraCut) === 1;
      const leadInOnlyIssue = leadInKeyframe && Array.isArray(review.issues)
        && review.issues.length > 0
        && review.issues.every(issue => /(?:coach|reaction|pre[- ]?cut|lead[- ]?in|unrelated|falling).*(?:before|prior|cut|00:?00)|(?:before|prior|cut|00:?00).*(?:coach|reaction|pre[- ]?cut|lead[- ]?in|unrelated|falling)/i.test(String(issue)))
        && ["correctSubject", "stableCamera", "ballFollowed", "setupVisible", "contactVisible", "outcomeVisible"]
          .every(flag => review[flag] === true);
      if (leadInOnlyIssue) review = { ...review, passed: true, issues: [] };
      await writeFile(join(attemptDir, "render-review.json"), JSON.stringify(review));
      // Normal scenes need only their initial observations and actual crop
      // review. A contradictory sporting result gets one cached comparison,
      // not a camera-repair ladder or a return to scene discovery.
      let evidence = { provider: "gemini-vision", geminiFramingVersion: GEMINI_FRAMING_VERSION,
        cameraPolicyVersion:GEMINI_CAMERA_POLICY_VERSION,
        cropReviewPolicyVersion:GEMINI_CROP_REVIEW_POLICY_VERSION,
        observationMode:'video_first',videoObservationVersion:VIDEO_FRAMING_VERSION,
        outcomeConsistencyVersion:1,
        samplingClockVersion:GEMINI_SAMPLE_CLOCK_VERSION,
        sourceStartTime: observedScene.startTime, sourceEndTime: observedScene.endTime, ...camera,
        initialFocusNotes:all.initialFocusNotes||[],
        sourceActionTimeline:sourceTimeline,
        sampledFrames: observedFrames.length, sourceRecords: [], annotation: [], zoom: 1,
        ballDetectionCoverage: camera.ballCoverage, finalBallCoverage: camera.ballCoverage,
        renderReview: review, layoutMode: "action", finalCropVerified: review.passed === true };
      if(reviewedFramingEvent(observedScene,evidence)===null
        && cropOutcomeComparisonNeeded(observedScene,review,observedFrames)) {
        evidence=await compareFramingOutcome({scene:observedScene,camera,evidence,cropped,contextPath,directory,signature,model,generate,report});
        review=evidence.renderReview;
      }
      if (!framingReviewHasEvidence(review,observedScene.endTime-observedScene.startTime,subjectOnly(scene))
        || !assessGeminiFraming(observedScene, evidence)?.usable) throw new Error(framingReviewFailure(review,effectiveFramingReviewChecks(observedScene,evidence),
          observedScene.endTime-observedScene.startTime,subjectOnly(scene),observedScene,evidence));
      await writeFile(cachePath, JSON.stringify(evidence));
      return evidence;
    } catch (error) {
      // Service/capacity problems say nothing about the observed geometry.
      // Preserve the same request/checkpoint for the caller's service retry;
      // never spend another coordinate-repair round on Google's HTTP failure.
      if(geminiServiceFailure(error)||/429|RESOURCE_EXHAUSTED/.test(String(error.message))) throw error;
      // A missing local artifact or encoder failure is not rejected geometry
      // and must not burn another Gemini coordinate-repair attempt.
      if(['ENOENT','EACCES','EPERM','ENOSPC'].includes(error.code)||/^ffmpeg exited/i.test(String(error.message))) throw error;
      // Keep small coordinate/error evidence in cloud checkpoints. JPEGs are
      // disposable, but losing the cause made repeated retries undiagnosable.
      await writeFile(diagnosticPath, JSON.stringify({ sceneId: scene.id, eventType: scene.eventType,
        version: GEMINI_FRAMING_VERSION, cameraPolicyVersion:GEMINI_CAMERA_POLICY_VERSION,
        cropReviewPolicyVersion:GEMINI_CROP_REVIEW_POLICY_VERSION,
        attempt, fps, rawFrames: all, observations:finalObservations, error: String(error.message) }));
      throw new FramingVerificationError(scene.id,`Initial video plan is incomplete: ${String(error.message).slice(0,1500)}. No automatic framing repair or scene rediscovery was started.`);
    }
  }
}
