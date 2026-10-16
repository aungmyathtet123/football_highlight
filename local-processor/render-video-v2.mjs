import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_SCENE_SECONDS, COMPLETE_HIGHLIGHT_MAX_PLAYBACK_RATE } from "./editorial-policy.mjs";
import { captionAss, narrationSubtitleCues, sparseCaptionCues, shortReactionCandidates } from "./short-form-policy.mjs";
import { verifiedPayoffWindow } from "./payoff-evidence.mjs";
import { trackedPositionExpression } from "./tracked-position.mjs";
import { tacticalFreezeAnchor } from "./tactical-plan.mjs";
import { assertIncidentCoverage } from "./incident-coverage.mjs";
import { usesSafeStaticPresentation } from "./delivery-policy.mjs";
import { filterGraphFileArgs } from "./ffmpeg-compat.mjs";
import { boundedFfmpegArgs } from "./ffmpeg-thread-budget.mjs";
import { videoEncoderArgs } from './fast-tracking-policy.mjs';
import { prepareMatchTeamBadges } from "./team-badges.mjs";
import {splitSceneInput} from './split-scene-assets.mjs';
import {fixedRenderSceneQueue} from './fixed-scene-queue.mjs';
import {encodedBatchClock} from './rendered-batch-clock.mjs';

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export function outputDimensions(settings) {
  if (settings?.aspectRatio === "16:9") return { width: 1920, height: 1080 };
  if (settings?.aspectRatio === "4:3") return { width: 1440, height: 1080 };
  if (settings?.aspectRatio === "1:1") return { width: 1080, height: 1080 };
  return settings?.aspectRatio === "4:5" ? { width: 1080, height: 1350 } : { width: 1080, height: 1920 };
}

// A panning portrait crop can expose a clock between separated source masks.
// Cover the shallow broadcast-header strip once in output coordinates, without
// recropping the pitch, resizing it, or changing the approved camera path.
export function portraitMatchResultTitle(matchContext, firstTeam = matchContext?.homeTeam) {
  if (matchContext?.status !== "verified") return "";
  const cleanTeam = value => typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  const home = cleanTeam(matchContext.homeTeam), away = cleanTeam(matchContext.awayTeam);
  const score = String(matchContext.finalScore || "").match(/^\s*(\d{1,2})\s*[-:\u2013\u2014]\s*(\d{1,2})\s*$/u);
  if (!home || !away || home.toLowerCase() === away.toLowerCase() || !score) return "";
  // Reverse the associated score too when changing display order.
  const awayFirst = cleanTeam(firstTeam).toLowerCase() === away.toLowerCase();
  return (awayFirst ? `${away} ${score[2]}–${score[1]} ${home}` : `${home} ${score[1]}–${score[2]} ${away}`).toUpperCase();
}

export function portraitMatchResultScore(matchContext, firstTeam = matchContext?.homeTeam) {
  if (!portraitMatchResultTitle(matchContext, firstTeam)) return "";
  const score = String(matchContext.finalScore).match(/^\s*(\d{1,2})\s*[-:\u2013\u2014]\s*(\d{1,2})\s*$/u);
  const cleanName = value => String(value||'').replace(/\s+/gu,' ').trim().toLowerCase();
  const awayFirst = cleanName(firstTeam) === cleanName(matchContext.awayTeam);
  return awayFirst ? `${score[2]}–${score[1]}` : `${score[1]}–${score[2]}`;
}

export function portraitBroadcastHeaderFilters(settings, width, height, matchContext = null, titlePath = null, firstTeam = matchContext?.homeTeam) {
  if (settings?.editStyle !== "complete_highlights" || settings?.aspectRatio !== "9:16"
    || settings?.logoMasking !== true || settings?.broadcastUiMasking === false) return "";
  const headerHeight=Math.ceil(Number(height)*.115/2)*2;
  const score = portraitMatchResultScore(matchContext, firstTeam);
  const background = `drawbox=x=0:y=0:w=iw:h=${headerHeight}:color=black@0.24:t=fill,`
    +`drawbox=x=0:y=${headerHeight-2}:w=iw:h=2:color=white@0.24:t=fill`;
  if (!score) return background; // Never invent an unknown match/result.
  if (!titlePath) throw new Error("A verified match-result header needs its score text file.");
  const font=escapeFilterPath(resolveSetting(process.env.CAPTION_FONT_PATH || "C:/Windows/Fonts/arialbd.ttf"));
  const fontSize = Math.max(1, Math.round(Number(width)*.056));
  // The header file contains only the verified score, not team names. Team
  // identity is conveyed by the adjacent badges and retained in job metadata.
  return background + `,drawtext=fontfile='${font}':textfile='${escapeFilterPath(titlePath)}':expansion=none:fontcolor=white:fontsize=${fontSize}:borderw=2:bordercolor=black@0.8:shadowx=1:shadowy=2:shadowcolor=black@0.6:x=(w-text_w)/2:y=(${headerHeight}-text_h)/2`;
}

// Sample only a narrow copy of the footage below the title, heavily blur it,
// then overlay that copy at the top. The main pitch is neither scaled nor
// recropped, and an existing painted header cannot leak into the blur.
export function portraitBroadcastHeaderPlan(settings,width,height,matchContext,titlePath,{firstTeam=matchContext?.homeTeam,badgeInputs={},inputLabel='outv',outputLabel='headerCleanVideo'}={}){
  const treatment=portraitBroadcastHeaderFilters(settings,width,height,matchContext,titlePath,firstTeam);
  if(!treatment)return [];
  const headerHeight=Math.ceil(Number(height)*.115/2)*2;
  const filters=[`[${inputLabel}]split=2[headerBase][headerSample]`,
    `[headerSample]crop=w=iw:h=${headerHeight}:x=0:y=${headerHeight},gblur=sigma=24:steps=2[headerBlur]`,
    `[headerBase][headerBlur]overlay=x=0:y=0:eof_action=pass:shortest=1,${treatment}[headerText]`];
  const cleanName = value => String(value||'').replace(/\s+/gu,' ').trim().toLowerCase();
  const awayFirst=cleanName(firstTeam)===cleanName(matchContext?.awayTeam);
  const sides=awayFirst?['away','home']:['home','away'];
  const badgeSize=Math.round(Number(width)*.074),gap=Math.round(Number(width)*.010);
  // Keep badges close to the score. Reserve more room only for extra digits,
  // so a 10–0/10–10 result remains legible without widening every 1–1 header.
  const score=portraitMatchResultScore(matchContext,firstTeam);
  const extraDigits=Math.max(0,(score.match(/\d/g)||[]).length-2);
  const scoreBoxWidth=Math.round(Number(width)*.11)+extraDigits*Math.round(Number(width)*.035);
  let previous='headerText';
  for(const [sideIndex,side] of sides.entries()){
    const input=badgeInputs[side];if(!Number.isInteger(input)||input<0)continue;
    const badge=`headerBadge${sideIndex}`,next=`headerWithBadge${sideIndex}`;
    filters.push(`[${input}:v]format=rgba,scale=w=${badgeSize}:h=${badgeSize}:force_original_aspect_ratio=decrease:flags=lanczos,pad=w=${badgeSize}:h=${badgeSize}:x=(ow-iw)/2:y=(oh-ih)/2:color=black@0[${badge}]`);
    const x=sideIndex===0?`(W-${scoreBoxWidth})/2-${gap}-w`:`(W+${scoreBoxWidth})/2+${gap}`;
    filters.push(`[${previous}][${badge}]overlay=x=${x}:y=(${headerHeight}-h)/2:eof_action=repeat:shortest=1[${next}]`);
    previous=next;
  }
  filters.push(`[${previous}]null[${outputLabel}]`);return filters;
}

// One fixed crop per source shot. The test uses both subjects across the
// tracked scene, rather than chasing a player or ball every frame. If the
// evidence is sparse or either subject approaches the new edge, keep 100%.
export function safeLandscapeZoom(keyframes, width, height) {
  const unchanged = (reason) => ({ zoom: 1, centerX: 0.5, centerY: 0.5, reason });
  const frames = (Array.isArray(keyframes) ? keyframes : []).filter(frame => Number.isFinite(Number(frame?.time)));
  if (frames.length < 8 || frames.some(frame => frame?.sceneCut && Number(frame.time) > 0.15)) return unchanged("insufficient_continuous_tracking");
  const observed = frames.filter(frame => frame.ballInFrame === true && frame.playerInFrame === true
    && [frame.ballCenterX, frame.ballCenterY, frame.playerCenterX, frame.playerCenterY]
      .every(value => typeof value === "number" && Number.isFinite(value)));
  if (observed.length < 8 || observed.length / frames.length < 0.85) return unchanged("ball_or_player_not_continuously_verified");
  const points = observed.flatMap(frame => [
    [Number(frame.ballCenterX) / width, Number(frame.ballCenterY) / height],
    [Number(frame.playerCenterX) / width, Number(frame.playerCenterY) / height],
  ]);
  if (points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1)) return unchanged("invalid_subject_position");
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  const centerX = clamp((Math.min(...xs) + Math.max(...xs)) / 2, 0.475, 0.525);
  const centerY = clamp((Math.min(...ys) + Math.max(...ys)) / 2, 0.475, 0.525);
  for (const zoom of [1.10, 1.08, 1.05]) {
    const half = 0.5 / zoom;
    const margin = 0.055 / zoom;
    if (points.every(([x, y]) => x >= centerX - half + margin && x <= centerX + half - margin
      && y >= centerY - half + margin && y <= centerY + half - margin)) {
      return { zoom, centerX, centerY, reason: "verified_scene_safe" };
    }
  }
  return unchanged("action_needs_full_width");
}

export function synchronizationProblems(beats) {
  const problems = [];
  const narratedBeats = new Set();
  let previousStart = -1;
  for (const entry of Array.isArray(beats) ? beats : []) {
    const start = Number(entry?.visualStart);
    const visualDuration = Number(entry?.visualDuration);
    const speechDuration = Number(entry?.speechDuration);
    if (!Number.isFinite(start) || start + 0.001 < previousStart) problems.push("non_monotonic_visual:" + (entry?.momentId || "unknown"));
    previousStart = Number.isFinite(start) ? start : previousStart;
    if (!entry?.narration) continue;
    if (!(speechDuration > 0)) problems.push("missing_speech:" + (entry?.momentId || "unknown"));
    if (speechDuration > 0 && (!(visualDuration > 0) || visualDuration + 0.03 < speechDuration)) {
      problems.push("speech_exceeds_visual:" + (entry?.momentId || "unknown"));
    }
    const identity = String(entry?.beatId || entry?.momentId || "");
    if (narratedBeats.has(identity)) problems.push("duplicate_narrated_beat:" + identity);
    narratedBeats.add(identity);
  }
  return problems;
}

// FFmpeg 9 on Windows exposes only -filter_complex (there is no
// -filter_complex_script).  A complete recap with twelve scenes, captions,
// tactical assets and badges can therefore exceed Windows' ~32K process
// command-line limit even though the graph itself is valid.  Render small
// scene batches and concatenate the finished, independently encoded parts.
// This keeps every existing visual treatment while keeping each FFmpeg argv
// safely below the platform limit.
async function renderChunkedCompleteRecap(sourcePath, outputPath, selected, settings, media, ttsFiles, overlayMasks, tracking, stadiumAudioPath, matchContext) {
  const chunkSize = 3;
  const directory = dirname(outputPath);
  const parts = [];
  let timelineDuration = 0;
  const synchronization = [];
  let loudness = null;
  for (let start = 0; start < selected.length; start += chunkSize) {
    const chunk = selected.slice(start, start + chunkSize);
    const partPath = join(directory, `scene-part-${String(start / chunkSize).padStart(2, "0")}.mp4`);
    const rendered = await renderVideoV2(sourcePath, partPath, chunk, {
      ...settings,
      __renderChunked: true,
      __skipCoverage: true,
      // The final visual master should not flash a new match header at every
      // batch boundary.  The watermark and analytical captions remain in each
      // part and are preserved by the concat demuxer.
      __renderChunkPart: true,
      broadcastUiMasking: false,
    }, media, ttsFiles, overlayMasks, tracking, stadiumAudioPath, matchContext);
    const probe=resolveExecutable(process.env.FFPROBE_PATH||'ffprobe');
    const duration=Number((await run(probe,['-v','error','-show_entries','format=duration',
      '-of','default=noprint_wrappers=1:nokey=1',partPath])).trim());
    const result=encodedBatchClock(rendered,duration);
    parts.push(partPath);
    for (const beat of result.synchronization || []) synchronization.push({
      ...beat,
      visualStart: Number(beat.visualStart || 0) + timelineDuration,
    });
    timelineDuration += Number(result.timelineDuration || 0);
    loudness = result.loudness || loudness;
  }
  const listPath = join(directory, "scene-parts.txt");
  const concatLine = path => `file '${String(path).replace(/'/g, "'\\''")}'`;
  await writeFile(listPath, parts.map(concatLine).join("\n") + "\n", "utf8");
  const executable = resolveExecutable(process.env.FFMPEG_PATH || "ffmpeg");
  await run(executable, ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", outputPath]);
  await writeFile(join(directory,'synchronization.json'),JSON.stringify({version:2,
    clockSource:'measured_encoded_batches',timelineDuration,beats:synchronization},null,2));
  return { timelineDuration, synchronization, teaserDuration: 0, loudness };
}

export async function renderVideoV2(sourcePath, outputPath, moments, settings, media, ttsFiles, overlayMasks, tracking, stadiumAudioPath = null, matchContext = null) {
  const { width: outputWidth, height: outputHeight } = outputDimensions(settings);
  const narrationOnly = settings.commentary && settings.editStyle === "complete_highlights";
  const reactionLimit = settings.editStyle === "complete_highlights" ? 1.6 : settings.editStyle === "viral_reel" ? 2.5 : 3;
  const selected = fitSelectedMoments(shortReactionCandidates(moments, reactionLimit), settings.durationMode === "auto" ? Infinity : settings.targetDuration, ttsFiles, tracking).map((moment) => ({ ...moment,
    // Presentation v2 uses phrase-timed narration subtitles plus one short,
    // evidence-linked event callout. They occupy separate safe zones.
    presentationVersion: settings.editStyle === "complete_highlights" ? 2 : 1,
    tacticalFreezeSourceTime: usesSafeStaticPresentation(moment) ? undefined : tacticalFreezeAnchor(moment,trackingForMoment(tracking,moment)) }));
  if (selected.length === 0) throw new Error("No moments were selected for the final edit.");
  if (settings.__skipCoverage !== true) assertIncidentCoverage(moments.filter(m=>m.selectedForFinalVideo),selected);
  // See renderChunkedCompleteRecap: this branch is deliberately limited to
  // the muted visual-master pass.  Narration is added once after the entire
  // visual timeline has been concatenated, so no speech timing is duplicated.
  if (settings.__renderChunked !== true && settings.editStyle === "complete_highlights"
      && settings.commentary === false && selected.length > 3) {
    return renderChunkedCompleteRecap(sourcePath, outputPath, selected, settings, media, ttsFiles, overlayMasks, tracking, stadiumAudioPath, matchContext);
  }
  const captionCues = settings.captions && settings.narrationSubtitles !== false ? await makeCaptionCueFiles(selected, outputPath, tracking, outputWidth, outputHeight) : new Map();
  const calloutFiles = settings.captions ? await makeCalloutFiles(selected, outputPath) : new Map();
  // Keep the upper corner clear. The former scene/chapter label was a static
  // production label, not evidence-linked football analysis, and could cover
  // the broadcast action. Scene captions and event callouts remain in their
  // dedicated safe zones below.
  // A full recap can have many simultaneous overlay inputs. Bound FFmpeg's
  // filter graph workers so each branch does not allocate its own large frame
  // queue at scene boundaries on a memory-limited cloud worker.
  const segmentedSource = settings.editStyle === "complete_highlights"
    && (narrationOnly || settings.originalAudio === "muted");
  const args = ["-hide_banner", "-y", "-filter_complex_threads", "1", "-threads", "2"];
  const sceneSourceInputs = new Map();
  if (segmentedSource) {
    // One shared decoder feeding many trims can retain frames across distant
    // broadcast timestamps until a concat reaches the next scene. Seek each
    // selected action independently so decoder queues stay bounded to that
    // action, not the entire uploaded match.
    for (const [index, moment] of selected.entries()) {
      sceneSourceInputs.set(index, inputCount(args));
      const split=splitSceneInput(moment,settings.sourceSceneDirectory || resolve(dirname(outputPath),'source-scenes'));
      args.push("-ss", (split?.startTime??moment.startTime).toFixed(3), "-t", Math.max(0.1, moment.endTime - moment.startTime).toFixed(3), "-i", split?.path||sourcePath);
    }
  } else args.push("-i", sourcePath);
  const brandWatermarkPath = resolveSetting(process.env.BRAND_WATERMARK_PATH || resolve(projectRoot, "assets/channels4_profile.jpg"));
  const brandWatermarkInputIndex = inputCount(args);
  args.push("-loop", "1", "-i", brandWatermarkPath);
  let stadiumAudioInputIndex = null;
  if (stadiumAudioPath && !narrationOnly) {
    stadiumAudioInputIndex = inputCount(args);
    args.push("-i", stadiumAudioPath);
  }
  const globalNarrationPath = ttsFiles.get("__narration__");
  let globalNarrationInputIndex = null;
  if (globalNarrationPath) {
    globalNarrationInputIndex = inputCount(args);
    args.push("-i", globalNarrationPath);
  }
  const ttsInputs = new Map();
  if (!globalNarrationPath) for (const moment of selected) {
    const speech = ttsFiles.get(moment.id);
    if (speech) {
      ttsInputs.set(moment.id, inputCount(args));
      args.push("-i", speech);
    }
  }
  const annotationInputs = new Map();
  const tacticalInputs = new Map();
  const motionTacticalInputs = new Map();
  const tacticalReport = [];
  const motionTacticalReport = [];
  const tacticalDirectory = resolve(dirname(outputPath), "tactical");
  await mkdir(tacticalDirectory, {recursive:true});
  if (settings.playerHighlight) for (const [index, moment] of selected.entries()) {
    const freezeDrawing = moment.effect === "freeze_analysis" && ["ball", "run", "pass", "map"].includes(moment.tacticalDrawing);
    const movingPass = settings.editStyle === "complete_highlights" && moment.tacticalDrawing === "pass";
    if (!freezeDrawing && !movingPass) continue;
    const evidence = trackingForMoment(tracking, moment);
    if (!evidence) continue;
    const rate = playbackRateFor(moment);
    let freeze = freezePlan(moment, rate, moment.endTime - moment.startTime);
    const evidencePath = resolve(tacticalDirectory, `${index}.json`);
    await writeFile(evidencePath, JSON.stringify(evidence));
    let staticReport = null;
    if (freezeDrawing) {
      const isMap = moment.tacticalDrawing === "map";
      staticReport = JSON.parse(await run(resolveExecutable(process.env.TRACKING_PYTHON || "./.venv-tracking/Scripts/python.exe"), [
        resolve(projectRoot,isMap ? "local-processor/pitch-map.py" : "local-processor/tactical-overlay.py"), "--source",sourcePath,"--evidence",evidencePath,
        "--time",String(moment.startTime + freeze.outputTime * rate),
        ...(isMap ? ["--model",resolveExecutable(process.env.TRACKING_PITCH_MODEL || "./tools/tracking/yolo-football-pitch-detection.pt")] : ["--kind",moment.tacticalDrawing]),
        "--width",String(outputWidth),"--height",String(outputHeight),
        ...(settings.aspectRatio === "16:9" ? ["--native-landscape"] : []),
        "--output",resolve(tacticalDirectory,`${index}.png`),
      ]));
      tacticalReport.push({momentId:moment.id,...staticReport});
      if (staticReport.approved) {
        if (moment.tacticalDrawing === "pass" && Number.isFinite(Number(staticReport.sourceTime))) {
          moment.trackingBrief = { ...(moment.trackingBrief || {}), originTime: Number(staticReport.sourceTime) };
          freeze = freezePlan(moment, rate, moment.endTime - moment.startTime);
        }
        const stageInputIndices = Array.isArray(staticReport.stages) && staticReport.stages.length === 3
          ? staticReport.stages.map(stagePath => {
              const stageInputIndex = inputCount(args);
              args.push("-loop","1","-framerate","30","-i",stagePath);
              return stageInputIndex;
            })
          : [];
        if (stageInputIndices.length) {
          tacticalInputs.set(index,{stageInputIndices,freeze,isMap:false});
        } else {
          const inputIndex = inputCount(args);
          args.push("-loop","1","-framerate","30","-i",staticReport.path);
          tacticalInputs.set(index,{inputIndex,freeze,isMap});
        }
      }
    }
    if (movingPass) {
      const requestedTime = Number(staticReport?.sourceTime ?? moment.trackingBrief?.originTime ?? moment.startTime + (moment.endTime - moment.startTime) / 2);
      const motionReport = JSON.parse(await run(resolveExecutable(process.env.TRACKING_PYTHON || "./.venv-tracking/Scripts/python.exe"), [
        resolve(projectRoot,"local-processor/moving-tactical-overlay.py"), "--evidence",evidencePath,
        "--time",String(requestedTime),
        "--width",String(outputWidth),"--height",String(outputHeight),
        ...(settings.aspectRatio === "16:9" ? ["--native-landscape"] : []),
        "--output-dir",resolve(tacticalDirectory,`motion-${index}`),
      ]));
      motionTacticalReport.push({momentId:moment.id,...motionReport});
      if (motionReport.approved) {
        const inputIndex = inputCount(args);
        args.push("-framerate","30","-start_number","0","-i",motionReport.pattern);
        motionTacticalInputs.set(index,{
          inputIndex,
          sourceStartTime:Number(motionReport.sourceStartTime),
          duration:Number(motionReport.duration),
        });
      } else if (freezeDrawing) {
        // A plausible still frame is not enough to identify a passer and
        // receiver. If their identities cannot survive the live sequence,
        // suppress the static network too instead of circling nearby players.
        tacticalInputs.delete(index);
      }
    }
  }
  await writeFile(resolve(tacticalDirectory,"report.json"),JSON.stringify(tacticalReport,null,2));
  await writeFile(resolve(tacticalDirectory,"motion-report.json"),JSON.stringify(motionTacticalReport,null,2));
  if (settings.playerHighlight) for (const [index, moment] of selected.entries()) {
    const trackedMoment = trackingForMoment(tracking, moment);
    const analysisKeyframes = activePlayerOverlayFrames(moment, trackedMoment?.keyframes || []);
    const annotation = analysisAnnotationForMoment(moment, trackedMoment?.annotation, analysisKeyframes);
    const reaction = moment.eventType === "celebration" || moment.storyPhase === "reaction" || moment.role === "reaction";
    const style = ["viral_reel", "complete_highlights"].includes(settings.editStyle) || moment.effect === "freeze_analysis" ? "ring" : "arrow";
    const markerPath = tracking?.markerPaths?.[style];
    const verifiedAction = /^(?:phase|native_frame)_verified_(?:goal|action)$/.test(String(moment.trackingDecision || ""))
      || moment.trackingDecision === "hybrid_crop_verified";
    const minimumMarkerConfidence = verifiedAction ? 0.65 : 0.85;
    const playerEligible = !reaction
      && moment.playerHighlight !== false
      && annotation?.style !== "none"
      && Number(annotation?.confidence) >= minimumMarkerConfidence
      && markerPath;
    if (playerEligible) {
      const inputIndex = inputCount(args);
      args.push("-loop", "1", "-framerate", "30", "-i", markerPath);
      const label = verifiedPlayerLabel(moment);
      let labelPath = null;
      if (label) {
        labelPath = resolve(tacticalDirectory, `player-label-${index}.txt`);
        await writeFile(labelPath, label);
      }
      annotationInputs.set(index, { inputIndex, annotation, style, analysisKeyframes, labelPath });
    }

  }

  const filters = [];
  const useOriginalAudio = !narrationOnly && !stadiumAudioPath && media.hasAudio && settings.originalAudio !== "muted" && (!settings.commentary || settings.editStyle === "viral_reel");
  const gain = settings.editStyle === "viral_reel" && settings.commentary ? 0.20 : settings.originalAudio === "reduced" ? 0.28 : 1;
  const masks = settings.logoMasking ? sourceMaskFilters(effectiveOverlayMasks(overlayMasks, { ...settings, broadcastUiMasking: settings.broadcastUiMasking !== false }), media) : [];
  const masking = masks.length ? `${masks.join(",")},` : "";
  const clipDurations = [];
  const framingReport = [];
  const clipStarts = [0];
  const first = selected[0];
  const firstRate = playbackRateFor(first);
  const firstPayoff = verifiedPayoffWindow(first, trackingForMoment(tracking, first), firstRate, freezePlan(first, firstRate, first.endTime - first.startTime));
  // Complete recaps already contain one live action and at most one replay.
  // Do not prepend a third payoff excerpt from the same incident.
  const teaserEnabled = !["viral_reel", "complete_highlights"].includes(settings.editStyle) && settings.durationMode === "auto" && !first.isReplay
    && ["goal", "shot_on_target", "shot_off_target", "save", "big_chance"].includes(first.eventType)
    && Boolean(firstPayoff);
  const teaserDuration = teaserEnabled ? Math.min(0.8, firstPayoff.end - firstPayoff.start) : 0;
  const teaserCaptionPath = resolve(dirname(outputPath), "hook.ass");
  if (teaserEnabled && settings.captions) await writeFile(teaserCaptionPath, captionAss([{ text: "HOW DID THAT HAPPEN?", start: 0, end: teaserDuration }], 400, outputWidth, outputHeight));

  selected.forEach((moment, index) => {
    const nativeLandscape = settings.aspectRatio === "16:9";
    const sourceLength = Math.max(0.1, moment.endTime - moment.startTime);
    const playbackRate = playbackRateFor(moment);
    const freeze = freezePlan(moment, playbackRate, sourceLength);
    const eventCue = eventCueWindow(moment, playbackRate, freeze, sourceLength);
    const annotationInput = annotationInputs.get(index);
    const cueDuration = 0;
    const baseOutputLength = sourceLength / playbackRate + freeze.frames / 30;
    const speechDuration = Number(ttsFiles.durations?.get(moment.id) || 0);
    const narrationDelay = speechDuration > 0 ? clamp(Number(moment.narrationDelay || 0), 0, Math.max(0, baseOutputLength - speechDuration - 0.12)) : 0;
    if (speechDuration > baseOutputLength + 0.35) throw new Error(`Narration for ${moment.id} is longer than its complete scene. Rewrite it more concisely instead of freezing the ending.`);
    if (speechDuration + narrationDelay > baseOutputLength + 0.35) throw new Error(`Narration for ${moment.id} is longer than its complete scene. Rewrite it more concisely instead of freezing the ending.`);
    // Every concat branch must share the SAME whole-frame endpoint. Keeping
    // fractional audio durations alongside rounded video frames accumulated
    // extra ticks at each cut and made the writer's timeline too short.
    const outputLength = Math.ceil(Math.max(baseOutputLength, speechDuration > 0 ? speechDuration + narrationDelay + 0.16 : 0) * 30 - 1e-8) / 30;
    clipDurations.push(outputLength);

    const fallbackX = clamp(moment.recommendedCrop?.[0]?.x ?? 0.5, 0, 1);
    const trackedMoment = trackingForMoment(tracking, moment);
    const landscapeZoom = nativeLandscape ? safeLandscapeZoom(trackedMoment?.keyframes, outputWidth, outputHeight) : { zoom: 1, centerX: 0.5, centerY: 0.5, reason: "not_landscape" };
    framingReport.push({ momentId: moment.id, ...landscapeZoom });
    const sourceContain=moment.fallbackPresentation?.mode==='source_contain';
    if (sourceContain || trackedMoment?.layoutMode === 'source_contain')
      throw new Error(`Scene ${moment.id} needs a verified full-screen 9:16 crop before rendering.`);
    const cameraKeyframes = usesSafeStaticPresentation(moment) ? [] : trackedMoment?.keyframes || [];
    const keyframes = retimeKeyframes(cameraKeyframes, playbackRate, freeze);
    // Cropping happens before speed changes and freezes. Its clock must remain
    // source-local; only overlays/captions use the retimed output clock.
    // Complete 16:9 analysis never chases detections frame by frame. Tracking
    // verifies a single safe scene crop below; otherwise the full view stays.
    const cameraX = nativeLandscape ? "0.5" : keyframeExpression(cameraKeyframes, "cameraX", fallbackX);
    const cameraY = nativeLandscape ? "0.5" : keyframeExpression(cameraKeyframes, "cameraY", 0.5);
    // Keep scale fixed for the whole source shot. The crop itself is genuine
    // full-bleed 9:16; only its horizontal position may change.
    const sceneZoom = 1;
    const nativeVerifiedAction = /^native_frame_verified_(?:goal|action)$/.test(String(moment.trackingDecision || ""));
    const suppressPayoffAccent = usesSafeStaticPresentation(moment) && !nativeVerifiedAction;
    const verifiedPayoff = suppressPayoffAccent ? null : verifiedPayoffWindow(moment, trackedMoment, playbackRate, freeze);
    const sourcePayoff = suppressPayoffAccent ? null : (verifiedPayoffWindow(moment, trackedMoment) || nativePayoffWindow(moment, sourceLength));
    const sourcePrefix = segmentedSource
      ? `[${sceneSourceInputs.get(index)}:v]trim=duration=${sourceLength.toFixed(3)},setpts=PTS-STARTPTS,${masking}`
      : `[0:v]trim=start=${moment.startTime.toFixed(3)}:duration=${sourceLength.toFixed(3)},setpts=PTS-STARTPTS,${masking}`;
    const targetRatio = outputWidth / outputHeight;
    const crop = media.width / media.height >= targetRatio
      ? `crop=ih*${targetRatio.toFixed(8)}/${sceneZoom.toFixed(4)}:ih/${sceneZoom.toFixed(4)}:x='max(0,min(iw-ow,iw*(${cameraX})-ow/2))':y='max(0,min(ih-oh,ih*(${cameraY})-oh/2))'`
      : `crop=iw/${sceneZoom.toFixed(4)}:iw/${targetRatio.toFixed(8)}/${sceneZoom.toFixed(4)}:x='max(0,min(iw-ow,iw*(${cameraX})-ow/2))':y='max(0,min(ih-oh,ih*(${cameraY})-oh/2))'`;
    const freezeFilter = freeze.duration > 0
      ? `,loop=loop=${freeze.frames}:size=1:start=${freeze.frame},setpts=N/(30*TB)`
      : "";
    const entryTreatment = sceneEntryTransition(moment, index, outputLength, settings);
    filters.push(`${sourcePrefix}${crop},scale=${outputWidth}:${outputHeight}:flags=lanczos,setsar=1${visualEffectFilter(moment, settings.intensity, Boolean(annotationInput), sourcePayoff)},setpts=PTS/${playbackRate.toFixed(5)},fps=30${freezeFilter},settb=AVTB${entryTreatment.filter},format=yuv420p[baseclip${index}]`);
    if (index === 0 && teaserEnabled) {
      filters[filters.length - 1] = filters[filters.length - 1].replace("[baseclip0]", "[hookSource]");
      filters.push("[hookSource]split=2[baseclip0][hookCopy]");
      const hookStart = firstPayoff.start;
      const hookText = settings.captions ? `,ass=filename='${escapeFilterPath(teaserCaptionPath)}'` : "";
      filters.push(`[hookCopy]trim=start=${hookStart.toFixed(3)}:duration=${teaserDuration},setpts=PTS-STARTPTS${hookText}[hookVideo]`);
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${teaserDuration},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[hookAudio]`);
    }

    let tacticalBaseLabel = `playerclip${index}`;
    if (annotationInput) {
      const { inputIndex, annotation, style, analysisKeyframes, labelPath } = annotationInput;
      const ring = style === "ring";
      const playerAnchorX = ring ? 160 : 80;
      const playerAnchorY = ring ? 160 : 176;
      const playerYField = ring ? "playerCenterY" : "playerTopY";
      const overlayKeyframes = retimeKeyframes(analysisKeyframes, playbackRate, freeze);
      const playerCenterX = keyframeExpression(overlayKeyframes, "playerCenterX", Number(annotation.x) + playerAnchorX);
      const playerAnchorPositionY = keyframeExpression(overlayKeyframes, playerYField, Number(annotation.y) + playerAnchorY);
      const playerVisible = visibilityExpression(overlayKeyframes, "analysisMarkerVisible");
      const visibleWindow = analysisOverlayWindow(overlayKeyframes, baseOutputLength);
      const cueTime = visibleWindow.start;
      const cueEnd = visibleWindow.end;
      filters.push(`[${inputIndex}:v]format=rgba[playerAsset${index}]`);
      filters.push(`[baseclip${index}][playerAsset${index}]overlay=x='(${playerCenterX})-${playerAnchorX}':y='(${playerAnchorPositionY})-${playerAnchorY}':enable='between(t,${cueTime.toFixed(3)},${cueEnd.toFixed(3)})*${playerVisible}':eval=frame:eof_action=repeat:shortest=1[playerclip${index}]`);
      if (labelPath) {
        const playerFont = escapeFilterPath(resolveSetting(process.env.PLAYER_FONT_PATH || "C:/Windows/Fonts/arialbd.ttf"));
        filters.push(`[playerclip${index}]drawtext=fontfile='${playerFont}':textfile='${escapeFilterPath(labelPath)}':fontcolor=white:fontsize=42:borderw=5:bordercolor=black@0.92:box=1:boxcolor=black@0.48:boxborderw=12:x='max(12,min(w-text_w-12,(${playerCenterX})-text_w/2))':y='max(12,(${playerAnchorPositionY})-${playerAnchorY}-66)':enable='between(t,${cueTime.toFixed(3)},${cueEnd.toFixed(3)})*${playerVisible}'[namedplayerclip${index}]`);
        tacticalBaseLabel = `namedplayerclip${index}`;
      }
    } else {
      filters.push(`[baseclip${index}]null[playerclip${index}]`);
    }
    if (motionTacticalInputs.has(index)) {
      const motion = motionTacticalInputs.get(index);
      const motionStart = Math.max(0, (motion.sourceStartTime - moment.startTime) / playbackRate);
      const motionDuration = Math.max(.1, motion.duration / playbackRate);
      const fadeOutStart = Math.max(.01, motionDuration - .12);
      filters.push(`[${motion.inputIndex}:v]format=rgba,fade=t=in:st=0:d=0.12:alpha=1,fade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.12:alpha=1,setpts=PTS/${playbackRate.toFixed(5)}+${motionStart.toFixed(3)}/TB[motionTacticalAsset${index}]`);
      filters.push(`[${tacticalBaseLabel}][motionTacticalAsset${index}]overlay=0:0:eof_action=pass:shortest=0[motionclip${index}]`);
      tacticalBaseLabel = `motionclip${index}`;
    }

    if (tacticalInputs.has(index)) {
      const tactical = tacticalInputs.get(index);
      const begin = tactical.freeze.outputTime, end = begin + tactical.freeze.duration;
      if (tactical.stageInputIndices?.length === 3) {
        const stageBoundaries = [begin, begin + tactical.freeze.duration * .28, begin + tactical.freeze.duration * .58, end];
        let tacticalBase = tacticalBaseLabel;
        tactical.stageInputIndices.forEach((inputIndex, stageIndex) => {
          const asset = `tacticalAsset${index}_${stageIndex}`;
          const output = `tacticalStage${index}_${stageIndex}`;
          filters.push(`[${inputIndex}:v]format=rgba[${asset}]`);
          filters.push(`[${tacticalBase}][${asset}]overlay=0:0:enable='between(t,${stageBoundaries[stageIndex].toFixed(3)},${stageBoundaries[stageIndex + 1].toFixed(3)})':eof_action=repeat:shortest=1[${output}]`);
          tacticalBase = output;
        });
        filters.push(`[${tacticalBase}]null[clip${index}]`);
      } else {
        filters.push(`[${tactical.inputIndex}:v]${tactical.isMap ? "scale=720:-2," : ""}format=rgba[tacticalAsset${index}]`);
        const mapY = outputHeight >= 1350 ? 180 : 90;
        filters.push(`[${tacticalBaseLabel}][tacticalAsset${index}]overlay=${tactical.isMap ? `(W-w)/2:${mapY}` : "0:0"}:enable='between(t,${begin.toFixed(3)},${end.toFixed(3)})':shortest=1[clip${index}]`);
      }
    } else filters.push(`[${tacticalBaseLabel}]null[clip${index}]`);

    const extensionDuration = Math.max(0, outputLength - baseOutputLength);
    let captionLabel = `clip${index}`;
    if (landscapeZoom.zoom > 1) {
      const cropHeight = Math.floor(outputHeight / landscapeZoom.zoom / 2) * 2;
      const cropWidth = Math.floor(outputWidth / landscapeZoom.zoom / 2) * 2;
      const cropX = Math.round(outputWidth * landscapeZoom.centerX - cropWidth / 2);
      const cropY = Math.round(outputHeight * landscapeZoom.centerY - cropHeight / 2);
      filters.push(`[clip${index}]crop=${cropWidth}:${cropHeight}:${cropX}:${cropY},scale=${outputWidth}:${outputHeight}:flags=lanczos[framedClip${index}]`);
      captionLabel = `framedClip${index}`;
    }
    if (extensionDuration > 0.01) {
      filters.push(`[${captionLabel}]tpad=stop_mode=clone:stop_duration=${extensionDuration.toFixed(3)},trim=duration=${outputLength.toFixed(3)}[timedclip${index}]`);
      captionLabel = `timedclip${index}`;
    }
    const cues = captionCues.get(moment.id) || [];
    if (cues[0]?.assPath) {
      filters.push(`[${captionLabel}]ass=filename='${escapeFilterPath(cues[0].assPath)}'[sparseCaption${index}]`);
      captionLabel = `sparseCaption${index}`;
    }
    for (const [cueIndex, cue] of cues.entries()) {
      if (cue.assPath) continue;
      const nextLabel = `caption${index}_${cueIndex}`;
      const captionFont = escapeFilterPath(resolveSetting(process.env.CAPTION_FONT_PATH || "C:/Windows/Fonts/arialbd.ttf"));
      const color = "white";
      const start = cue.start.toFixed(3);
      const end = cue.end.toFixed(3);
      const progress = `min(1,max(0,(t-${start})/0.16))`;
      const alpha = `if(lt(t,${start}),0,if(lt(t,${start}+0.16),(t-${start})/0.16,if(gt(t,${end}-0.12),max(0,((${end})-t)/0.12),1)))`;
      filters.push(`[${captionLabel}]drawtext=fontfile='${captionFont}':textfile='${escapeFilterPath(cue.path)}':fontcolor=${color}:fontsize='${cue.fontSize}*(0.92+0.08*${progress})':borderw=7:bordercolor=black@0.92:shadowx=3:shadowy=4:shadowcolor=black@0.65:alpha='${alpha}':x=(w-text_w)/2:y='${cue.y}+18*(1-${progress})':enable='between(t,${start},${end})'[${nextLabel}]`);
      captionLabel = nextLabel;
    }
    const calloutPath = calloutFiles.get(moment.id);
    if (calloutPath) {
      const eventFont = escapeFilterPath(resolveSetting(process.env.EVENT_FONT_PATH || "C:/Windows/Fonts/seguisym.ttf"));
      const color = eventCalloutColor(moment);
      const calloutStart = eventCue.start.toFixed(3);
      const calloutEnd = eventCue.end.toFixed(3);
      const calloutProgress = `min(1,max(0,(t-${calloutStart})/0.14))`;
      filters.push(`[${captionLabel}]drawtext=fontfile='${eventFont}':textfile='${escapeFilterPath(calloutPath)}':fontcolor=${color}:fontsize='68*(0.88+0.12*${calloutProgress})':borderw=5:bordercolor=black@0.92:shadowx=3:shadowy=4:shadowcolor=black@0.65:alpha='min(1,max(0,(t-${calloutStart})/0.12))*min(1,max(0,((${calloutEnd})-t)/0.12))':x=(w-text_w)/2:y='250+16*(1-${calloutProgress})':enable='between(t,${calloutStart},${calloutEnd})',setsar=1,trim=duration=${outputLength.toFixed(6)},setpts=N/(30*TB)[v${index}]`);
    } else {
      filters.push(`[${captionLabel}]setsar=1,trim=duration=${outputLength.toFixed(6)},setpts=N/(30*TB)[v${index}]`);
    }
    const speechIndex = ttsInputs.get(moment.id);
    if (speechIndex !== undefined) {
      filters.push(`[${speechIndex}:a]aresample=48000,volume=1,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=${delayValue(narrationDelay)},apad,atrim=duration=${outputLength.toFixed(3)}[speech${index}]`);
      if (useOriginalAudio) {
        filters.push(`[0:a]atrim=start=${moment.startTime.toFixed(3)}:duration=${sourceLength.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,atempo=${playbackRate.toFixed(5)},volume=${gain.toFixed(2)},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=${delayValue(cueDuration)},apad,atrim=duration=${outputLength.toFixed(3)}[delayedBase${index}]`);
        filters.push(`[delayedBase${index}][speech${index}]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[abase${index}]`);
      } else {
        filters.push(`[speech${index}]anull[abase${index}]`);
      }
    } else if (useOriginalAudio) {
      filters.push(`[0:a]atrim=start=${moment.startTime.toFixed(3)}:duration=${sourceLength.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,atempo=${playbackRate.toFixed(5)},volume=${gain.toFixed(2)},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=${delayValue(cueDuration)},apad,atrim=duration=${outputLength.toFixed(3)}[abase${index}]`);
    } else {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${outputLength.toFixed(3)},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[abase${index}]`);
    }
    const outcomeEvent = ["goal", "shot_on_target", "shot_off_target", "save", "big_chance"].includes(moment.eventType);
    const verifiedOutcomeCue = Boolean(verifiedPayoff || nativeVerifiedAction);
    const soundEffect = outcomeEvent && !verifiedOutcomeCue ? null : soundEffectSource(moment, index, outputLength, verifiedPayoff?.start ?? eventCue.start);
    if (soundEffect) {
      filters.push(soundEffect);
      filters.push(`[abase${index}][sfx${index}]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.96[a${index}]`);
    } else {
      filters.push(`[abase${index}]anull[a${index}]`);
    }
  });

  await writeFile(resolve(dirname(outputPath), "framing-report.json"), JSON.stringify(framingReport, null, 2));

  let timelineDuration = clipDurations[0] || 0;
  if (selected.length === 1) {
    filters.push("[v0]null[outvBase]");
    filters.push("[a0]anull[outaUnpadded]");
  } else {
    let videoLabel = "v0";
    let audioLabel = "a0";
    let accumulated = clipDurations[0];
    for (let index = 1; index < selected.length; index += 1) {
      // Complete the current football action before revealing the next source
      // shot. Cross-zoom/whip/fade overlaps make the next camera angle and
      // scale appear before the previous payoff has finished. Scene-local
      // effects remain available, but edit boundaries are frame-exact cuts.
      clipStarts[index] = accumulated;
      filters.push(`[${videoLabel}][${audioLabel}][v${index}][a${index}]concat=n=2:v=1:a=1[vx${index}][ax${index}]`);
      accumulated += clipDurations[index];
      videoLabel = `vx${index}`;
      audioLabel = `ax${index}`;
    }
    timelineDuration = accumulated;
    filters.push(`[${videoLabel}]null[outvBase]`);
    filters.push(`[${audioLabel}]anull[outaUnpadded]`);
  }
  const requestedDuration = settings.editStyle === "complete_highlights" || settings.durationMode === "auto"
    ? timelineDuration
    : Math.max(timelineDuration, Number(settings.targetDuration || timelineDuration));
  const endingPad = Math.max(0, requestedDuration - timelineDuration);
  if (endingPad > 0.01) {
    filters.push(`[outvBase]tpad=stop_mode=clone:stop_duration=${endingPad.toFixed(3)},trim=duration=${requestedDuration.toFixed(3)}[outv]`);
    filters.push(`[outaUnpadded]apad,atrim=duration=${requestedDuration.toFixed(3)}[outaBase]`);
    timelineDuration = requestedDuration;
  } else {
    filters.push("[outvBase]null[outv]");
    filters.push("[outaUnpadded]anull[outaBase]");
  }
  let finalAudioBase = "outaBase";
  if (stadiumAudioInputIndex !== null) {
    filters.push(`[${stadiumAudioInputIndex}:a]aresample=48000,volume=0.30,apad,atrim=duration=${timelineDuration.toFixed(3)},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[stadiumBed]`);
    filters.push("[outaBase][stadiumBed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.96[outaWithStadium]");
    finalAudioBase = "outaWithStadium";
  }
  if (settings.editStyle === "complete_highlights" && settings.commentary) {
    // A fully synthetic, low-level pulse/texture bed avoids importing music
    // with unknown rights. It remains deliberately quiet beneath narration.
    filters.push(`aevalsrc=exprs='0.020*sin(2*PI*55*t)*exp(-8*mod(t\\,2))+0.010*sin(2*PI*82.41*t)*exp(-6*mod(t\\,4))':s=48000:d=${timelineDuration.toFixed(3)},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[analysisPulse]`);
    filters.push(`anoisesrc=color=pink:amplitude=0.025:duration=${timelineDuration.toFixed(3)}:sample_rate=48000,highpass=f=70,lowpass=f=700,volume=0.035,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[analysisTexture]`);
    filters.push(`[${finalAudioBase}][analysisPulse][analysisTexture]amix=inputs=3:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.92[outaWithAnalysisBed]`);
    finalAudioBase = "outaWithAnalysisBed";
  }
  if (globalNarrationInputIndex !== null) {
    const narrationDuration = Number(ttsFiles.narrationDuration || timelineDuration);
    // Preserve the energetic TTS performance. Script generation is responsible
    // for filling the locked timeline; rendering permits only subtle correction.
    const tempo = clamp(narrationDuration / Math.max(0.1, timelineDuration), 0.94, 1.10);
    filters.push(`[${globalNarrationInputIndex}:a]aresample=48000,atempo=${tempo.toFixed(5)},apad,atrim=duration=${timelineDuration.toFixed(3)},volume=1,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[narration]`);
    filters.push(`[${finalAudioBase}][narration]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.96[outa]`);
  } else {
    filters.push(`[${finalAudioBase}]anull[outa]`);
  }

  if (teaserEnabled) {
    for (let index = 0; index < filters.length; index += 1) {
      filters[index] = filters[index].replaceAll("[outv]", "[storyVideo]").replaceAll("[outa]", "[storyAudio]");
    }
    filters.push("[hookVideo][hookAudio][storyVideo][storyAudio]concat=n=2:v=1:a=1[outv][outa]");
    timelineDuration += teaserDuration;
  }
  const watermarkWidth = settings.aspectRatio === "16:9" ? 220 : 180;
  const watermarkMargin = settings.aspectRatio === "16:9" ? 32 : 28;
  const headerTitlePath = resolve(dirname(outputPath), "match-result-header.txt");
  const firstHeaderTeam = settings.headerFirstTeam || matchContext?.homeTeam;
  const headerTitle = portraitMatchResultTitle(matchContext,firstHeaderTeam);
  if (headerTitle) await writeFile(headerTitlePath, portraitMatchResultScore(matchContext,firstHeaderTeam), "utf8");
  const headerEnabled=settings.__renderChunkPart !== true
    && Boolean(portraitBroadcastHeaderFilters(settings,outputWidth,outputHeight,matchContext,headerTitlePath,firstHeaderTeam));
  const headerBadgeInputs={};
  if(headerEnabled && headerTitle){
    const badges=await prepareMatchTeamBadges(matchContext,resolve(dirname(outputPath),'team-badges'));
    for(const side of ['home','away'])if(badges[side]){
      headerBadgeInputs[side]=inputCount(args);args.push('-loop','1','-framerate','30','-i',badges[side].path);
    }
  }
  const headerPlan=portraitBroadcastHeaderPlan(settings,outputWidth,outputHeight,matchContext,headerTitlePath,
    {firstTeam:firstHeaderTeam,badgeInputs:headerBadgeInputs});
  const brandedVideoSource=headerPlan.length ? "headerCleanVideo" : "outv";
  filters.push(...headerPlan);
  filters.push(`[${brandWatermarkInputIndex}:v]scale=${watermarkWidth}:-1:flags=lanczos,format=rgba,colorkey=0x25262A:0.08:0.035,colorchannelmixer=aa=0.86[goalVisionBrand]`);
  filters.push(`[${brandedVideoSource}][goalVisionBrand]overlay=x=W-w-${watermarkMargin}:y=H-h-${watermarkMargin}:eval=init:eof_action=repeat:shortest=1,setsar=1[brandedv]`);
  const synchronization = globalNarrationPath ? [{
    beatId: "__narration__",
    momentId: "__continuous_master__",
    narration: ttsFiles.narrationScript || "Continuous narration",
    visualStart: Number(teaserDuration.toFixed(3)),
    visualDuration: Number(timelineDuration.toFixed(3)),
    speechDuration: Number(timelineDuration.toFixed(3)),
  }] : selected.map((moment, index) => ({
    beatId: moment.beatId || null,
    momentId: moment.id,
    narration: moment.commentary || null,
    visualStart: Number(((clipStarts[index] || 0) + teaserDuration).toFixed(3)),
    visualDuration: Number(clipDurations[index].toFixed(3)),
    speechDuration: Number((Number(ttsFiles.durations?.get(moment.id) || 0) + Number(moment.narrationDelay || 0)).toFixed(3)),
  }));  const syncProblems = settings.commentary ? synchronizationProblems(synchronization) : [];
  if (syncProblems.length) throw new Error(`Narration/visual synchronization validation failed: ${syncProblems.join(", ")}`);
  await writeFile(resolve(dirname(outputPath), "synchronization.json"), JSON.stringify({
    version: 1,
    timelineDuration: Number(timelineDuration.toFixed(3)),
    beats: synchronization,
  }, null, 2));
  const filterScriptPath = resolve(dirname(outputPath), "filtergraph-v2.txt");
  await writeFile(filterScriptPath, filters.join(";\n"));
  const premixPath = resolve(dirname(outputPath), "premix.mp4");
  const executable = resolveExecutable(process.env.FFMPEG_PATH || "ffmpeg");
  args.push(
    ...await filterGraphFileArgs(executable, filterScriptPath), "-map", "[brandedv]", "-map", "[outa]",
    ...videoEncoderArgs(), "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "48000", "-b:a", "192k", "-movflags", "+faststart", premixPath,
  );
  await run(executable, args);
  const loudness = await normalizeFinishedAudio(premixPath, outputPath);
  return { timelineDuration, synchronization, teaserDuration, loudness };
}

function inputCount(args) {
  return args.filter((item) => item === "-i").length;
}

function trackingForMoment(tracking, moment) {
  const key = String(moment?.trackingSourceId || moment?.id || "");
  return tracking?.moments?.[key] || tracking?.moments?.[moment?.id];
}

function delayValue(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  return `${milliseconds}|${milliseconds}`;
}

function fitSelectedMoments(moments, targetDuration, ttsFiles, tracking) {
  const fixed=fixedRenderSceneQueue(moments);
  if(fixed) return fixed;
  const ordered = moments
    .map(ensureMinimumSelectedDuration)
    .filter((item) => item.selectedForFinalVideo && sceneOutputDuration(item) >= minimumSceneSeconds(item))
    .sort((a, b) => Number(a.editOrder ?? Number.MAX_SAFE_INTEGER) - Number(b.editOrder ?? Number.MAX_SAFE_INTEGER) || a.startTime - b.startTime);
  const estimatedDuration = (moment) => {
    const playbackRate = playbackRateFor(moment);
    const sourceLength = moment.endTime - moment.startTime;
    const sourceDuration = sourceLength / playbackRate + freezePlan(moment, playbackRate, sourceLength).duration;
    const annotation = trackingForMoment(tracking, moment)?.annotation;
    const cueDuration = annotation?.style !== "none" ? clamp(Number(annotation?.duration), 0.45, 0.75) : 0;
    const speechDuration = Number(ttsFiles.durations?.get(moment.id) || 0);
    return Math.max(sourceDuration + cueDuration, speechDuration > 0 ? speechDuration + 0.16 : 0);
  };
  const narrated = ordered.filter((moment) => moment.commentary);
  const chosen = new Map(narrated.map((moment) => [moment.id, moment]));
  let total = narrated.reduce((sum, moment) => sum + estimatedDuration(moment), 0);
  for (const moment of ordered.filter((item) => !item.commentary)) {
    const length = estimatedDuration(moment);
    if (total + length > targetDuration + 3) continue;
    chosen.set(moment.id, moment);
    total += length;
  }
  return ordered.flatMap((moment) => chosen.has(moment.id) ? [chosen.get(moment.id)] : []);
}

function ensureMinimumSelectedDuration(moment) {
  if (moment.selectionLocked === true && moment.fixedSceneQueueVersion === 1) return moment;
  if (!moment.selectedForFinalVideo) return moment;
  const minimum = minimumSceneSeconds(moment);
  if (sceneOutputDuration(moment) >= minimum) return moment;
  const sourceLength = Number(moment.endTime) - Number(moment.startTime);
  const decisive = ["goal", "disallowed_goal", "save", "shot_on_target", "shot_off_target", "big_chance"].includes(moment.eventType);
  if (!(sourceLength > 0) || !decisive) return moment;
  const freezeDuration = moment.effect === "freeze_analysis"
    ? clamp(Number(moment.freezeDuration || 0.65), 0.4, 1) : 0;
  const playbackRate = clamp(sourceLength / Math.max(0.1, minimum - freezeDuration), 0.72, playbackRateUpper(moment));
  return { ...moment, playbackRate: Math.min(Number(moment.playbackRate || 1), playbackRate) };
}
function sceneOutputDuration(moment) {
  const playbackRate = playbackRateFor(moment);
  const sourceLength = moment.endTime - moment.startTime;
  return sourceLength / playbackRate + freezePlan(moment, playbackRate, sourceLength).duration;
}

function minimumSceneSeconds() {
  return MIN_SCENE_SECONDS;
}
function playbackRateUpper(moment) {
  return moment?.completeActionCompressed ? COMPLETE_HIGHLIGHT_MAX_PLAYBACK_RATE : 1.18;
}
function playbackRateFor(moment) {
  if (moment?.selectionLocked === true && moment?.fixedSceneQueueVersion === 1) return 1;
  return clamp(Number(moment?.playbackRate || 1), 0.72, playbackRateUpper(moment));
}
function freezePlan(moment, playbackRate, sourceLength) {
  if (moment.effect !== "freeze_analysis") return { duration: 0, outputTime: 0, frames: 0, frame: 0 };
  const duration = clamp(Number(moment.freezeDuration || 0.65), 0.4, 1);
  const field = moment.freezeAtPhase === "origin" ? "originTime" : moment.freezeAtPhase === "payoff" ? "payoffStartTime" : "contactTime";
  const absolute = Number(moment.tacticalFreezeSourceTime ?? moment.trackingBrief?.[field]);
  const fallback = moment.freezeAtPhase === "payoff" ? sourceLength * 0.72 : sourceLength * 0.38;
  const sourceTime = clamp(Number.isFinite(absolute) ? absolute - moment.startTime : fallback, 0.2, Math.max(0.2, sourceLength - 0.2));
  const outputTime = sourceTime / playbackRate;
  return {
    duration,
    outputTime,
    frames: Math.max(1, Math.round(duration * 30)),
    frame: Math.max(0, Math.round(outputTime * 30)),
  };
}

function eventCueWindow(moment, playbackRate, freeze, sourceLength) {
  const field = moment.eventType === "goal" || moment.eventCallout === "goal"
    ? "payoffStartTime"
    : ["shot_on_target", "shot_off_target", "save", "big_chance"].includes(String(moment.eventType))
      || ["shot", "save", "close"].includes(String(moment.eventCallout))
      ? "payoffStartTime"
    : ["shot", "save", "foul", "card"].includes(String(moment.eventCallout))
      ? "contactTime"
      : "annotationStartTime";
  const absolute = Number(moment.trackingBrief?.[field]);
  const fallbackRatio = field === "payoffStartTime" ? 0.72 : field === "contactTime" ? 0.38 : 0.12;
  const sourceTime = clamp(Number.isFinite(absolute) ? absolute - moment.startTime : sourceLength * fallbackRatio, 0.08, Math.max(0.08, sourceLength - 0.08));
  let outputTime = sourceTime / playbackRate;
  if (freeze.duration > 0 && outputTime >= freeze.outputTime) outputTime += freeze.duration;
  const duration = moment.eventCallout === "goal" ? 1.25 : 0.95;
  return { start: outputTime, end: outputTime + duration };
}

export function nativePayoffWindow(moment, sourceLength) {
  if (!/^native_frame_verified_(?:goal|action)$/.test(String(moment?.trackingDecision || ""))) return null;
  const start = Number(moment?.trackingBrief?.payoffStartTime) - Number(moment?.startTime);
  const end = Number(moment?.trackingBrief?.payoffEndTime) - Number(moment?.startTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return {
    start: clamp(start, 0, sourceLength),
    end: clamp(end, 0, sourceLength),
  };
}

export function activePlayerOverlayFrames(moment, keyframes) {
  const source = (Array.isArray(keyframes) ? keyframes : []).map((frame) => ({ ...frame }));
  const reaction = moment?.eventType === "celebration"
    || moment?.storyPhase === "reaction"
    || moment?.role === "reaction";
  if (reaction) return source.map((frame) => ({ ...frame, analysisMarkerVisible: 0 }));

  const scorerOnly = ["goal", "disallowed_goal"].includes(String(moment?.eventType));
  const eligible = source.map((frame) => {
    return Number(frame?.markerVisible) >= 0.5
      && frame?.directBall === true
      && frame?.ballInFrame === true
      && frame?.playerInFrame === true
      && Number(frame?.jointFit) >= 0.5
      && Number(frame?.subjectConfidence || 0) >= (scorerOnly ? 0.68 : 0.52)
      && frame?.playerTrackId !== undefined
      && frame?.playerTrackId !== null
      && Number.isFinite(Number(frame?.playerCenterX))
      && Number.isFinite(Number(frame?.playerCenterY));
  });

  // Detector samples arrive roughly every 0.1-0.2 seconds. Require a short
  // sustained run so a one-frame false match cannot flash a ring on an
  // unrelated player; verified possession handoffs remain continuous.
  const visible = Array(source.length).fill(false);
  for (let start = 0; start < eligible.length;) {
    if (!eligible[start]) { start += 1; continue; }
    const trackId = source[start]?.playerTrackId;
    let end = start + 1;
    while (end < eligible.length && eligible[end]
      && source[end]?.playerTrackId === trackId) end += 1;
    if (end - start >= 3) {
      for (let index = start; index < end; index += 1) visible[index] = true;
    }
    start = end;
  }
  const marked = source.map((frame, index) => ({ ...frame, analysisMarkerVisible: visible[index] ? 1 : 0 }));
  let previous = null;
  return marked.map((frame) => {
    if (Number(frame.analysisMarkerVisible) < 0.5) { previous = null; return frame; }
    const trackId = frame.playerTrackId;
    const currentX = Number(frame.playerCenterX);
    const currentY = Number(frame.playerCenterY);
    if (!previous || previous.trackId !== trackId || frame.sceneCut || !Number.isFinite(currentX) || !Number.isFinite(currentY)) {
      previous = { trackId, time: Number(frame.time), x: currentX, y: currentY };
      return frame;
    }
    const elapsed = Math.max(0.02, Number(frame.time) - previous.time);
    const alpha = clamp(elapsed * 5.5, 0.22, 0.62);
    const maximumStep = clamp(elapsed * 480, 16, 58);
    const smoothAxis = (from, to) => {
      const delta = Math.abs(to - from) < 3 ? 0 : (to - from) * alpha;
      return from + clamp(delta, -maximumStep, maximumStep);
    };
    const x = smoothAxis(previous.x, currentX);
    const y = smoothAxis(previous.y, currentY);
    previous = { trackId, time: Number(frame.time), x, y };
    return { ...frame, playerCenterX: x, playerCenterY: y };
  });
}

export function analysisOverlayWindow(keyframes, outputLength = Infinity) {
  const visible = (Array.isArray(keyframes) ? keyframes : [])
    .filter((frame) => Number(frame?.analysisMarkerVisible) >= 0.5 && Number.isFinite(Number(frame?.time)));
  if (!visible.length) return { start: 0, end: 0 };
  const start = Math.max(0, Number(visible[0].time));
  const end = Math.min(Number(outputLength), Math.max(start + 0.1, Number(visible.at(-1).time) + 0.12));
  return { start, end };
}

export function analysisAnnotationForMoment(moment, annotation, keyframes) {
  const visible = (Array.isArray(keyframes) ? keyframes : [])
    .filter((frame) => Number(frame?.analysisMarkerVisible) >= 0.5);
  if (!visible.length) return { style: "none", confidence: 0, duration: 0 };
  const first = visible[0];
  const confidences = visible.map((frame) => Number(frame?.subjectConfidence || 0)).sort((a, b) => a - b);
  const confidence = confidences.length ? confidences[Math.floor(confidences.length / 2)] : 0;
  const supplied = annotation && annotation.style !== "none" ? annotation : {};
  return {
    ...supplied,
    style: "ring",
    confidence: Math.max(Number(supplied.confidence || 0), confidence),
    duration: Math.max(0.1, Number(visible.at(-1).time) - Number(first.time)),
    cueTime: Number(first.time),
    trackDuration: Math.max(0.1, Number(visible.at(-1).time) - Number(first.time) + 0.12),
    x: Number.isFinite(Number(supplied.x)) ? Number(supplied.x) : Number(first.playerCenterX) - 160,
    y: Number.isFinite(Number(supplied.y)) ? Number(supplied.y) : Number(first.playerCenterY) - 160,
  };
}

export function verifiedPlayerLabel(moment) {
  if (!["goal", "disallowed_goal"].includes(String(moment?.eventType))) return "";
  const name = String(moment?.verifiedIdentity?.scorer || "").replace(/\s+/g, " ").trim();
  return name.length >= 2 && name.length <= 48 ? name.toLocaleUpperCase("en-US") : "";
}

function retimeKeyframes(keyframes, playbackRate, freeze = { duration: 0, outputTime: 0 }) {
  const scaled = keyframes.map((frame) => ({ ...frame, time: Number(frame.time) / playbackRate }));
  if (!(freeze.duration > 0) || scaled.length === 0) return scaled;
  const anchor = scaled.reduce((best, frame) => (
    Math.abs(frame.time - freeze.outputTime) < Math.abs(best.time - freeze.outputTime) ? frame : best
  ), scaled[0]);
  const shifted = scaled.map((frame) => ({
    ...frame,
    time: frame.time > freeze.outputTime ? frame.time + freeze.duration : frame.time,
  }));
  shifted.push(
    { ...anchor, time: freeze.outputTime },
    { ...anchor, time: freeze.outputTime + freeze.duration },
  );
  return shifted.sort((a, b) => a.time - b.time);
}

export function editorialGrade(moment) {
  const replay = moment?.isReplay || moment?.storyPhase === "replay" || moment?.effect === "replay_treatment";
  if (replay) return "replay_blue";
  if (moment?.eventType === "goal" && !["reaction", "celebration"].includes(String(moment?.storyPhase))) return "goal_gold";
  if (moment?.eventType === "celebration" || moment?.storyPhase === "reaction" || moment?.role === "reaction") return "warm";
  if (["setup", "build_up", "analysis"].includes(String(moment?.role)) || moment?.storyPhase === "build_up") return "cool";
  if (["action", "evidence", "proof", "turn"].includes(String(moment?.role))) return "dramatic";
  if (["consequence", "payoff", "conclusion"].includes(String(moment?.role)) || moment?.storyPhase === "payoff") return "warm";
  const requested = String(moment?.colorGrade || "");
  return ["cool", "clean", "warm", "dramatic", "goal_gold", "replay_blue"].includes(requested) ? requested : "clean";
}

export function sceneEntryTransition(moment, index, outputLength, settings = {}) {
  // A full-frame flash conceals the next action's opening touch and makes the
  // recap appear overexposed. Complete football recaps use exact clean cuts;
  // their scene-local grades, contact freezes and sound accents remain intact.
  if (index === 0 || settings.editStyle === "complete_highlights") return { kind: "cut", duration: 0, filter: "" };
  const requested = clamp(Number(moment?.transitionDuration || 0.10), 0.06, 0.22);
  const duration = Math.min(requested, Math.max(0.06, Number(outputLength || 0) / 8));
  const replay = moment?.isReplay || moment?.storyPhase === "replay" || moment?.effect === "replay_treatment";
  const goalAction = moment?.eventType === "goal" && moment?.storyPhase !== "reaction";
  const kind = replay || moment?.transitionIn === "flash" || goalAction ? "white" : "black";
  return {
    kind,
    duration,
    // This is a scene-local reveal, not an overlap: the preceding football
    // action always reaches its payoff before this scene begins.
    filter: `,fade=t=in:st=0:d=${duration.toFixed(3)}:color=${kind}`,
  };
}

function visualEffectFilter(moment, intensity, annotationActive = false, sourcePayoff = null) {
  const replay = moment.isReplay || moment.storyPhase === "replay" || moment.effect === "replay_treatment";
  const grade = editorialGrade(moment);
  const filters = naturalEditorialGradeFilters(grade);
  if (intensity === "natural" && !["goal_gold", "replay_blue"].includes(grade)) {
    filters.splice(0, filters.length, "eq=saturation=1.08:contrast=1.07:brightness=0.010:gamma=1.01", "unsharp=5:5:0.20:5:5:0");
  }
  // A restrained full-scene exposure shape is present on every included
  // frame. Event-specific grades remain visibly distinct without destroying
  // natural team colours or obscuring the football.
  filters.push("vignette=PI/18");
  if (sourcePayoff && grade === "goal_gold") {
    filters.push(`eq=saturation=1.20:contrast=1.13:brightness=0.026:gamma=1.025:enable='between(t,${sourcePayoff.start.toFixed(3)},${sourcePayoff.end.toFixed(3)})'`);
  } else if (sourcePayoff && ["shot_on_target", "shot_off_target", "save", "big_chance"].includes(String(moment.eventType))) {
    filters.push(`eq=saturation=1.16:contrast=1.12:brightness=0.018:gamma=1.015:enable='between(t,${sourcePayoff.start.toFixed(3)},${sourcePayoff.end.toFixed(3)})'`);
  }
  if (moment.effect === "punch_zoom" && !annotationActive) {
    // Preserve the validated ball/player crop; a decorative zoom can hide them.
  } else if (moment.effect === "slow_motion") {
    filters.push("unsharp=5:5:0.28:5:5:0");
  } else if (moment.effect === "freeze_analysis") {
    const rate = playbackRateFor(moment);
    const freezeAt = freezePlan(moment, rate, moment.endTime - moment.startTime).outputTime * rate;
    filters.push(`eq=saturation=0.72:contrast=1.16:brightness=-0.010:gamma=0.99:enable='between(t,${Math.max(0, freezeAt - 0.05).toFixed(3)},${(freezeAt + 0.05).toFixed(3)})'`, "unsharp=5:5:0.30:5:5:0");
  }
  return "," + filters.join(",");
}

export function naturalEditorialGradeFilters(grade) {
  const grades = {
    clean: ["eq=saturation=1.13:contrast=1.10:brightness=0.014:gamma=1.02", "unsharp=5:5:0.25:5:5:0"],
    cool: ["eq=saturation=1.04:contrast=1.16:brightness=0.006:gamma=1.00", "colorbalance=bs=0.065:bm=0.030:rs=-0.020", "unsharp=5:5:0.27:5:5:0"],
    warm: ["eq=saturation=1.19:contrast=1.14:brightness=0.020:gamma=1.025", "colorbalance=rs=0.060:rm=0.030:bs=-0.022", "unsharp=5:5:0.27:5:5:0"],
    dramatic: ["eq=saturation=1.10:contrast=1.23:brightness=-0.004:gamma=0.985", "colorbalance=bs=0.032:bm=0.015:rs=-0.012", "unsharp=5:5:0.33:5:5:0"],
    goal_gold: ["eq=saturation=1.23:contrast=1.17:brightness=0.024:gamma=1.025", "colorbalance=rs=0.060:rm=0.030:bs=-0.020", "unsharp=5:5:0.35:5:5:0"],
    replay_blue: ["eq=saturation=0.84:contrast=1.20:brightness=-0.006:gamma=0.985", "colorbalance=bs=0.095:bm=0.045:rs=-0.030", "unsharp=5:5:0.35:5:5:0"],
  };
  return [...(grades[grade] || grades.clean)];
}

function eventCalloutColor(moment) {
  const colors = {
    goal: "#FFD84D",
    amazing: "#FF74E8",
    shot: "#FF9E4A",
    save: "#5DE6FF",
    foul: "#FFE14A",
    card: "#FFE14A",
    close: "#FF8A4C",
    pass: "#73F6C2",
    celebration: "#FFD84D",
  };
  return colors[moment.eventCallout] || "white";
}

export function soundEffectSource(moment, index, outputLength, cueTime = 0.12) {
  const duration = outputLength.toFixed(3);
  const effect = String(moment.soundEffect || "none");
  if (effect === "goal") {
    const delay = Math.max(0, Math.round(cueTime * 1000));
    return [
      `anoisesrc=color=pink:amplitude=0.32:duration=1.05:sample_rate=48000,highpass=f=160,lowpass=f=6200,afade=t=in:st=0:d=0.035,afade=t=out:st=0.34:d=0.71,volume=0.18[goalCrowd${index}]`,
      `aevalsrc=exprs='0.10*(sin(2*PI*523.25*t)+sin(2*PI*659.25*t)+sin(2*PI*783.99*t))*exp(-2.8*t)':s=48000:d=0.92,aecho=0.8:0.35:35|70:0.16|0.08,volume=0.32[goalTone${index}]`,
      `sine=frequency=82:duration=0.28:sample_rate=48000,afade=t=out:st=0.03:d=0.25,volume=0.22[goalImpact${index}]`,
      `[goalCrowd${index}][goalTone${index}][goalImpact${index}]amix=inputs=3:duration=longest:normalize=0,alimiter=limit=0.88,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=${delay}|${delay},apad,atrim=duration=${duration}[sfx${index}]`,
    ].join(";\n");
  }
  const sources = {
    whoosh: "anoisesrc=color=pink:amplitude=0.35:duration=0.22:sample_rate=48000,highpass=f=550,lowpass=f=4800,afade=t=out:st=0.02:d=0.20,volume=0.20",
    impact: "anoisesrc=color=white:amplitude=0.38:duration=0.12:sample_rate=48000,lowpass=f=1800,afade=t=out:st=0.01:d=0.11,volume=0.24",
    whistle: "sine=frequency=2100:duration=0.30:sample_rate=48000,afade=t=out:st=0.12:d=0.18,volume=0.16",
    sparkle: "sine=frequency=1450:duration=0.16:sample_rate=48000,afade=t=out:st=0.03:d=0.13,volume=0.13",
  };
  const source = sources[effect];
  if (!source) return null;
  const delay = Math.max(0, Math.round(cueTime * 1000));
  return `${source},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=${delay}|${delay},apad,atrim=duration=${duration}[sfx${index}]`;
}

function transitionFilter(moment, previousDuration, currentDuration) {
  const requested = clamp(Number(moment.transitionDuration || 0.04), 0.04, 0.36);
  const duration = Math.min(requested, previousDuration / 4, currentDuration / 4);
  const names = { cut: "fade", crossfade: "fade", crosszoom: "zoomin", whip: "smoothleft", flash: "fadefast" };
  return { name: names[moment.transitionIn] || "fade", duration: Math.max(0.04, duration) };
}

export function captionFontSize(text) {
  const widthUnits = [...String(text || "")].reduce((total, character) => {
    if (/\s/.test(character)) return total + 0.30;
    if (/[MW@#%&]/.test(character)) return total + 0.82;
    if (/[Iil1|'.,:;]/.test(character)) return total + 0.30;
    if (/[A-Z0-9]/.test(character)) return total + 0.64;
    return total + 0.54;
  }, 0);
  return Math.round(clamp(900 / Math.max(8, widthUnits), 52, 72));
}
async function makeCaptionCueFiles(moments, outputPath, tracking, outputWidth, outputHeight) {
  const files = new Map();
  const captionDir = resolve(dirname(outputPath), "captions");
  await mkdir(captionDir, { recursive: true });
  for (const [index, moment] of moments.entries()) {
    const sourceLength = Math.max(0.1, moment.endTime - moment.startTime);
    const playbackRate = playbackRateFor(moment);
    const freeze = freezePlan(moment, playbackRate, sourceLength);
    const outputLength = sourceLength / playbackRate + freeze.duration;
    const payoff = verifiedPayoffWindow(moment, trackingForMoment(tracking, moment), playbackRate, freeze);
    const cues = Number(moment.presentationVersion || 1) >= 2
      ? narrationSubtitleCues(moment, outputLength)
      : sparseCaptionCues(moment, outputLength, payoff);
    if (!cues.length) continue;
    // Keep every spoken caption in one predictable lower band.  Moving it
    // around the detected players made the landscape edit visually busy and
    // sometimes covered the pass, shot, or goalkeeper.  The lower band is
    // deliberately independent from tracking; tracking belongs to the camera
    // and evidence overlays, not subtitle placement.
    const y = safeCaptionY([], outputHeight);
    const assPath = resolve(captionDir, `${index}.ass`);
    await writeFile(assPath, captionAss(cues, y, outputWidth, outputHeight));
    files.set(moment.id, [{ assPath }]);
  }
  return files;
}

function safeCaptionY(_keyframes, outputHeight = 1920) {
  // One stable lower-third position prevents captions from jumping between
  // the middle and top of the picture as the ball moves.  Leave a little
  // room for the creator watermark and the subtitle outline.
  return Math.round(outputHeight * (outputHeight <= 1200 ? 0.84 : 0.78));
}

async function makeCalloutFiles(moments, outputPath) {
  const files = new Map();
  const directory = resolve(dirname(outputPath), "callouts");
  await mkdir(directory, { recursive: true });
  for (const [index, moment] of moments.entries()) {
    if (Number(moment.presentationVersion || 1) < 2) continue;
    const label = eventCalloutLabel(moment.eventCallout);
    if (!label) continue;
    const path = resolve(directory, `${index}.txt`);
    await writeFile(path, label);
    files.set(moment.id, path);
  }
  return files;
}

function eventCalloutLabel(value) {
  return {
    amazing: "AMAZING!  ✦",
    goal: "GOAL!  ⚽",
    shot: "WHAT A SHOT!  ★",
    save: "GREAT SAVE!  ★",
    foul: "FOUL!  ⚠",
    card: "CARD!  ⚠",
    close: "SO CLOSE!",
    pass: "PERFECT PASS!  ◎",
    celebration: "UNBELIEVABLE!  ★",
  }[value] || "";
}


export function effectiveOverlayMasks(masks, settings = {}) {
  const detected = Array.isArray(masks) ? masks.filter((mask) => mask && Number(mask.width) > 0 && Number(mask.height) > 0) : [];
  const broadcastUi = settings.broadcastUiMasking === true ? [
    { id: "broadcast-scorebug", kind: "scoreboard", x: 0.005, y: 0.006, width: 0.275, height: 0.085, confidence: 0.55, generated: true },
    { id: "broadcast-header", kind: "broadcast_header", x: 0.345, y: 0.004, width: 0.31, height: 0.072, confidence: 0.55, generated: true },
    { id: "broadcast-channel-bug", kind: "channel_bug", x: 0.775, y: 0.006, width: 0.22, height: 0.095, confidence: 0.55, generated: true },
  ] : [];
  if (detected.length || broadcastUi.length) return [...detected, ...broadcastUi];
  // Creator/channel marks are commonly anchored in this corner. This conservative
  // fallback keeps logo masking deterministic when the semantic pass misses one;
  // it is applied only when the user has enabled logoMasking.
  return [{
    id: "fallback-top-right-watermark",
    kind: "watermark",
    x: 0.875,
    y: 0.012,
    width: 0.115,
    height: 0.145,
    confidence: 0.7,
    fallback: true,
  }];
}

export function sourceMaskFilters(masks, media) {
  return masks.map((mask) => {
    const left = Math.round(mask.x * media.width);
    const top = Math.round(mask.y * media.height);
    const right = Math.round((mask.x + mask.width) * media.width);
    const bottom = Math.round((mask.y + mask.height) * media.height);
    if (right <= 2 || bottom <= 2 || left >= media.width - 2 || top >= media.height - 2) return null;
    const safeX = clamp(left, 1, media.width - 7);
    const safeY = clamp(top, 1, media.height - 7);
    const safeWidth = clamp(right - safeX, 6, media.width - safeX - 1);
    const safeHeight = clamp(bottom - safeY, 6, media.height - safeY - 1);
    return `delogo=x=${safeX}:y=${safeY}:w=${safeWidth}:h=${safeHeight}:show=0`;
  }).filter(Boolean);
}

function keyframeExpression(keyframes, field, fallback) {
  return trackedPositionExpression(keyframes, field, fallback);
}

function visibilityExpression(keyframes, field) {
  const values = keyframes
    .map((frame) => ({ time: Number(frame.time), value: Number(frame[field]) > 0.45 ? 1 : 0 }))
    .filter((frame) => Number.isFinite(frame.time))
    .sort((a, b) => a.time - b.time)
    .filter((frame, index, frames) => index === 0 || frame.value !== frames[index - 1].value);
  if (values.length === 0) return "0";
  let expression = String(values.at(-1).value);
  for (let index = values.length - 2; index >= 0; index -= 1) {
    expression = `if(lt(t,${values[index + 1].time.toFixed(3)}),${values[index].value},${expression})`;
  }
  return expression;
}

function escapeFilterPath(path) {
  return path.replaceAll("\\", "/").replace(":", "\\:").replaceAll("'", "\\'");
}

function resolveSetting(value) {
  return isAbsolute(value) ? value : resolve(projectRoot, value);
}

function resolveExecutable(value) {
  return /[\\/]/.test(value) ? resolveSetting(value) : value;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

export async function normalizeFinishedAudio(premixPath, outputPath) {
  const executable = resolveExecutable(process.env.FFMPEG_PATH || "ffmpeg");
  const measure = async (path) => {
    const diagnostics = await run(executable, ["-hide_banner", "-i", path, "-vn", "-af", "loudnorm=I=-15:TP=-2.0:LRA=9:print_format=json", "-f", "null", "-"], true);
    const match = diagnostics.match(/\{\s*"input_i"[\s\S]*?\}/);
    if (!match) throw new Error("Could not measure the finished audio loudness.");
    return JSON.parse(match[0]);
  };
  let result;
  let loudness;
  // The premix belongs to this render attempt. Always normalize and promote it;
  // an older final.mp4 must never satisfy validation for a newly encoded edit.
  const measured = await measure(premixPath);
  if (!Number.isFinite(Number(measured.input_i))) {
    await rename(premixPath, outputPath);
    return { normalized: false, reason: "silent_mix" };
  }
  const filter = `loudnorm=I=-15:TP=-2.0:LRA=9:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=false`;
  await run(executable, ["-hide_banner", "-y", "-i", premixPath, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-af", filter, "-c:a", "aac", "-ar", "48000", "-b:a", "192k", "-movflags", "+faststart", outputPath]);
  result = await measure(outputPath);
  loudness = { normalized: true, targetLufs: -15, integratedLufs: Number(result.input_i), truePeakDb: Number(result.input_tp) };
  // AAC can introduce a small inter-sample overshoot, and short silent/sfx
  // sections can leave the integrated level just outside the delivery band.
  // Correct the encoded audio in-place (video is stream-copied) instead of
  // rejecting an otherwise valid visual edit. Two bounded passes are enough
  // to converge after AAC measurement without creating a retry loop.
  let totalCorrectionDb = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    const levelCorrection = Number.isFinite(loudness.integratedLufs)
      && (loudness.integratedLufs < -17.2 || loudness.integratedLufs > -13.8)
      ? Math.max(-6, Math.min(6, -15 - loudness.integratedLufs)) : 0;
    const peakCorrection = Number.isFinite(loudness.truePeakDb) && loudness.truePeakDb > -1
      ? -(loudness.truePeakDb + 1.25) : 0;
    const correctionDb = levelCorrection + peakCorrection;
    if (Math.abs(correctionDb) < 0.05) break;
    const correctedPath = `${outputPath}.audio-corrected-${pass}.mp4`;
    await run(executable, ["-hide_banner", "-y", "-i", outputPath, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-af", `volume=${correctionDb.toFixed(2)}dB`, "-c:a", "aac", "-ar", "48000", "-b:a", "192k", "-movflags", "+faststart", correctedPath]);
    await rename(correctedPath, outputPath);
    totalCorrectionDb += correctionDb;
    result = await measure(outputPath);
    loudness = { normalized: true, targetLufs: -15, integratedLufs: Number(result.input_i), truePeakDb: Number(result.input_tp), audioCorrectionDb: +totalCorrectionDb.toFixed(2) };
  }
  await writeFile(resolve(dirname(outputPath), "loudness.json"), JSON.stringify(loudness, null, 2));
  if (loudness.integratedLufs < -17.2 || loudness.integratedLufs > -13.8 || loudness.truePeakDb > -1) throw new Error("The final audio mix failed its measured loudness/peak check.");
  await unlink(premixPath);
  return loudness;
}

function run(command, args, captureDiagnostics = false) {
  if (/^ffmpeg(?:\.exe)?$/i.test(basename(command))) args = boundedFfmpegArgs(args);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => code === 0
      ? resolvePromise(captureDiagnostics ? stderr : stdout)
      : reject(new Error(`${basename(command)} exited with ${signal ? `signal ${signal}` : `code ${code}`}: ${stderr.slice(-2400)}`)));
  });
}
