import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputWidth = 1080;
const outputHeight = 1920;

export async function renderVideoV2(sourcePath, outputPath, moments, settings, media, ttsFiles, overlayMasks, tracking) {
  const selected = fitSelectedMoments(moments, settings.targetDuration);
  if (selected.length === 0) throw new Error("No moments were selected for the final edit.");
  const captionFiles = settings.captions ? await makeCaptionFiles(selected, outputPath) : new Map();
  const calloutFiles = settings.captions ? await makeCalloutFiles(selected, outputPath) : new Map();
  const args = ["-hide_banner", "-y", "-i", sourcePath];
  const ttsInputs = new Map();
  for (const moment of selected) {
    const speech = ttsFiles.get(moment.id);
    if (speech) {
      ttsInputs.set(moment.id, inputCount(args));
      args.push("-i", speech);
    }
  }
  const annotationInputs = new Map();
  if (settings.playerHighlight) selected.forEach((moment, index) => {
    const annotation = tracking?.moments?.[moment.id]?.annotation;
    const markerPath = tracking?.markerPaths?.[annotation?.style];
    const eligible = moment.playerHighlight !== false
      && !moment.isReplay
      && annotation?.style !== "none"
      && Number(annotation?.confidence) >= 0.54
      && markerPath;
    if (!eligible) return;
    const inputIndex = inputCount(args);
    args.push("-loop", "1", "-framerate", "30", "-i", markerPath);
    annotationInputs.set(index, { inputIndex, annotation });
  });

  const filters = [];
  const useOriginalAudio = !settings.commentary && media.hasAudio && settings.originalAudio !== "muted";
  const gain = settings.originalAudio === "reduced" ? 0.28 : 1;
  const masks = settings.logoMasking ? sourceMaskFilters(overlayMasks, media) : [];
  const masking = masks.length ? `${masks.join(",")},` : "";
  const clipDurations = [];

  selected.forEach((moment, index) => {
    const sourceLength = Math.max(1.2, moment.endTime - moment.startTime);
    const playbackRate = clamp(Number(moment.playbackRate || 1), 0.72, 1.18);
    const annotationInput = annotationInputs.get(index);
    const cueDuration = annotationInput ? clamp(Number(annotationInput.annotation.duration), 0.45, 0.75) : 0;
    const outputLength = sourceLength / playbackRate + cueDuration;
    clipDurations.push(outputLength);

    const fallbackX = clamp(moment.recommendedCrop?.[0]?.x ?? 0.5, 0, 1);
    const trackedMoment = tracking?.moments?.[moment.id];
    const keyframes = retimeKeyframes(trackedMoment?.keyframes || [], playbackRate);
    const cameraX = keyframeExpression(keyframes, "cameraX", fallbackX);
    const cameraY = keyframeExpression(keyframes, "cameraY", 0.5);
    const sourcePrefix = `[0:v]trim=start=${moment.startTime.toFixed(3)}:duration=${sourceLength.toFixed(3)},setpts=PTS-STARTPTS,${masking}`;
    if (trackedMoment?.layoutMode === "context") {
      filters.push(`${sourcePrefix}split=2[contextBgSource${index}][contextFgSource${index}]`);
      filters.push(`[contextBgSource${index}]scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase,crop=${outputWidth}:${outputHeight},boxblur=24:2,eq=brightness=-0.10:saturation=0.82[contextBg${index}]`);
      filters.push(`[contextFgSource${index}]scale=${outputWidth}:-2:flags=lanczos,setsar=1[contextFg${index}]`);
      filters.push(`[contextBg${index}][contextFg${index}]overlay=x=0:y=(H-h)/2:shortest=1${visualEffectFilter(moment, settings.intensity, index)},setpts=PTS/${playbackRate.toFixed(5)},fps=30,settb=AVTB,format=yuv420p[baseclip${index}]`);
    } else {
      const crop = media.width / media.height >= 9 / 16
        ? `crop=ih*9/16:ih:x='max(0,min(iw-ow,iw*(${cameraX})-ow/2))':y=0`
        : `crop=iw:iw*16/9:x=0:y='max(0,min(ih-oh,ih*(${cameraY})-oh/2))'`;
      filters.push(`${sourcePrefix}${crop},scale=${outputWidth}:${outputHeight}:flags=lanczos,setsar=1${visualEffectFilter(moment, settings.intensity, index)},setpts=PTS/${playbackRate.toFixed(5)},fps=30,settb=AVTB,format=yuv420p[baseclip${index}]`);
    }

    if (annotationInput) {
      const { inputIndex, annotation } = annotationInput;
      let cueX = Number(annotation.x);
      let cueY = Number(annotation.y);
      if (trackedMoment?.layoutMode === "context" && Number.isFinite(Number(annotation.sourceX))) {
        const foregroundHeight = outputWidth * media.height / media.width;
        const foregroundTop = (outputHeight - foregroundHeight) / 2;
        const spotlight = annotation.style === "spotlight";
        const anchorX = spotlight ? 110 : 80;
        const anchorY = spotlight ? 122 : 176;
        cueX = Number(annotation.sourceX) * outputWidth - anchorX;
        cueY = foregroundTop + Number(spotlight ? annotation.sourceYCenter : annotation.sourceYTop) * foregroundHeight - anchorY;
      }
      filters.push(`[baseclip${index}]split=2[freezeSource${index}][motion${index}]`);
      filters.push(`[freezeSource${index}]trim=duration=0.034,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${cueDuration.toFixed(3)},trim=duration=${cueDuration.toFixed(3)},eq=brightness=-0.09:saturation=0.70:contrast=1.08,vignette=PI/5[freeze${index}]`);
      filters.push(`[${inputIndex}:v]format=rgba[cueAsset${index}]`);
      filters.push(`[freeze${index}][cueAsset${index}]overlay=x=${cueX.toFixed(2)}:y=${cueY.toFixed(2)}:eof_action=repeat:shortest=1[cue${index}]`);
      filters.push(`[cue${index}][motion${index}]concat=n=2:v=1:a=0[clip${index}]`);
    } else {
      filters.push(`[baseclip${index}]null[clip${index}]`);
    }

    const captionPath = captionFiles.get(moment.id);
    const calloutPath = calloutFiles.get(moment.id);
    if (captionPath) {
      const captionFont = escapeFilterPath(resolveSetting(process.env.CAPTION_FONT_PATH || "C:/Windows/Fonts/arialbd.ttf"));
      filters.push(`[clip${index}]drawtext=fontfile='${captionFont}':textfile='${escapeFilterPath(captionPath)}':fontcolor=white:fontsize=60:borderw=5:bordercolor=black@0.88:box=1:boxcolor=black@0.38:boxborderw=18:x=(w-text_w)/2:y=h-text_h-210[captioned${index}]`);
    } else {
      filters.push(`[clip${index}]null[captioned${index}]`);
    }
    if (calloutPath) {
      const eventFont = escapeFilterPath(resolveSetting(process.env.EVENT_FONT_PATH || "C:/Windows/Fonts/seguisym.ttf"));
      const color = eventCalloutColor(moment);
      filters.push(`[captioned${index}]drawtext=fontfile='${eventFont}':textfile='${escapeFilterPath(calloutPath)}':fontcolor=${color}:fontsize=82:borderw=6:bordercolor=black@0.92:box=1:boxcolor=black@0.48:boxborderw=24:x=(w-text_w)/2:y=170:enable='between(t,0.10,1.35)'[v${index}]`);
    } else {
      filters.push(`[captioned${index}]null[v${index}]`);
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

  if (selected.length === 1) {
    filters.push("[v0]null[outv]");
    filters.push("[a0]anull[outa]");
  } else {
    let videoLabel = "v0";
    let audioLabel = "a0";
    let accumulated = clipDurations[0];
    for (let index = 1; index < selected.length; index += 1) {
      const transition = transitionFilter(selected[index], clipDurations[index - 1], clipDurations[index]);
      const offset = Math.max(0, accumulated - transition.duration);
      filters.push(`[${videoLabel}][v${index}]xfade=transition=${transition.name}:duration=${transition.duration.toFixed(3)}:offset=${offset.toFixed(3)}[vx${index}]`);
      filters.push(`[${audioLabel}][a${index}]acrossfade=d=${transition.duration.toFixed(3)}:c1=tri:c2=tri[ax${index}]`);
      videoLabel = `vx${index}`;
      audioLabel = `ax${index}`;
      accumulated += clipDurations[index] - transition.duration;
    }
    filters.push(`[${videoLabel}]null[outv]`);
    filters.push(`[${audioLabel}]anull[outa]`);
  }

  const filterScriptPath = resolve(dirname(outputPath), "filtergraph-v2.txt");
  await writeFile(filterScriptPath, filters.join(";\n"));
  args.push(
    "-/filter_complex", filterScriptPath, "-map", "[outv]", "-map", "[outa]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "48000", "-b:a", "192k", "-movflags", "+faststart", outputPath,
  );
  await run(resolveExecutable(process.env.FFMPEG_PATH || "ffmpeg"), args);
}

function inputCount(args) {
  return args.filter((item) => item === "-i").length;
}

function delayValue(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  return `${milliseconds}|${milliseconds}`;
}

function fitSelectedMoments(moments, targetDuration) {
  let total = 0;
  return moments
    .filter((item) => item.selectedForFinalVideo && item.endTime - item.startTime >= 1.2)
    .sort((a, b) => Number(a.editOrder ?? Number.MAX_SAFE_INTEGER) - Number(b.editOrder ?? Number.MAX_SAFE_INTEGER) || a.startTime - b.startTime)
    .filter((moment) => {
      const length = (moment.endTime - moment.startTime) / clamp(Number(moment.playbackRate || 1), 0.72, 1.18);
      if (total + length > targetDuration + 0.5) return false;
      total += length;
      return true;
    });
}

function retimeKeyframes(keyframes, playbackRate) {
  return keyframes.map((frame) => ({ ...frame, time: Number(frame.time) / playbackRate }));
}

function visualEffectFilter(moment, intensity, index) {
  const event = String(moment.eventType || "");
  const palette = ["cool", "clean", "warm", "dramatic"];
  const grade = event === "goal"
    ? "goal_gold"
    : moment.isReplay || moment.effect === "replay_treatment"
      ? "replay_blue"
      : palette[index % palette.length];
  const gradeFilters = {
    cool: ["eq=saturation=1.04:contrast=1.10:brightness=-0.010:gamma=0.98", "colorbalance=bs=0.065:bm=0.025"],
    clean: ["eq=saturation=1.11:contrast=1.045:brightness=0.008:gamma=1.02", "unsharp=5:5:0.25:5:5:0"],
    warm: ["eq=saturation=1.17:contrast=1.07:brightness=0.012:gamma=1.01", "colorbalance=rs=0.055:rm=0.025:bs=-0.028"],
    dramatic: ["eq=saturation=1.08:contrast=1.15:brightness=-0.016:gamma=0.96", "colorbalance=bs=0.030", "vignette=PI/7"],
    goal_gold: ["eq=saturation=1.28:contrast=1.12:brightness=0.025:gamma=1.03", "colorbalance=rs=0.090:gs=0.040:bs=-0.045", "unsharp=5:5:0.55:5:5:0", "fade=t=in:st=0:d=0.10:color=white"],
    replay_blue: ["eq=saturation=0.72:contrast=1.14:brightness=-0.020:gamma=0.96", "colorbalance=bs=0.075:bm=0.025"],
  };
  const filters = [...gradeFilters[grade]];
  if (intensity === "natural" && !["goal_gold", "replay_blue"].includes(grade)) filters.push("eq=saturation=0.96:contrast=0.99");
  if (moment.effect === "punch_zoom") {
    filters.push("scale=1166:2074:flags=lanczos", "crop=1080:1920:x=(iw-ow)/2:y=(ih-oh)/2");
  } else if (moment.effect === "slow_motion") {
    filters.push("unsharp=5:5:0.35:5:5:0");
  } else if (moment.effect === "speed_up") {
    filters.push("eq=saturation=1.08:contrast=1.04");
  }
  return `,${filters.join(",")}`;
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

async function makeCaptionFiles(moments, outputPath) {
  const files = new Map();
  const captionDir = resolve(dirname(outputPath), "captions");
  await mkdir(captionDir, { recursive: true });
  for (const [index, moment] of moments.entries()) {
    const text = moment.onScreenText || shortCaptionFromCommentary(moment.commentary);
    if (!text) continue;
    const path = resolve(captionDir, `${index}.txt`);
    await writeFile(path, wrapCaption(text));
    files.set(moment.id, path);
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

function shortCaptionFromCommentary(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 7).join(" ");
}

function wrapCaption(value, width = 22) {
  const words = String(value).replace(/[\r\n]+/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 7);
  const lines = [];
  let current = "";
  for (const word of words) {
    if (current && `${current} ${word}`.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 2).join("\n").toUpperCase();
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
