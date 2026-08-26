import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { splitCaptionChunks } from "./editorial-policy.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputWidth = 1080;
const outputHeight = 1920;

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

export async function renderVideoV2(sourcePath, outputPath, moments, settings, media, ttsFiles, overlayMasks, tracking) {
  const selected = fitSelectedMoments(moments, settings.targetDuration, ttsFiles, tracking);
  if (selected.length === 0) throw new Error("No moments were selected for the final edit.");
  const captionCues = settings.captions ? await makeCaptionCueFiles(selected, outputPath, tracking, ttsFiles) : new Map();
  const calloutFiles = settings.captions ? await makeCalloutFiles(selected, outputPath) : new Map();
  const args = ["-hide_banner", "-y", "-i", sourcePath];
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
  const ballInputs = new Map();
  if (settings.playerHighlight) selected.forEach((moment, index) => {
    const trackedMoment = tracking?.moments?.[moment.id];
    const annotation = trackedMoment?.annotation;
    const markerPath = tracking?.markerPaths?.[annotation?.style];
    const playerEligible = moment.playerHighlight !== false
      && annotation?.style !== "none"
      && Number(annotation?.confidence) >= 0.54
      && markerPath;
    if (playerEligible) {
      const inputIndex = inputCount(args);
      args.push("-loop", "1", "-framerate", "30", "-i", markerPath);
      annotationInputs.set(index, { inputIndex, annotation });
    }
    const reactionOnly = moment.eventType === "celebration" || moment.storyPhase === "reaction" || moment.role === "reaction";
    const ballEligible = !reactionOnly
      && Boolean(tracking?.markerPaths?.ball)
      && trackedMoment?.keyframes?.some((frame) => Number(frame.ballMarkerVisible) > 0);
    if (ballEligible) {
      const inputIndex = inputCount(args);
      args.push("-loop", "1", "-framerate", "30", "-i", tracking.markerPaths.ball);
      ballInputs.set(index, inputIndex);
    }
  });

  const filters = [];
  const useOriginalAudio = !settings.commentary && media.hasAudio && settings.originalAudio !== "muted";
  const gain = settings.originalAudio === "reduced" ? 0.28 : 1;
  const masks = settings.logoMasking ? sourceMaskFilters(overlayMasks, media) : [];
  const masking = masks.length ? `${masks.join(",")},` : "";
  const clipDurations = [];
  const clipStarts = [0];

  selected.forEach((moment, index) => {
    const sourceLength = Math.max(1.2, moment.endTime - moment.startTime);
    const playbackRate = clamp(Number(moment.playbackRate || 1), 0.72, 1.18);
    const annotationInput = annotationInputs.get(index);
    const cueDuration = annotationInput ? clamp(Number(annotationInput.annotation.duration), 0.45, 0.75) : 0;
    const baseOutputLength = sourceLength / playbackRate + cueDuration;
    const speechDuration = Number(ttsFiles.durations?.get(moment.id) || 0);
    const outputLength = Math.max(baseOutputLength, speechDuration > 0 ? speechDuration + 0.16 : 0);
    clipDurations.push(outputLength);

    const fallbackX = clamp(moment.recommendedCrop?.[0]?.x ?? 0.5, 0, 1);
    const trackedMoment = tracking?.moments?.[moment.id];
    const keyframes = retimeKeyframes(trackedMoment?.keyframes || [], playbackRate);
    const cameraX = keyframeExpression(keyframes, "cameraX", fallbackX);
    const cameraY = keyframeExpression(keyframes, "cameraY", 0.5);
    const sourcePrefix = `[0:v]trim=start=${moment.startTime.toFixed(3)}:duration=${sourceLength.toFixed(3)},setpts=PTS-STARTPTS,${masking}`;
    const crop = media.width / media.height >= 9 / 16
      ? `crop=ih*9/16:ih:x='max(0,min(iw-ow,iw*(${cameraX})-ow/2))':y=0`
      : `crop=iw:iw*16/9:x=0:y='max(0,min(ih-oh,ih*(${cameraY})-oh/2))'`;
    filters.push(`${sourcePrefix}${crop},scale=${outputWidth}:${outputHeight}:flags=lanczos,setsar=1${visualEffectFilter(moment, settings.intensity, Boolean(annotationInput))},setpts=PTS/${playbackRate.toFixed(5)},fps=30,settb=AVTB,format=yuv420p[baseclip${index}]`);

    if (annotationInput) {
      const { inputIndex, annotation } = annotationInput;
      const cueX = Number(annotation.x);
      const cueY = Number(annotation.y);
      const spotlight = annotation.style === "spotlight";
      const playerAnchorX = spotlight ? 110 : 80;
      const playerAnchorY = spotlight ? 122 : 176;
      const playerYField = spotlight ? "playerCenterY" : "playerTopY";
      const playerCenterX = keyframeExpression(keyframes, "playerCenterX", cueX + playerAnchorX);
      const playerAnchorPositionY = keyframeExpression(keyframes, playerYField, cueY + playerAnchorY);
      const playerVisible = visibilityExpression(keyframes, "markerVisible");
      const trackDuration = clamp(Number(annotation.trackDuration || 1.25) / playbackRate, 0.70, 1.80);
      filters.push(`[baseclip${index}]split=2[freezeSource${index}][motionSource${index}]`);
      filters.push(`[freezeSource${index}]trim=duration=0.034,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${cueDuration.toFixed(3)},trim=duration=${cueDuration.toFixed(3)},eq=brightness=-0.055:saturation=0.86:contrast=1.08,vignette=PI/7[freeze${index}]`);
      filters.push(`[${inputIndex}:v]format=rgba,split=2[playerAssetFreeze${index}][playerAssetMotion${index}]`);
      filters.push(`[freeze${index}][playerAssetFreeze${index}]overlay=x=${cueX.toFixed(2)}:y=${cueY.toFixed(2)}:eof_action=repeat:shortest=1[freezePlayer${index}]`);
      filters.push(`[motionSource${index}][playerAssetMotion${index}]overlay=x='(${playerCenterX})-${playerAnchorX}':y='(${playerAnchorPositionY})-${playerAnchorY}':enable='between(t,0,${trackDuration.toFixed(3)})*${playerVisible}':eval=frame:eof_action=repeat:shortest=1[motionPlayer${index}]`);
      filters.push(`[freezePlayer${index}][motionPlayer${index}]concat=n=2:v=1:a=0[playerclip${index}]`);
    } else {
      filters.push(`[baseclip${index}]null[playerclip${index}]`);
    }

    const ballInputIndex = ballInputs.get(index);
    if (ballInputIndex !== undefined) {
      const first = keyframes[0] || {};
      const ballTimelineKeyframes = cueDuration > 0 && keyframes.length
        ? [{ ...first, time: 0 }, ...keyframes.map((frame) => ({ ...frame, time: Number(frame.time) + cueDuration }))]
        : keyframes;
      const ballX = keyframeExpression(ballTimelineKeyframes, "ballCenterX", Number(first.ballCenterX || -320));
      const ballY = keyframeExpression(ballTimelineKeyframes, "ballCenterY", Number(first.ballCenterY || -320));
      const ballVisible = visibilityExpression(ballTimelineKeyframes, "ballMarkerVisible");
      filters.push(`[${ballInputIndex}:v]format=rgba[ballAsset${index}]`);
      filters.push(`[playerclip${index}][ballAsset${index}]overlay=x='(${ballX})-56':y='(${ballY})-56':enable='${ballVisible}':eval=frame:eof_action=repeat:shortest=1[clip${index}]`);
    } else {
      filters.push(`[playerclip${index}]null[clip${index}]`);
    }

    const extensionDuration = Math.max(0, outputLength - baseOutputLength);
    let captionLabel = `clip${index}`;
    if (extensionDuration > 0.01) {
      filters.push(`[clip${index}]tpad=stop_mode=clone:stop_duration=${extensionDuration.toFixed(3)},trim=duration=${outputLength.toFixed(3)}[timedclip${index}]`);
      captionLabel = `timedclip${index}`;
    }
    const cues = captionCues.get(moment.id) || [];
    for (const [cueIndex, cue] of cues.entries()) {
      const nextLabel = `caption${index}_${cueIndex}`;
      const captionFont = escapeFilterPath(resolveSetting(process.env.CAPTION_FONT_PATH || "C:/Windows/Fonts/arialbd.ttf"));
      const color = cue.highlight ? "0x62D8FF" : "white";
      filters.push(`[${captionLabel}]drawtext=fontfile='${captionFont}':textfile='${escapeFilterPath(cue.path)}':fontcolor=${color}:fontsize=72:borderw=7:bordercolor=black@0.92:shadowx=3:shadowy=4:shadowcolor=black@0.65:x=(w-text_w)/2:y=h*0.74:enable='between(t,${cue.start.toFixed(3)},${cue.end.toFixed(3)})'[${nextLabel}]`);
      captionLabel = nextLabel;
    }
    const calloutPath = calloutFiles.get(moment.id);
    if (calloutPath) {
      const eventFont = escapeFilterPath(resolveSetting(process.env.EVENT_FONT_PATH || "C:/Windows/Fonts/seguisym.ttf"));
      const color = eventCalloutColor(moment);
      filters.push(`[${captionLabel}]drawtext=fontfile='${eventFont}':textfile='${escapeFilterPath(calloutPath)}':fontcolor=${color}:fontsize=68:borderw=5:bordercolor=black@0.92:shadowx=3:shadowy=4:shadowcolor=black@0.65:x=(w-text_w)/2:y=260:enable='between(t,0.10,1.05)'[v${index}]`);
    } else {
      filters.push(`[${captionLabel}]null[v${index}]`);
    }
    const speechIndex = ttsInputs.get(moment.id);
    if (speechIndex !== undefined) {
      filters.push(`[${speechIndex}:a]aresample=48000,apad,atrim=duration=${outputLength.toFixed(3)},volume=1,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[speech${index}]`);
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
    const soundEffect = soundEffectSource(moment, index, outputLength);
    if (soundEffect) {
      filters.push(soundEffect);
      filters.push(`[abase${index}][sfx${index}]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.96[a${index}]`);
    } else {
      filters.push(`[abase${index}]anull[a${index}]`);
    }
  });

  let timelineDuration = clipDurations[0] || 0;
  if (selected.length === 1) {
    filters.push("[v0]null[outv]");
    filters.push("[a0]anull[outaBase]");
  } else {
    let videoLabel = "v0";
    let audioLabel = "a0";
    let accumulated = clipDurations[0];
    for (let index = 1; index < selected.length; index += 1) {
      const requestedTransition = String(selected[index].transitionIn || "cut");
      const spokenBoundary = Boolean(selected[index - 1].commentary || selected[index].commentary);
      if (requestedTransition === "cut" || spokenBoundary) {
        clipStarts[index] = accumulated;
        filters.push(`[${videoLabel}][${audioLabel}][v${index}][a${index}]concat=n=2:v=1:a=1[vx${index}][ax${index}]`);
        accumulated += clipDurations[index];
      } else {
        const transition = transitionFilter(selected[index], clipDurations[index - 1], clipDurations[index]);
        const offset = Math.max(0, accumulated - transition.duration);
        clipStarts[index] = offset;
        filters.push(`[${videoLabel}][v${index}]xfade=transition=${transition.name}:duration=${transition.duration.toFixed(3)}:offset=${offset.toFixed(3)}[vx${index}]`);
        filters.push(`[${audioLabel}][a${index}]acrossfade=d=${transition.duration.toFixed(3)}:c1=tri:c2=tri[ax${index}]`);
        accumulated += clipDurations[index] - transition.duration;
      }
      videoLabel = `vx${index}`;
      audioLabel = `ax${index}`;
    }
    timelineDuration = accumulated;
    filters.push(`[${videoLabel}]null[outv]`);
    filters.push(`[${audioLabel}]anull[outaBase]`);
  }
  if (globalNarrationInputIndex !== null) {
    const narrationDuration = Number(ttsFiles.narrationDuration || timelineDuration);
    const tempo = clamp(narrationDuration / Math.max(0.1, timelineDuration), 0.82, 1.18);
    filters.push(`[${globalNarrationInputIndex}:a]aresample=48000,atempo=${tempo.toFixed(5)},apad,atrim=duration=${timelineDuration.toFixed(3)},volume=1,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[narration]`);
    filters.push("[outaBase][narration]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.96[outa]");
  } else {
    filters.push("[outaBase]anull[outa]");
  }

  const synchronization = selected.map((moment, index) => ({
    beatId: moment.beatId || null,
    momentId: moment.id,
    narration: moment.commentary || null,
    visualStart: Number((clipStarts[index] || 0).toFixed(3)),
    visualDuration: Number(clipDurations[index].toFixed(3)),
    speechDuration: Number(Number(ttsFiles.durations?.get(moment.id) || 0).toFixed(3)),
  }));
  const syncProblems = settings.commentary ? synchronizationProblems(synchronization) : [];
  if (syncProblems.length) throw new Error(`Narration/visual synchronization validation failed: ${syncProblems.join(", ")}`);
  await writeFile(resolve(dirname(outputPath), "synchronization.json"), JSON.stringify({
    version: 1,
    timelineDuration: Number(timelineDuration.toFixed(3)),
    beats: synchronization,
  }, null, 2));
  const filterScriptPath = resolve(dirname(outputPath), "filtergraph-v2.txt");
  await writeFile(filterScriptPath, filters.join(";\n"));
  args.push(
    "-/filter_complex", filterScriptPath, "-map", "[outv]", "-map", "[outa]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "48000", "-b:a", "192k", "-movflags", "+faststart", outputPath,
  );
  await run(resolveExecutable(process.env.FFMPEG_PATH || "ffmpeg"), args);
  return { timelineDuration, synchronization };
}

function inputCount(args) {
  return args.filter((item) => item === "-i").length;
}

function delayValue(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  return `${milliseconds}|${milliseconds}`;
}

function fitSelectedMoments(moments, targetDuration, ttsFiles, tracking) {
  const ordered = moments
    .filter((item) => item.selectedForFinalVideo && item.endTime - item.startTime >= 1.2)
    .sort((a, b) => Number(a.editOrder ?? Number.MAX_SAFE_INTEGER) - Number(b.editOrder ?? Number.MAX_SAFE_INTEGER) || a.startTime - b.startTime);
  const estimatedDuration = (moment) => {
    const playbackRate = clamp(Number(moment.playbackRate || 1), 0.72, 1.18);
    const sourceDuration = (moment.endTime - moment.startTime) / playbackRate;
    const annotation = tracking?.moments?.[moment.id]?.annotation;
    const cueDuration = annotation?.style !== "none" ? clamp(Number(annotation?.duration), 0.45, 0.75) : 0;
    const speechDuration = Number(ttsFiles.durations?.get(moment.id) || 0);
    return Math.max(sourceDuration + cueDuration, speechDuration > 0 ? speechDuration + 0.16 : 0);
  };
  const narrated = ordered.filter((moment) => moment.commentary);
  const chosen = new Map(narrated.map((moment) => [moment.id, moment]));
  let total = narrated.reduce((sum, moment) => sum + estimatedDuration(moment), 0);
  let partialSupportAdded = false;
  for (const moment of ordered.filter((item) => !item.commentary)) {
    const length = estimatedDuration(moment);
    if (total + length <= targetDuration + 1) {
      chosen.set(moment.id, moment);
      total += length;
    } else if (!partialSupportAdded && total < targetDuration - 1.2) {
      const playbackRate = clamp(Number(moment.playbackRate || 1), 0.72, 1.18);
      const annotation = tracking?.moments?.[moment.id]?.annotation;
      const cueDuration = annotation?.style !== "none" ? clamp(Number(annotation?.duration), 0.45, 0.75) : 0;
      const sourceLength = (targetDuration - total - cueDuration) * playbackRate;
      if (sourceLength >= 1.2) {
        chosen.set(moment.id, { ...moment, endTime: Math.min(moment.endTime, moment.startTime + sourceLength) });
        total = targetDuration;
        partialSupportAdded = true;
      }
    }
  }
  return ordered.flatMap((moment) => chosen.has(moment.id) ? [chosen.get(moment.id)] : []);
}
function retimeKeyframes(keyframes, playbackRate) {
  return keyframes.map((frame) => ({ ...frame, time: Number(frame.time) / playbackRate }));
}

function visualEffectFilter(moment, intensity, annotationActive = false) {
  const allowed = new Set(["clean", "dramatic", "goal_gold", "replay_blue"]);
  const grade = allowed.has(moment.colorGrade)
    ? moment.colorGrade
    : moment.isReplay || moment.effect === "replay_treatment"
      ? "replay_blue"
      : moment.eventType === "goal"
        ? "goal_gold"
        : moment.role === "hook"
          ? "dramatic"
          : "clean";
  const gradeFilters = {
    clean: ["eq=saturation=1.07:contrast=1.055:brightness=0.004:gamma=1.01", "unsharp=5:5:0.20:5:5:0"],
    dramatic: ["eq=saturation=1.06:contrast=1.12:brightness=-0.012:gamma=0.98", "vignette=PI/9"],
    goal_gold: ["eq=saturation=1.13:contrast=1.09:brightness=0.014:gamma=1.02", "colorbalance=rs=0.045:gs=0.018:bs=-0.025", "unsharp=5:5:0.30:5:5:0"],
    replay_blue: ["eq=saturation=0.86:contrast=1.11:brightness=-0.014:gamma=0.98", "colorbalance=bs=0.040:bm=0.015"],
  };
  const filters = [...gradeFilters[grade]];
  if (intensity === "natural" && !["goal_gold", "replay_blue"].includes(grade)) {
    filters.splice(0, filters.length, "eq=saturation=1.035:contrast=1.035:brightness=0.002");
  }
  if (moment.effect === "punch_zoom" && !annotationActive) {
    filters.push("scale=1134:2016:flags=lanczos", "crop=1080:1920:x=(iw-ow)/2:y=(ih-oh)/2");
  } else if (moment.effect === "slow_motion") {
    filters.push("unsharp=5:5:0.28:5:5:0");
  }
  return "," + filters.join(",");
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

function soundEffectSource(moment, index, outputLength) {
  const duration = outputLength.toFixed(3);
  const effect = String(moment.soundEffect || "none");
  const sources = {
    whoosh: "anoisesrc=color=pink:amplitude=0.35:duration=0.22:sample_rate=48000,highpass=f=550,lowpass=f=4800,afade=t=out:st=0.02:d=0.20,volume=0.20",
    impact: "anoisesrc=color=white:amplitude=0.38:duration=0.12:sample_rate=48000,lowpass=f=1800,afade=t=out:st=0.01:d=0.11,volume=0.24",
    goal: "sine=frequency=880:duration=0.34:sample_rate=48000,afade=t=out:st=0.10:d=0.24,volume=0.18",
    whistle: "sine=frequency=2100:duration=0.30:sample_rate=48000,afade=t=out:st=0.12:d=0.18,volume=0.16",
    sparkle: "sine=frequency=1450:duration=0.16:sample_rate=48000,afade=t=out:st=0.03:d=0.13,volume=0.13",
  };
  const source = sources[effect];
  if (!source) return null;
  return `${source},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=120|120,apad,atrim=duration=${duration}[sfx${index}]`;
}

function transitionFilter(moment, previousDuration, currentDuration) {
  const requested = clamp(Number(moment.transitionDuration || 0.04), 0.04, 0.36);
  const duration = Math.min(requested, previousDuration / 4, currentDuration / 4);
  const names = { cut: "fade", crossfade: "fade", crosszoom: "zoomin", whip: "smoothleft", flash: "fadefast" };
  return { name: names[moment.transitionIn] || "fade", duration: Math.max(0.04, duration) };
}

async function makeCaptionCueFiles(moments, outputPath, tracking, ttsFiles) {
  const files = new Map();
  const captionDir = resolve(dirname(outputPath), "captions");
  await mkdir(captionDir, { recursive: true });
  for (const [index, moment] of moments.entries()) {
    const chunks = splitCaptionChunks(moment.commentary || moment.onScreenText, 4);
    if (chunks.length === 0) continue;
    const sourceLength = Math.max(1.2, moment.endTime - moment.startTime);
    const playbackRate = clamp(Number(moment.playbackRate || 1), 0.72, 1.18);
    const annotation = tracking?.moments?.[moment.id]?.annotation;
    const cueDuration = annotation?.style !== "none" ? clamp(Number(annotation?.duration), 0.45, 0.75) : 0;
    const baseOutputLength = sourceLength / playbackRate + cueDuration;
    const speechDuration = Number(ttsFiles.durations?.get(moment.id) || 0);
    const outputLength = Math.max(baseOutputLength, speechDuration > 0 ? speechDuration + 0.16 : 0);
    const weights = chunks.map((chunk) => Math.max(2, chunk.replace(/\s+/g, "").length));
    const totalWeight = weights.reduce((total, weight) => total + weight, 0);
    const available = Math.max(0.6, outputLength - 0.16);
    let cursor = 0.08;
    const cues = [];
    for (const [cueIndex, chunk] of chunks.entries()) {
      const duration = cueIndex === chunks.length - 1
        ? Math.max(0.18, outputLength - 0.08 - cursor)
        : Math.max(0.28, available * weights[cueIndex] / totalWeight);
      const path = resolve(captionDir, index + "-" + cueIndex + ".txt");
      await writeFile(path, chunk);
      cues.push({
        path,
        start: cursor,
        end: Math.min(outputLength - 0.04, cursor + duration),
        highlight: cueIndex % 2 === 1 || (moment.role === "hook" && cueIndex === 0),
      });
      cursor += duration;
    }
    files.set(moment.id, cues);
  }
  return files;
}

async function makeCalloutFiles(moments, outputPath) {
  const files = new Map();
  const directory = resolve(dirname(outputPath), "callouts");
  await mkdir(directory, { recursive: true });
  for (const [index, moment] of moments.entries()) {
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


function sourceMaskFilters(masks, media) {
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
  let values = keyframes
    .map((frame) => ({ time: Number(frame.time), value: Number(frame[field]) }))
    .filter((frame) => Number.isFinite(frame.time) && Number.isFinite(frame.value))
    .sort((a, b) => a.time - b.time);
  let tolerance = field.startsWith("camera") ? 0.003 : 5;
  values = simplifySeries(values, tolerance);
  while (values.length > 48) {
    tolerance *= 1.4;
    values = simplifySeries(values, tolerance);
  }
  if (values.length === 0) return Number(fallback).toFixed(5);
  if (values.length === 1) return values[0].value.toFixed(5);
  let expression = values.at(-1).value.toFixed(5);
  for (let index = values.length - 2; index >= 0; index -= 1) {
    const current = values[index];
    const next = values[index + 1];
    const duration = Math.max(0.001, next.time - current.time);
    const segment = `${current.value.toFixed(5)}+(${(next.value - current.value).toFixed(5)})*clip((t-${current.time.toFixed(3)})/${duration.toFixed(3)},0,1)`;
    expression = `if(lt(t,${next.time.toFixed(3)}),${segment},${expression})`;
  }
  return expression;
}

function visibilityExpression(keyframes, field) {
  return "gt(" + keyframeExpression(keyframes, field, 0) + ",0.45)";
}

function simplifySeries(values, tolerance) {
  if (values.length <= 2) return values;
  const first = values[0];
  const last = values.at(-1);
  const duration = Math.max(0.001, last.time - first.time);
  let maximumError = -1;
  let splitIndex = -1;
  for (let index = 1; index < values.length - 1; index += 1) {
    const ratio = (values[index].time - first.time) / duration;
    const expected = first.value + (last.value - first.value) * ratio;
    const error = Math.abs(values[index].value - expected);
    if (error > maximumError) {
      maximumError = error;
      splitIndex = index;
    }
  }
  if (maximumError <= tolerance || splitIndex < 1) return [first, last];
  return [
    ...simplifySeries(values.slice(0, splitIndex + 1), tolerance).slice(0, -1),
    ...simplifySeries(values.slice(splitIndex), tolerance),
  ];
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

function run(command, args) {
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
    child.on("close", (code) => code === 0
      ? resolvePromise(stdout)
      : reject(new Error(`${basename(command)} exited with code ${code}: ${stderr.slice(-2400)}`)));
  });
}
