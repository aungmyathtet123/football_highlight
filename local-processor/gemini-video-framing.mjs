import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { footballVideoPart } from './gemini-media-policy.mjs';
import {applySourceActionTimeline,SOURCE_ACTION_TIMELINE_SCHEMA,validateSourceActionTimeline} from './source-action-timeline.mjs';

export const VIDEO_FRAMING_VERSION = 1;
export const VIDEO_FRAMING_REQUEST_VERSION = 5;
export const VIDEO_SAMPLE_CLOCK_VERSION = 3;
export const VIDEO_FRAMING_FPS = 8;
export const VIDEO_FRAMING_MAX_SAMPLES = 80;
export const DETAIL_VIDEO_FRAMING_MAX_SAMPLES = 24;

// Keep the source clock visible in the video itself. Fractional timestamps
// in prose alone do not bind a model's coordinate rows to decoded frames.
// This small reference label does not move/resize the original picture.
export function framingVideoClockFilter() {
  const font=process.env.CAPTION_FONT_PATH||(process.platform==='win32'?'C:/Windows/Fonts/arialbd.ttf':'/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf');
  const escaped=font.replaceAll('\\','/').replaceAll(':','\\:').replaceAll("'","\\'");
  return `drawtext=fontfile='${escaped}':text='SCENE %{pts\\:flt}':x=8:y=8:fontsize=24:fontcolor=white:box=1:boxcolor=black@0.8`;
}
const BOX_KEYS = ['ball','player','goalkeeper','goalPost','subjectCore','faceCore'];

// Wire rectangles use named edges, not nested length-constrained arrays.
// Google rejected the 80-row schema when every row contained six bounded
// arrays. Keep the same observed geometry and translate only its encoding.
export function normalizeVideoFramingResponse(raw) {
  if(!Array.isArray(raw?.frames)) return raw;
  return {...raw,frames:raw.frames.map(frame=>{
    if(!frame || typeof frame!=='object') return frame;
    const normalized={...frame};
    for(const key of BOX_KEYS) {
      const box=frame[key];
      if(box && !Array.isArray(box) && typeof box==='object')
        normalized[key]=[box.top,box.left,box.bottom,box.right];
    }
    return normalized;
  })};
}

// Limit ORIGINAL input time before reducing its frame rate. An output -t is
// rounded to the encoder's 8fps timebase and can discard the last valid tick
// (12.28s became 98 samples although the 12.25s tick is inside that scene).
export function framingVideoInputArgs(path,start,duration) {
  if(!Number.isFinite(start)||start<0||!Number.isFinite(duration)||duration<=0)
    throw new Error('Invalid framing input clock');
  return ['-ss',String(start),'-t',String(duration),'-i',path];
}

export function focusedVideoWindows(indexes,fps,duration) {
  const count=Math.ceil(duration*fps-1e-9);
  if(!Number.isFinite(fps)||fps<=0||!Number.isFinite(duration)||duration<=0
    ||!Array.isArray(indexes)||indexes.some(index=>!Number.isInteger(index)||index<0||index>=count))
    throw new Error('Invalid focused video clock');
  const groups=[];
  for(const index of [...new Set(indexes)].sort((a,b)=>a-b)) {
    const group=groups.at(-1);
    if(!group||index-group[0]>fps*2) groups.push([index]);else group.push(index);
  }
  return groups.map(indexes=>({indexes,count:indexes.length,
    start:Math.max(0,(indexes[0]-2)/fps),end:Math.min(duration,(indexes.at(-1)+3)/fps)}));
}

// Dense observations are visibility evidence, not commands to recenter at every
// tick. Short scenes use one complete video request, without JPEG attachments.
export function videoFramingWindows(duration, fps = VIDEO_FRAMING_FPS, maximumSamples = VIDEO_FRAMING_MAX_SAMPLES) {
  if (!(Number.isFinite(duration) && duration > 0 && Number.isFinite(fps) && fps > 0)) {
    throw new Error('Invalid video framing clock');
  }
  if(!Number.isInteger(maximumSamples)||maximumSamples<1||maximumSamples>VIDEO_FRAMING_MAX_SAMPLES)
    throw new Error('Invalid video observation batch size');
  const count = Math.ceil(duration * fps - 1e-9);
  const windows = [];
  for (let offset = 0; offset < count; offset += maximumSamples) {
    const size = Math.min(maximumSamples, count - offset);
    const start = Math.max(0, (offset - 2) / fps);
    const end = Math.min(duration, (offset + size + 2) / fps);
    windows.push({ offset, count: size, start, end,
      indexes: Array.from({ length: size }, (_, i) => offset + i) });
  }
  return windows;
}

export function validateVideoFramingFrames(raw, indexes, fps) {
  if (!Array.isArray(raw?.frames) || raw.frames.length !== indexes.length) {
    throw new Error('Video framing omitted required observation times');
  }
  const expected = new Set(indexes), seen = new Set();
  for (const frame of raw.frames) {
    if (!expected.has(frame.index) || seen.has(frame.index)
      || !Number.isFinite(frame.time) || Math.abs(frame.time - frame.index / fps) > .00011) {
      throw new Error('Video framing returned duplicate indexes or an incorrect scene clock');
    }
    seen.add(frame.index);
    if (!['setup', 'contact', 'flight', 'continuation', 'payoff', 'reaction', 'decision'].includes(frame.phase)
      || !['approach', 'possession', 'release', 'travel', 'receive', 'keeper_touch', 'rebound', 'loose_ball', 'result', 'reaction', 'decision'].includes(frame.situation)
      || typeof frame.cut !== 'boolean' || typeof frame.actionResolved !== 'boolean'
      || typeof frame.ballInPlay !== 'boolean' || typeof frame.identity !== 'string'
      || typeof frame.explanation !== 'string') throw new Error('Video framing returned incomplete visual states');
    for (const key of ['ball', 'player', 'goalkeeper', 'goalPost', 'subjectCore', 'faceCore']) {
      const box = frame[key];
      if (box !== null && (!Array.isArray(box) || box.length !== 4
        || !box.every(value => Number.isFinite(value) && value >= 0 && value <= 1000)
        || box[0] >= box[2] || box[1] >= box[3])) {
        throw new Error(`Video framing returned an invalid ${key} box at ${frame.time}s`);
      }
    }
  }
  return { frames: [...raw.frames].sort((a, b) => a.index - b.index) };
}

export function videoFramingRequest({ model, data, window, fps, sceneContext, contract, schema, previous = [], initialPlan = false, sourceTimeline, duration=window.end }) {
  // No names, claimed score/outcome, or estimated keyframes prime the observer.
  const clocks = window.indexes.map(index => ({ index, time: +(index / fps).toFixed(4),
    videoTime: +(index / fps - window.start).toFixed(4) }));
  const responseSchema = structuredClone(schema);
  responseSchema.properties.frames.items.required.push('time');
  responseSchema.properties.frames.items.properties.time = { type: 'NUMBER' };
  for(const key of BOX_KEYS) {
    responseSchema.properties.frames.items.properties[key]={type:'OBJECT',nullable:true,
      required:['top','left','bottom','right'],propertyOrdering:['top','left','bottom','right'],
      properties:{top:{type:'NUMBER'},left:{type:'NUMBER'},bottom:{type:'NUMBER'},right:{type:'NUMBER'}}};
  }
  // On this Vertex endpoint exact-length constraints rejected even an 8-row
  // control (400), while the same unconstrained schema returned all 80 rows.
  // Enforce exact count/index/clock locally, not in the provider grammar.
  delete responseSchema.properties.frames.minItems;
  delete responseSchema.properties.frames.maxItems;
  delete responseSchema.properties.occlusions;
  delete responseSchema.properties.shotEntries;
  responseSchema.required.push('focusNotes');
  responseSchema.properties.focusNotes={type:'OBJECT',required:['startFocus','ballRoute','finishFocus','observedOutcome',
    'goalLineCrossingVerified','goalLineCrossingTime','crossingEvidence','uncertainties'],properties:{
    startFocus:{type:'STRING'},ballRoute:{type:'STRING'},finishFocus:{type:'STRING'},
    observedOutcome:{type:'STRING',enum:['goal','keeper_save','woodwork','blocked','wide','over','uncertain','not_applicable']},
    goalLineCrossingVerified:{type:'BOOLEAN'},goalLineCrossingTime:{type:'NUMBER',nullable:true},
    crossingEvidence:{type:'STRING'},uncertainties:{type:'ARRAY',items:{type:'STRING'}}}};
  responseSchema.propertyOrdering=['focusNotes','frames'];
  const includeTimeline=window.offset===0&&window.start===0&&window.end===duration;
  if(includeTimeline) {
    responseSchema.required.push('sourceTimeline');
    responseSchema.properties.sourceTimeline=structuredClone(SOURCE_ACTION_TIMELINE_SCHEMA);
    responseSchema.propertyOrdering=['sourceTimeline','focusNotes','frames'];
  }
  return { model, contents: [footballVideoPart(data, fps), { text:
    `Observe this ORIGINAL football scene as a continuous video. Scene context: ${JSON.stringify(sceneContext)}.
Watch the complete action FIRST, before emitting any coordinate rows. Record focusNotes: the actual starting carrier and ball location, the ball's route and receiving contacts, and which visible keeper/goalmouth or reacting subject is the correct final focus. Include scene-local times for each real touch, direction change, sporting consequence and final visible subject in those notes. Distinguish a direct free kick from a cross or header; do not infer touches or jersey numbers. Determine the real sporting consequence from the moving ball. Note uncertainty honestly. goalLineCrossingVerified is true ONLY for visibly followed crossing inside the posts, with its exact SCENE-local time and concrete crossingEvidence; otherwise false and time:null. Do not use the scoreboard or celebration as goal proof. Write neutral roles, not invented names. These notes guide this INITIAL observation, not a later repair request.
${includeTimeline?`FIRST emit sourceTimeline, partitioning the provided scene from 0 through ${window.end} seconds into adjacent, non-overlapping intervals. Each interval includes phase, situation, startTime, endTime, concrete visibleAction, actionResolved and ballInPlay. A run toward a stationary ball before contact is setup/approach. A shot visibly hitting the crossbar/post, being saved/blocked or crossing inside the posts has payoff/result and actionResolved:true at that consequence. A subsequent defensive clearance must NOT erase that earlier payoff. Keep every real touch and outcome separately. If a consequence is hidden, report uncertainty, never invent one. This timeline is semantic guidance, NOT proof of positions or approval.`:''}
The video begins at scene-local ${window.start.toFixed(4)} seconds and ends at ${window.end.toFixed(4)} seconds. Observe the exact supplied timestamps; never confuse VIDEO-local and SCENE-local clocks. Return precisely these ${window.count} observations: ${JSON.stringify(clocks)}.
Each observation needs index, time (SCENE-local), phase, situation, cut, ball, player, goalkeeper, goalPost, subjectCore, faceCore, identity, explanation, actionResolved and ballInPlay. Boxes are directly observed FULL ORIGINAL FRAME rectangles with named top, left, bottom, right edges, normalized 0..1000. Use null for hidden or uncertain subjects; never interpolate or fabricate positions. State uncertainty briefly in explanation. No player/team names or assumed result.
If a SCENE clock label is present in the pixels, it is the original scene-local clock, NOT the clipped video's playback time. Locate each requested frame by that clock. The label is not a football, player or goalpost. A plausible smooth sequence is not an observation: never continue a guessed ball parabola through a camera pan. At release/control the ball must actually meet the relevant player's body/foot; if those boxes are far apart, reconsider the visible frame and phase rather than emitting contradictory coordinates.
Follow the REAL MOVING match ball, not a stationary spare ball, advertising, clothing or an unrelated player. At possession/release retain the initiating player AND ball. During flight follow the ball; the old passer need not remain the primary player. A receiver WAITING for a distant pass is not possession/receive: use flight/travel until the directly observed receiving touch. On receipt identify the actual receiver and ball. Preserve every passing/shooting contact and the goal/save/miss consequence; never switch to a goalkeeper or celebration before the result. Box ONE directly involved player, never a group. goalkeeper is a separate directly visible body box. goalPost is the SMALL relevant upright/crossbar corner near an observed arrival/result, not the whole net. Do not invent either from an expected goal.
Situation must be approach|possession|release|travel|receive|keeper_touch|rebound|loose_ball|result|reaction|decision. A run-up toward a stationary set-piece ball is setup/approach before the kick, not possession or release. Before a release identify setup; an already completed receiving touch is not a new setup. During a rebound/loose ball keep following the ball, not a random nearby player. actionResolved is true only AFTER the actual consequence; a new release is unresolved. ballInPlay is false only when visibly dead/out of play; otherwise use true, including uncertainty. Reaction-only footage is permitted only after the action resolves or for a selected subject-support scene.
Distinguish a live keeper parry from the ball bouncing inside the net AFTER visibly crossing the goal line. The latter is payoff/result, actionResolved:true and ballInPlay:false, not a new live rebound. Preserve the visible involved goalkeeper/goalpost through that resolved result; if the ball later leaves the source view, return ball:null rather than a spare ball. Never infer a goal when crossing is not observed in this supplied video.
Mark cut only at a genuine SOURCE shot change, never because an observation window starts or the football moves quickly. For a reaction close-up, subjectCore/faceCore may box that SAME person's face and upper chest within the player box, excluding arms/teammates; otherwise use null. Do not manufacture a centre slice. Use a stable descriptive identity and at most eight words per explanation.
Observe the FINAL included timestamps as carefully as the kick. A generic 'players reacting' label is not a location: box the directly visible involved final-touch player or goalkeeper, and its faceCore/subjectCore when appropriate. Keep the visible ball through a still-live rebound. If neither ball nor relevant subject can actually be seen, return null and explain the exact obstruction; never invent a reaction actor. Each row must be read from the video at that time, not generated as a constant-velocity coordinate sequence from two endpoints. Account for the broadcast camera's own pan and zoom when locating the ball.
These are dense visual observations, NOT camera commands. Camera position and constant full-bleed scale will be calculated separately: hold while required subjects fit safely, move only before they leave, follow the receiver and goalmouth through the payoff. Do not emit guessed camera coordinates or approval flags.
Prior observations are context only, not proof: ${JSON.stringify(previous)}. Correct them if contradicted by this video. Do not invent action outside the provided window.
${sourceTimeline?`Complete-video semantic timeline (approximate context, not coordinate evidence or crop approval): ${JSON.stringify(sourceTimeline)}. Determine the exact phase and subjects directly at each requested video frame; do not force a coarse timeline label onto contradictory pixels. A pre-touch run-up is approach, not possession.`:''}
${contract}` }], config: { responseMimeType: 'application/json', responseSchema,
      // Dense coordinate output needs space for ALL requested rows. HIGH
      // reasoning consumed 21k of a 24k ceiling in a live 80-row request,
      // truncating its JSON. MEDIUM balances latency and visual reasoning;
      // every coordinate and the independently rendered crop still validate.
      temperature: 0, maxOutputTokens: 32768, thinkingConfig: { thinkingLevel: 'MEDIUM' },
      // A live joint 80-row answer exceeded the old 180s deadline on Flash.
      // Do not discard its first provider run and repay it before completion.
      // Smaller requests keep the normal scheduler deadline.
      ...(window.count>=64?{httpOptions:{timeout:360000}}:{}) } };
}

export function videoFramingObservationIssue(frame) {
  const actor=frame?.situation==='keeper_touch'?frame.goalkeeper:frame?.player;
  if(!['possession','release','receive','keeper_touch'].includes(frame?.situation)
    || !Array.isArray(frame.ball)||!Array.isArray(actor)) return null;
  const dx=Math.max(0,actor[1]-frame.ball[3],frame.ball[1]-actor[3]);
  const dy=Math.max(0,actor[0]-frame.ball[2],frame.ball[0]-actor[2]);
  // This does not detect anything or relabel travel as contact. A claimed
  // physical touch and two far-separated observed boxes contradict each
  // other. Preserve the original answer and report that contradiction;
  // the active initial-plan flow does not request another observation.
  return Math.hypot(dx,dy)>100
    ?'The claimed contact/control actor is far from the observed ball; the initial phase and subject boxes contradict each other.' : null;
}

function validSubset(raw, indexes, fps, validateObservations) {
  const frames = [];
  const issues = [];
  for (const index of indexes) {
    const matches = (Array.isArray(raw?.frames) ? raw.frames : []).filter(frame => frame?.index === index);
    if (matches.length !== 1) {
      issues.push({index,time:index/fps,reason:matches.length?'Duplicate observation index':'Omitted observation index'});
      continue;
    }
    try {
      const checked = validateVideoFramingFrames({ frames: matches }, [index], fps);
      const contactIssue=videoFramingObservationIssue(matches[0]);
      if(contactIssue) throw new Error(contactIssue);
      validateObservations(checked, index, 1, fps);
      frames.push(...checked.frames);
    } catch(error) {
      issues.push({index,time:index/fps,reason:String(error.message)});
    }
  }
  return { frames,observationIssues:issues,...(raw?.focusNotes?{focusNotes:raw.focusNotes}:{}) };
}

export async function checkpointVideoFramingCorrections({ frames, duration, fps, signature,
  directory, validateObservations }) {
  for (const window of videoFramingWindows(duration, fps)) {
    const raw = validSubset({frames:frames.map(frame=>({...frame,time:frame.index/fps}))},window.indexes,fps,validateObservations);
    // Never let an incomplete correction discard already-observed neighbours.
    if (raw.frames.length !== window.count) continue;
    const cache=join(directory,`${signature}.video-v${VIDEO_FRAMING_VERSION}-${window.offset}.json`);
    await writeFile(`${cache}.tmp`,JSON.stringify({...raw,version:VIDEO_FRAMING_VERSION,fps,samplingClockVersion:VIDEO_SAMPLE_CLOCK_VERSION}));
    await rename(`${cache}.tmp`,cache);
  }
}

export async function observeFramingVideo({ contextPath, duration, fps = VIDEO_FRAMING_FPS,
  scene, signature, directory, scratchDir, ffmpeg, run, model, generate, report,
  schema, contract, validateObservations, sourceTimeline, maximumSamples=VIDEO_FRAMING_MAX_SAMPLES,
  detailWindows=false }) {
  const all = [];
  for (const window of videoFramingWindows(duration, fps, maximumSamples)) {
    // Output-array limits are NOT scene boundaries. All requests for a short
    // locked action see its complete video, including the sporting outcome.
    // First request sees the complete action and notes its semantic timeline.
    // Later requests see only their original short time window plus overlap;
    // these are observation windows, never changes to locked scene boundaries.
    const contextWindow=duration<=20&&(!detailWindows||window.offset===0)
      ?{...window,start:0,end:duration}:window;
    const cache = join(directory, `${signature}.video-v${VIDEO_FRAMING_VERSION}-${window.offset}.json`);
    let raw,saved;
    // A provider response can contain malformed indexes or scene-local clocks
    // even when this locked Step-1 scene is valid. Keep the scene boundaries
    // and allow one bounded same-video format retry instead of stopping.
    let malformedIndexRetry = false;
    try {
      saved = JSON.parse(await readFile(cache, 'utf8'));
    } catch(error) {if(error.code!=='ENOENT'&&!(error instanceof SyntaxError)) throw error;}
      if (saved?.version === VIDEO_FRAMING_VERSION && saved.fps === fps) {
        // Retain old observations except a fractional final tick that the old
        // output-duration rounding may have removed from the provided video.
        // Reobserve ONLY that tick, not the earlier paid source windows.
        const frames=saved.samplingClockVersion===VIDEO_SAMPLE_CLOCK_VERSION?saved.frames
          :(saved.frames||[]).filter(frame=>frame.index<Math.floor(duration*fps+1e-9));
        if(saved.requestVersion===4) {
          // Recover an already-paid v5 response if an older worker archived
          // it, then stopped during interpretation before writing its cache.
          // The legacy response was separately archived by the upgrade above.
          let archived;
          try {archived=JSON.parse(await readFile(cache.replace(/\.json$/,'.response.json'),'utf8'));} catch(error) {
            if(error.code!=='ENOENT'&&!(error instanceof SyntaxError)) throw error;
          }
          if(archived?.sourceTimeline) {
            saved={...normalizeVideoFramingResponse(archived),version:VIDEO_FRAMING_VERSION,fps,
              requestVersion:VIDEO_FRAMING_REQUEST_VERSION,samplingClockVersion:VIDEO_SAMPLE_CLOCK_VERSION};
            await writeFile(`${cache}.tmp`,JSON.stringify(saved));await rename(`${cache}.tmp`,cache);
          }
        }
        if(saved.sourceTimeline&&!sourceTimeline) sourceTimeline=validateSourceActionTimeline(saved.sourceTimeline,duration,
          {sampled:true,fps,coverageEnd:saved.sourceTimeline.observedThrough??
            (saved.sourceTimeline.phases?.at(-1)?.endTime+1/fps<=window.count/fps+.001?window.count/fps:duration)});
        let original={frames:saved.requestVersion===VIDEO_FRAMING_REQUEST_VERSION?saved.frames:frames,focusNotes:saved.focusNotes};
        if(sourceTimeline) {
          // Only recover rows actually present in the archived provider answer.
          // No boxes are inferred from phase labels or neighbouring samples.
          try {original=normalizeVideoFramingResponse(JSON.parse(await readFile(cache.replace(/\.json$/,'.response.json'),'utf8')));} catch(error) {
            if(error.code!=='ENOENT') throw error;
          }
          // Short-window rows have their own directly observed phase/clock.
          // A coarse full-video phase must not turn flight into a contact or
          // ongoing live play into reaction merely because times overlap.
          if(!detailWindows) original=applySourceActionTimeline(original,sourceTimeline,duration);
        }
        raw = validSubset(original, window.indexes, fps, validateObservations);
        // Preserve the actual rejection cause; filtering a contradictory row
        // must not turn it into a supposed omission on the next worker.
        if(!sourceTimeline&&Array.isArray(saved.observationIssues)) raw.observationIssues=raw.observationIssues.map(issue=>
          saved.observationIssues.find(previous=>previous.index===issue.index)||issue);
        // Complete paid observations remain reusable. Only an incomplete old
        // request can be reopened once under the corrected output budget.
        // Otherwise a truncated 24k/HIGH answer permanently poisons this key.
        const legacyFormatFailure=raw.observationIssues.some(issue=>/^Video framing returned an invalid \w+ box/.test(issue.reason))
          || raw.observationIssues.filter(issue=>issue.reason==='Omitted observation index').length>window.count/2;
        // Version 4 mixed independent window summaries with coordinate rows.
        // Reopen only a demonstrably incomplete legacy *whole-scene* plan,
        // once, under the coherent timeline+geometry request. Complete paid
        // plans and all approved crops are retained. A v5 negative cannot
        // trigger this upgrade again on Resume.
        const legacySemanticFailure=saved.requestVersion===4&&window.offset===0&&duration<=20
          && (raw.observationIssues.some(issue=>/claimed contact\/control actor is far/.test(issue.reason))
            ||raw.frames.length===window.count&&!raw.frames.some(frame=>frame.phase==='payoff'||frame.situation==='result')
              && scene.eventType!=='celebration'&&scene.storyPhase!=='reaction');
        if(saved.requestVersion!==VIDEO_FRAMING_REQUEST_VERSION && (legacyFormatFailure||legacySemanticFailure)) {
          await writeFile(cache.replace(/\.json$/,`.request-v${saved.requestVersion||'legacy'}.json`),JSON.stringify(saved));
          try {
            const archived=await readFile(cache.replace(/\.json$/,'.response.json'),'utf8');
            await writeFile(cache.replace(/\.json$/,`.request-v${saved.requestVersion||'legacy'}.response.json`),archived);
          } catch(error) {if(error.code!=='ENOENT') throw error;}
          raw=undefined;
        }
      }
    // Reopen an incomplete cached provider answer once with the strict index
    // contract below. Do not discard the selected scene or start discovery.
    if (raw?.frames) {
      const cachedMissing = window.indexes.filter(index => !raw.frames.some(frame => frame.index === index));
      if (cachedMissing.length) { malformedIndexRetry = true; raw = undefined; }
    }
    if (!raw) {
      await report(`Gemini video: observing ${scene.id}, ${window.offset + 1}-${window.offset + window.count} of ${Math.ceil(duration * fps - 1e-9)} timed positions; no image batches.`);
      let path = contextPath;
      if (contextWindow.start !== 0 || contextWindow.end !== duration) {
        path = join(scratchDir, `video-window-${window.offset}.mp4`);
        await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...framingVideoInputArgs(contextPath,contextWindow.start,contextWindow.end-contextWindow.start), '-an', '-c:v', 'libx264',
          '-preset', 'veryfast', '-crf', '20', path]);
      }
      const request = videoFramingRequest({ model, data: (await readFile(path)).toString('base64'),
        window:contextWindow, fps, sceneContext: { startTime: scene.startTime, endTime: scene.endTime },
        contract, schema, previous: all.slice(-2), initialPlan:true,sourceTimeline,duration });
      const retryResponsePath=cache.replace(/\.json$/,'.index-retry-v1.response.json');
      let response;
      if (malformedIndexRetry) {
        try { response=normalizeVideoFramingResponse(JSON.parse(await readFile(retryResponsePath,'utf8'))); } catch {}
        if (!response) request.contents.push({text:
          'The previous answer for this SAME locked scene had malformed observation indexes or scene-local clocks. This is a JSON-format failure, not missing football and not permission to rediscover or change scene boundaries. Return exactly one row for EVERY requested index, once only, copying each requested index and exact time from the clock table. Never renumber, duplicate, omit, sort into a different clock, or add rows. Preserve null for an unseen object and keep all rows even when the frame is a reaction or camera cut. Return JSON only.'});
      }
      if (!response) response=await generate(request,
        `${malformedIndexRetry ? 'format retry ' : ''}video keyframes ${scene.id} times ${window.indexes[0] / fps}-${window.indexes.at(-1) / fps}`);
      // Save the complete first answer BEFORE interpretation. Invalid rows
      // are evidence too; discarding them concealed the real model error.
      const responsePath=malformedIndexRetry?retryResponsePath:cache.replace(/\.json$/,'.response.json');
      await writeFile(`${responsePath}.tmp`,JSON.stringify(response));
      await rename(`${responsePath}.tmp`,responsePath);
      // Save the current-contract answer before semantic validation too.
      // Otherwise an invalid timeline left the old v4 checkpoint intact and
      // Resume could repeatedly purchase the same supposed format upgrade.
      const decoded=normalizeVideoFramingResponse(response);
      await writeFile(`${cache}.tmp`,JSON.stringify({...decoded,version:VIDEO_FRAMING_VERSION,
        requestVersion:VIDEO_FRAMING_REQUEST_VERSION,fps,samplingClockVersion:VIDEO_SAMPLE_CLOCK_VERSION}));
      await rename(`${cache}.tmp`,cache);
      if(response.sourceTimeline&&duration<=20&&!sourceTimeline) sourceTimeline=validateSourceActionTimeline(response.sourceTimeline,duration,
        {sampled:true,fps,coverageEnd:response.sourceTimeline.phases?.at(-1)?.endTime+1/fps<=window.count/fps+.001?window.count/fps:duration});
      const normalized=normalizeVideoFramingResponse(response);
      raw = validSubset(sourceTimeline&&!detailWindows?applySourceActionTimeline(normalized,sourceTimeline,duration):normalized, window.indexes, fps, validateObservations);
      const malformedMissing = window.indexes.filter(index => !raw.frames.some(frame => frame.index === index));
      if (malformedMissing.length && !malformedIndexRetry) {
        // One format-only retry for the same continuous source window. The
        // model must repair indexes/times, not revisit scene selection.
        malformedIndexRetry = true;
        const retryRequest = videoFramingRequest({ model, data: (await readFile(path)).toString('base64'),
          window:contextWindow, fps, sceneContext: { startTime: scene.startTime, endTime: scene.endTime },
          contract, schema, previous: all.slice(-2), initialPlan:true,sourceTimeline,duration });
        retryRequest.contents.push({text:
          'The previous answer for this SAME locked scene had malformed observation indexes or scene-local clocks. This is a JSON-format failure, not missing football and not permission to rediscover or change scene boundaries. Return exactly one row for EVERY requested index, once only, copying each requested index and exact time from the clock table. Never renumber, duplicate, omit, sort into a different clock, or add rows. Preserve null for an unseen object and keep all rows even when the frame is a reaction or camera cut. Return JSON only.'});
        const retryResponsePath=cache.replace(/\.json$/,'.index-retry-v1.response.json');
        let retry;
        try { retry=normalizeVideoFramingResponse(JSON.parse(await readFile(retryResponsePath,'utf8'))); } catch {}
        if (!retry) retry=await generate(retryRequest,
          `format retry video keyframes ${scene.id} times ${window.indexes[0] / fps}-${window.indexes.at(-1) / fps}`);
        await writeFile(`${retryResponsePath}.tmp`,JSON.stringify(retry));
        await rename(`${retryResponsePath}.tmp`,retryResponsePath);
        const retryNormalized=normalizeVideoFramingResponse(retry);
        raw = validSubset(sourceTimeline&&!detailWindows?applySourceActionTimeline(retryNormalized,sourceTimeline,duration):retryNormalized,
          window.indexes, fps, validateObservations);
      }
      // Persist successful observations outside scratch files before crop QA.
      // Capacity and geometry retries reuse this exact source/model clock.
      await writeFile(`${cache}.tmp`, JSON.stringify({ ...raw, version: VIDEO_FRAMING_VERSION,
        requestVersion:VIDEO_FRAMING_REQUEST_VERSION,fps, samplingClockVersion:VIDEO_SAMPLE_CLOCK_VERSION,
        ...(sourceTimeline?{sourceTimeline}:{}) }));
      await rename(`${cache}.tmp`, cache);
    }
    // Persist the initial observation, but do NOT ask Gemini to repair it.
    // Geometry/model omissions are not transport failures or licence to guess.
    const byIndex = new Map(raw.frames.map(frame => [frame.index, frame]));
    const missing = window.indexes.filter(index => !byIndex.has(index));
    if (missing.length) {
      const issue=raw.observationIssues?.find(value=>value.index===missing[0]);
      throw new Error(`Video framing still needs ${missing.length} observed positions; saved valid times retained. First uncertain time: ${missing[0] / fps}s. Initial observation issue: ${issue?.reason||'No usable observation'}. No correction request was started.`);
    }
    const focusNotes=raw.focusNotes;
    raw = validateVideoFramingFrames(raw, window.indexes, fps);
    all.push(...raw.frames);
    if(focusNotes) (all.initialFocusNotes||=[]).push(focusNotes);
  }
  if(sourceTimeline) all.sourceActionTimeline=sourceTimeline;
  return all;
}
