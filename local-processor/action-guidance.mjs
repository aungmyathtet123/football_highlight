// Semantic anchors disambiguate dense detector observations. They are NOT
// per-frame camera commands, interpolated ball locations or crop approval.
import {footballVideoPart} from './gemini-media-policy.mjs';
import {createHash} from 'node:crypto';
export const ACTION_GUIDANCE_VERSION=1;
export function actionGuideOutcomeContradiction(scene) {
  const guide=scene?.actionGuidance?.guide||scene?.trackingBrief?.actionGuide;
  if(scene?.eventType!=='save'||guide?.outcome!=='save') return null;
  const payoff=guide.anchors?.find(anchor=>anchor.phase==='payoff');
  const contact=guide.anchors?.filter(anchor=>anchor.phase==='contact'
    && (!payoff||anchor.time<payoff.time)).at(-1);
  if(contact&&/\b(?:pass(?:es|ed)?|cross(?:es|ed)?|through.ball)\b/i.test(contact.description)
    && !/\b(?:shoots?|shot|strik(?:e|es|ing)|header|heads?|volley)\b/i.test(contact.description))
    return 'source_pass_mislabeled_as_save';
  return null;
}
// The observation prompt contains video + duration, not a scene ID. Identical
// source bytes/interval/model can share that observation, but each selected
// scene still receives its own exact-ID provenance and framing verification.
export function actionGuideObservationKey(scene,fingerprint,model) {
  if(!fingerprint||!model||!(scene.endTime>scene.startTime)) throw new Error('Action observation requires an exact source interval.');
  return createHash('sha256').update(JSON.stringify([ACTION_GUIDANCE_VERSION,fingerprint,model,
    scene.startTime,scene.endTime,'8fps-HIGH'])).digest('hex');
}
export function matchingActionGuideObservation(scene,saved,fingerprint,model) {
  if(saved?.version!==ACTION_GUIDANCE_VERSION||saved.key!==actionGuideObservationKey(scene,fingerprint,model)) return null;
  try { return validateActionGuidance(saved.guide,scene.endTime-scene.startTime); } catch { return null; }
}
export async function sharedActionGuideObservation(key,{pending,load,observe,save}) {
  if(pending.has(key)) return structuredClone(await pending.get(key));
  const work=(async()=>{
    const cached=await load();
    if(cached) return cached;
    const guide=await observe();
    await save(guide);
    return guide;
  })();
  pending.set(key,work);
  try { return structuredClone(await work); } finally { pending.delete(key); }
}
export function actionGuidanceKey(scene,fingerprint,model) {
  if(!fingerprint||!model||!(scene.endTime>scene.startTime)) throw new Error('Action guidance requires an exact source interval.');
  return createHash('sha256').update(JSON.stringify([ACTION_GUIDANCE_VERSION,fingerprint,model,
    scene.id,scene.startTime,scene.endTime])).digest('hex');
}
export function matchingActionGuidance(scene,saved,fingerprint,model) {
  if(saved?.version!==ACTION_GUIDANCE_VERSION||saved.sourceStartTime!==scene.startTime
    ||saved.sourceEndTime!==scene.endTime||saved.key!==actionGuidanceKey(scene,fingerprint,model)) return null;
  try {return validateActionGuidance(saved.guide,scene.endTime-scene.startTime);} catch {return null;}
}
export function applySavedActionGuidance(scene) {
  const saved=scene.actionGuidance;
  if(!saved?.sourceFingerprint||!saved?.model) return scene;
  const guide=matchingActionGuidance(scene,saved,saved.sourceFingerprint,saved.model);
  return guide?guidedDetectorScene(scene,guide):scene;
}
const box={type:['array','null'],minItems:4,maxItems:4,
  items:{type:'number',minimum:0,maximum:1000}};
export const ACTION_GUIDANCE_SCHEMA={type:'object',required:['sourceType','outcome','uncertainties','anchors'],properties:{
  sourceType:{type:'string',enum:['broadcast','simulation','uncertain']},
  outcome:{type:'string',enum:['goal','save','wide','over','blocked','woodwork','pass','dribble','tackle','uncertain','reaction']},
  uncertainties:{type:'array',items:{type:'string'}},
  anchors:{type:'array',items:{type:'object',required:['time','phase','ball','player','goalmouth','description'],properties:{
    time:{type:'number'},phase:{type:'string',enum:['setup','contact','flight','payoff','reaction']},
    ball:box,player:box,goalmouth:box,description:{type:'string'}}}}}};
export function actionGuidanceRequest(model,data,duration) {
  return {model,contents:[footballVideoPart(data,8),{text:
    `Watch this complete ORIGINAL ${duration.toFixed(3)}-second scene. Identify the REAL moving match ball and relevant initiating/receiving player, not white boots, spare balls, logos or unrelated people. Return at most SIX directly observed semantic anchors: starting control, each important passing/shooting contact, decisive flight, and visible finish. Use exact VIDEO-local SECONDS: 2.500 means two and a half seconds, while 0.025 means only twenty-five milliseconds, NOT 2.5 seconds. This video supplies eight frames per second (0.125 seconds between observations); do not invent a sequence of different observed frames inside 0.125 seconds. Describe the sporting outcome honestly; do not infer a goal from the scoreboard or celebration. Mark simulation footage as simulation. No player/team names or assumed result are supplied.
For each anchor return time, phase, ball (small ball box), player (ONE involved full-body box), goalmouth (visible opening between the posts, not crowd or the entire penalty area), and a short description. Each box has EXACTLY four numeric edges [ymin,xmin,ymax,xmax] normalized 0..1000 in the FULL ORIGINAL frame, with ymin < ymax and xmin < xmax. Use null if hidden/uncertain; never use an empty array, a point, zero-area rectangle or raw pixel coordinates. These are a few semantic anchors for a separate dense tracker, NOT a camera path. Do not emit intermediate frame rows or guessed/interpolated positions. A goal needs visible crossing inside the posts. A pass resolves when the receiver controls the ball; a dribble resolves when the player visibly beats the opponent and retains the ball; a tackle resolves with the observed ball won or knocked away. Record that observed resolution as a payoff, not an invented shot. If the scene ends before its real outcome or only shows celebration without the finish, outcome must remain uncertain. Return the schema JSON only.`}],
    config:{responseMimeType:'application/json',responseJsonSchema:ACTION_GUIDANCE_SCHEMA,
      temperature:0,maxOutputTokens:8192,thinkingConfig:{thinkingLevel:'LOW'}}};
}
export function validateActionGuidance(value,duration) {
  if(!value||!['broadcast','simulation','uncertain'].includes(value.sourceType)
    ||!['goal','save','wide','over','blocked','woodwork','pass','dribble','tackle','uncertain','reaction'].includes(value.outcome)
    ||!Array.isArray(value.uncertainties)||!value.uncertainties.every(v=>typeof v==='string')
    ||!Array.isArray(value.anchors)||!value.anchors.length||value.anchors.length>6)
    throw new Error('Invalid semantic action guide');
  let previous=-1;
  for(const [index,anchor] of value.anchors.entries()) {
    if(!Number.isFinite(anchor.time)||anchor.time<0||anchor.time>duration||anchor.time<previous
      ||!['setup','contact','flight','payoff','reaction'].includes(anchor.phase)
      ||typeof anchor.description!=='string'||anchor.description.trim().length<8)
      throw new Error('Invalid semantic anchor clock or phase');
    previous=anchor.time;
    for(const field of ['ball','player','goalmouth']) {
      const b=anchor[field];
      if(b!==null&&(!Array.isArray(b)||b.length!==4||!b.every(v=>Number.isFinite(v)&&v>=0&&v<=1000)
        ||b[0]>=b[2]||b[1]>=b[3])) {
        const error=new Error(`Invalid semantic ${field} box at anchor ${index+1} (${anchor.time}s): ${JSON.stringify(b) ?? 'missing'}`);
        error.code='ACTION_GUIDE_GEOMETRY';
        error.anchorIndex=index;error.field=field;error.box=b;
        throw error;
      }
    }
  }
  const action=value.anchors.filter(a=>a.phase!=='reaction'&&a.ball);
  if(duration>=2&&action.length>=3&&action.at(-1).time-action[0].time<.125
    &&action.some(a=>Math.abs((a.ball[1]+a.ball[3])-(action[0].ball[1]+action[0].ball[3]))/2000>.1))
    throw new Error('Semantic guide clock collapses a moving action into less than one observed video frame; return actual video-local seconds.');
  return value;
}

// Validate at the request boundary: schema-valid JSON can still contain a
// zero-area/reversed box. Correct that response against the same source clip,
// keeping valid sibling observations and required contact/payoff evidence.
// Archive before validation so a restart can reuse the response and the
// precise failed value is available for diagnosis.
export async function observeValidatedActionGuidance({request,duration,label,generate,
  loadResponse=async()=>null,saveResponse=async()=>{},report=async()=>{},maximumAttempts=3}) {
  let previous=null,problem='';
  for(let attempt=1;attempt<=maximumAttempts;attempt++) {
    let raw=await loadResponse(attempt);
    if(raw===null) {
      const current=structuredClone(request);
      if(previous!==null) {
        current.contents.push({text:`The previous response failed validation: ${problem}. Watch this SAME supplied video to correct its response. Preserve valid anchors, source clocks and directly observed outcome. Reobserve invalid boxes; use exactly [ymin,xmin,ymax,xmax] normalized 0..1000 with positive width and height, or null when actually hidden. Do not invent coordinates, remove the observed action, change scene boundaries or return only a patch. Return the complete guide in the schema. Previous response: ${JSON.stringify(previous)}`});
        await report(`Correcting coordinate response for ${label} (${attempt-1}/${maximumAttempts-1}); saved source scenes and completed observations are retained.`);
      }
      raw=await generate(current,attempt);
      await saveResponse(attempt,raw);
    }
    try {return validateActionGuidance(raw,duration);} catch(error) {
      if(error?.code!=='ACTION_GUIDE_GEOMETRY') throw error;
      previous=raw;problem=error.message;
      if(attempt===maximumAttempts) {
        error.message=`${label}: ${problem}. The raw responses are saved; only this clip needs corrected coordinates.`;
        throw error;
      }
    }
  }
}

export function guidedDetectorScene(scene,value) {
  const guide=validateActionGuidance(value,scene.endTime-scene.startTime);
  const observed=guide.anchors.filter(a=>a.ball!==null);
  const contacts=observed.filter(a=>a.phase==='contact');
  const finish=guide.anchors.find(a=>a.phase==='payoff'&&a.goalmouth!==null);
  const start=observed[0],lastContact=contacts.at(-1);
  const brief={...(scene.trackingBrief||{}),actionGuide:guide};
  // Region hypotheses steer association/search, never become directBall rows.
  // A later scorer is not an opening ball-location prior. Sparse guides can
  // start several seconds into a clip; do not steer its buildup toward them.
  if(start&&start.time<=.8) brief.initialBallFocusX=(start.ball[1]+start.ball[3])/2000;
  else delete brief.initialBallFocusX;
  if(contacts.length) {
    brief.contactTime=scene.startTime+lastContact.time;
    // A header can begin with an incoming airborne cross BEFORE the final
    // contact. Rejecting non-grass detections until that header loses the ball.
    const incoming=observed.find(a=>a.phase==='flight');
    brief.flightStartTime=scene.startTime+Math.min(contacts[0].time,incoming?.time??contacts[0].time);
  }
  // A save or miss needs the same observed destination as a goal. Keeping a
  // stale broad-analysis goalFocusX made the dense tracker follow boots in
  // the opposite direction after a shot. This region is a search prior only.
  if(['goal','save','wide','over','blocked','woodwork'].includes(guide.outcome)&&finish&&lastContact) {
    // For non-goals the ball can rebound away from, or miss, the opening.
    // Use the observed result's search neighbourhood, not a stale goal box
    // copied from an earlier camera position. This never sets camera pixels.
    const goal=scene.eventType==='goal'&&guide.outcome==='goal'?finish.goalmouth:finish.ball||finish.goalmouth;
    brief.goalFocusX=(goal[1]+goal[3])/2000;
    const releaseX=(lastContact.ball[1]+lastContact.ball[3])/2000;
    brief.attackDirection=brief.goalFocusX>releaseX?'right':'left';
    brief.payoffStartTime=scene.startTime+finish.time;
    brief.payoffEndTime=scene.endTime;
    const destination={eventType:scene.eventType,startTime:brief.payoffStartTime,
      endTime:scene.endTime,targetBox:[goal[1]/1000,goal[0]/1000,goal[3]/1000,goal[2]/1000],
      provider:'semantic_region_guide_not_crop_approval'};
    if(scene.eventType==='goal'&&guide.outcome==='goal') brief.payoffEvidence={...destination,verified:true};
    else brief.shotDestination=destination; // A miss can land OUTSIDE this opening.
  }
  return {...scene,trackingBrief:brief};
}
