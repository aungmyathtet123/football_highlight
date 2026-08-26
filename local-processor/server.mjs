import http from "node:http";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { synthesizeGoogleCloudSpeech } from "./google-cloud-tts.mjs";
import { renderVideoV2 } from "./render-video-v2.mjs";
import {
  MAX_SCENE_SECONDS,
  assessPlannedSceneTracking,
  buildContentWritingPrompt,
  buildContinuousNarration,
  buildEvidenceAlignmentPrompt,
  contentPlanProblems,
  normalizeContentPlan,
  plannedSegmentDuration,
  rankSemanticBackups,
  selectDirectorCandidates,
  semanticBackupScore,
} from "./editorial-policy.mjs";
import {
  analyzeVideoIntelligenceFile,
  compactVideoIntelligenceEvidence,
  enrichMomentsWithVideoIntelligence,
  videoIntelligenceEnabled,
} from "./google-video-intelligence.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
await loadDotEnv(join(projectRoot, ".env"));

const port = Number(process.env.LOCAL_PROCESSOR_PORT || 8787);
const dataRoot = resolveSetting(process.env.LOCAL_DATA_DIR || "./local-data");
const uploadRoot = join(dataRoot, "uploads");
const outputRoot = join(dataRoot, "outputs");
const jobRoot = join(dataRoot, "jobs");
const ffmpegPath = resolveExecutable(process.env.FFMPEG_PATH || "ffmpeg");
const ffprobePath = resolveExecutable(process.env.FFPROBE_PATH || "ffprobe");
const trackingPythonPath = resolveExecutable(process.env.TRACKING_PYTHON || "./.venv-tracking/Scripts/python.exe");
const trackingScriptPath = resolveSetting(process.env.TRACKING_SCRIPT || "./local-processor/track-football-v2.py");
const trackingModelPath = resolveSetting(process.env.TRACKING_MODEL || "./tools/tracking/yolo11n.pt");
const trackingSampleFps = clamp(Number(process.env.TRACKING_SAMPLE_FPS || 8), 1, 12);
const trackingImageSize = Math.round(clamp(Number(process.env.TRACKING_IMAGE_SIZE || 960), 320, 1280));
const trackingConfidence = clamp(Number(process.env.TRACKING_CONFIDENCE || 0.08), 0.01, 0.8);
const analysisChunkSeconds = Math.round(clamp(Number(process.env.ANALYSIS_CHUNK_SECONDS || 240), 60, 600));
const analysisChunkOverlap = clamp(Number(process.env.ANALYSIS_CHUNK_OVERLAP || 4), 0, 12);
const analysisFps = clamp(Number(process.env.ANALYSIS_FPS || 3), 1, 8);
const analysisHeight = Math.round(clamp(Number(process.env.ANALYSIS_HEIGHT || 480), 360, 720));
const outputWidth = 1080;
const outputHeight = 1920;
const maxUploadBytes = 2 * 1024 * 1024 * 1024;
const allowedOrigins = new Set(
  ["http://localhost:3000", "http://127.0.0.1:3000", process.env.SITE_URL].filter(Boolean),
);
let queue = Promise.resolve();

await Promise.all([mkdir(uploadRoot, { recursive: true }), mkdir(outputRoot, { recursive: true }), mkdir(jobRoot, { recursive: true })]);

const server = http.createServer(async (request, response) => {
  try {
    setCors(request, response);
    if (request.method === "OPTIONS") return send(response, 204);
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      const tools = await inspectTools();
      return json(response, 200, {
        ok: tools.ffmpeg && tools.ffprobe && tools.trackingPython && tools.trackingModel,
        storage: dataRoot,
        analysisProvider: process.env.GEMINI_API_KEY ? (videoIntelligenceEnabled() ? "gemini+video_intelligence" : "gemini") : "local_fallback",
        videoIntelligence: videoIntelligenceEnabled(),
        ttsProvider: process.env.TTS_PROVIDER || "gemini",
        tools,
      });
    }
    if (request.method === "POST" && url.pathname === "/jobs") return await createJob(request, response);
    const retryAnalysisMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]+)\/retry-analysis$/i);
    if (request.method === "POST" && retryAnalysisMatch) return await retryAnalysisJob(response, retryAnalysisMatch[1]);
    const retryRenderMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]+)\/retry-render$/i);
    if (request.method === "POST" && retryRenderMatch) return await retryRenderJob(response, retryRenderMatch[1]);
    const jobMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]+)$/i);
    if (request.method === "GET" && jobMatch) return await getJob(response, jobMatch[1]);
    const outputMatch = url.pathname.match(/^\/outputs\/([a-f0-9-]+)\/final\.mp4$/i);
    if (request.method === "GET" && outputMatch) return await streamOutput(request, response, outputMatch[1]);
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return json(response, 500, { error: error instanceof Error ? error.message : "Unexpected processor error" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Touchline local processor: http://127.0.0.1:${port}`);
  console.log(`Private storage: ${dataRoot}`);
});

async function createJob(request, response) {
  const length = Number(request.headers["content-length"] || 0);
  if (length > maxUploadBytes) return json(response, 413, { error: "Video exceeds the 2 GB local limit." });
  const originalName = safeFileName(decodeURIComponent(String(request.headers["x-file-name"] || "source.mp4")));
  const contentType = String(request.headers["content-type"] || "application/octet-stream");
  if (!contentType.startsWith("video/")) return json(response, 415, { error: "Upload must be a video file." });
  const settings = parseSettings(String(request.headers["x-edit-settings"] || ""));
  const id = randomUUID();
  const uploadDir = join(uploadRoot, id);
  await mkdir(uploadDir, { recursive: true });
  const extension = [".mp4", ".mov", ".webm", ".mkv"].includes(extname(originalName).toLowerCase()) ? extname(originalName).toLowerCase() : ".mp4";
  const sourcePath = join(uploadDir, `source${extension}`);
  try {
    await receiveFile(request, sourcePath);
  } catch (error) {
    await rm(uploadDir, { recursive: true, force: true });
    throw error;
  }
  const now = new Date().toISOString();
  const job = {
    id, stage: "uploaded", progress: 5, sourceKey: sourcePath, sourceName: originalName,
    settings, moments: [], warnings: [], createdAt: now, updatedAt: now,
  };
  await saveJob(job);
  queue = queue.then(() => processJob(id)).catch((error) => console.error("Job queue error", error));
  return json(response, 202, publicJob(job));
}

async function retryAnalysisJob(response, id) {
  let job;
  try { job = await readJob(id); }
  catch { return json(response, 404, { error: "Job not found" }); }
  try { await stat(job.sourceKey); }
  catch { return json(response, 409, { error: "The saved source video is missing; upload it again." }); }
  const restarted = { ...job, moments: [], warnings: [], overlayMasks: [] };
  for (const key of ["error", "outputKey", "outputUrl", "completedAt", "qualityReview", "renderValidation", "editPlan", "trackingSummary"]) delete restarted[key];
  job = await updateJob(restarted, "uploaded", 5);
  queue = queue.then(() => processJob(id)).catch((queueError) => console.error("Job queue error", queueError));
  return json(response, 202, publicJob(job));
}
async function retryRenderJob(response, id) {
  let job;
  try { job = await readJob(id); }
  catch { return json(response, 404, { error: "Job not found" }); }
  if (!job.sourceKey || !job.media || !Array.isArray(job.moments)) return json(response, 409, { error: "This job does not have enough saved data to retry rendering." });
  const cleanJob = { ...job };
  delete cleanJob.error;
  job = await updateJob(cleanJob, "queued", 84);
  queue = queue.then(() => resumeRender(id)).catch((queueError) => console.error("Job queue error", queueError));
  return json(response, 202, publicJob(job));
}

async function resumeRender(id) {
  let job = await readJob(id);
  try {
    job = await updateJob(job, "tracking", 48);
    const originalSavedPlan = restoreOriginalPlannedScenes(job.moments, job.editPlan?.contentBeats);
    const orderedSavedMoments = restoreContentBeatOrder(originalSavedPlan, job.editPlan?.contentBeats);
    const trackingPool = buildTrackingPool(orderedSavedMoments);
    const tracking = await loadOrTrackFootball(job.sourceKey, trackingPool, job.media, id);
    let plannedMoments = applyTrackingQuality(orderedSavedMoments, tracking);
    let plannedDuration = selectedTimelineDuration(plannedMoments);
    if (plannedDuration < job.settings.targetDuration * 0.96) {
      plannedMoments = repairPlanWithTrackedBackups(orderedSavedMoments, plannedMoments, tracking, job.settings.targetDuration, job.settings.intensity);
      plannedMoments = restoreContentBeatOrder(plannedMoments, job.editPlan?.contentBeats);
      plannedDuration = selectedTimelineDuration(plannedMoments);
    }
    if (plannedMoments.filter((moment) => moment.selectedForFinalVideo).length < 2 || plannedDuration < job.settings.targetDuration * 0.68) {
      throw new Error(`Tracked primary and backup evidence can render only ${plannedDuration.toFixed(1)} seconds of the saved content plan.`);
    }
    job = await updateJob(job, "generating_commentary", 60, {
      moments: plannedMoments,
      trackingSummary: tracking.summary,
      editPlan: {
        ...job.editPlan,
        selectedCount: plannedMoments.filter((moment) => moment.selectedForFinalVideo).length,
        plannedDuration,
        narrationScript: buildContinuousNarration(plannedMoments),
      },
    });
    const ttsFiles = job.settings.commentary ? await loadSavedSpeech(plannedMoments, id) : new Map();
    const destination = join(outputRoot, id);
    await mkdir(destination, { recursive: true });
    const outputPath = join(destination, "final.mp4");
    job = await updateJob(job, "rendering", 84);
    const renderResult = await renderVideoV2(job.sourceKey, outputPath, plannedMoments, job.settings, job.media, ttsFiles, job.overlayMasks || [], tracking);
    await updateJob(job, "completed", 100, {
      editPlan: { ...job.editPlan, synchronization: renderResult.synchronization },
      outputKey: outputPath,
      outputUrl: `http://127.0.0.1:${port}/outputs/${id}/final.mp4`,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`Job ${id} render retry failed`, error);
    job.error = { code: "PROCESSING_FAILED", message: error instanceof Error ? error.message : "Processing failed", retryable: true };
    await updateJob(job, "failed", job.progress || 0);
  }
}
async function loadSavedSpeech(moments, id) {
  return makeSpeech(moments, id);
}

async function processJob(id) {
  let job = await readJob(id);
  try {
    job = await updateJob(job, "analyzing", 12);
    const media = await probe(job.sourceKey);
    job.media = media;
    let candidates;
    let overlayMasks = [];
    let editPlan;
    if (process.env.GEMINI_API_KEY) {
      const analysis = await analyzeWithGemini(job.sourceKey, media, job.settings.targetDuration, id);
      candidates = analysis.moments;
      overlayMasks = analysis.overlayMasks;
      job.analysisProvider = analysis.videoIntelligenceSummary?.processedChunks ? "gemini+video_intelligence" : "gemini";
      job.videoIntelligenceSummary = analysis.videoIntelligenceSummary;
      job.warnings.push(...analysis.warnings);
    } else {
      candidates = buildFallbackMoments(media.duration, job.settings.targetDuration);
      job.analysisProvider = "local_fallback";
      job.warnings.push("GEMINI_API_KEY is not configured. This edit uses evenly sampled source sections without invented commentary.");
    }
    job = await updateJob(job, "detecting_moments", 30, {
      moments: candidates,
      overlayMasks,
      videoIntelligenceSummary: job.videoIntelligenceSummary,
    });
    job = await updateJob(job, "writing_content", 36);
    let contentPlan;
    if (process.env.GEMINI_API_KEY) {
      try {
        contentPlan = await writeAnalysisContentWithGemini(candidates, media, job.settings);
      } catch (error) {
        job.warnings.push(`The AI content-writing pass failed validation, so a conservative evidence-based script was used: ${sanitizeProviderError(String(error?.message || error))}`);
        contentPlan = buildDeterministicContentPlan(candidates, job.settings);
      }
    } else contentPlan = buildDeterministicContentPlan(candidates, job.settings);
    job = await updateJob(job, "aligning_content", 44, {
      editPlan: {
        title: contentPlan.title,
        editorialThesis: contentPlan.editorialThesis,
        contentAngle: contentPlan.contentAngle,
        storyQuestion: contentPlan.storyQuestion,
        storyAnswer: contentPlan.storyAnswer,
        contentBeats: contentPlan.contentBeats,
        contentScript: contentPlan.contentScript,
        wordCount: contentPlan.wordCount,
        candidateCount: candidates.length,
      },
    });
    if (process.env.GEMINI_API_KEY) {
      try {
        editPlan = await alignContentToVideoWithGemini(contentPlan, candidates, job.settings);
      } catch (error) {
        job.warnings.push(`The AI evidence-alignment pass failed, so the approved content was mapped conservatively: ${sanitizeProviderError(String(error?.message || error))}`);
        editPlan = buildDeterministicEditPlan(candidates, job.settings, contentPlan);
      }
    } else editPlan = buildDeterministicEditPlan(candidates, job.settings, contentPlan);
    let selected = applyEditPlan(candidates, editPlan, job.settings.targetDuration);
    selected = restoreContentBeatOrder(selected, contentPlan.contentBeats);
    let selectedDuration = selectedTimelineDuration(selected);
    if (selectedDuration < job.settings.targetDuration * 0.68) {
      job.warnings.push(`The first evidence alignment produced only ${selectedDuration.toFixed(1)} seconds after validation, so it was rebuilt from the approved content before tracking.`);
      editPlan = buildDeterministicEditPlan(candidates, job.settings, contentPlan);
      selected = applyEditPlan(candidates, editPlan, job.settings.targetDuration);
      selected = restoreContentBeatOrder(selected, contentPlan.contentBeats);
      selectedDuration = selectedTimelineDuration(selected);
    }
    if (selectedDuration < job.settings.targetDuration * 0.68) {
      throw new Error(`The approved content could map to only ${selectedDuration.toFixed(1)} seconds of valid footage. The editor will not produce another misleading short result.`);
    }
    job = await updateJob(job, "tracking", 52, {
      moments: selected,
      editPlan: {
        ...job.editPlan,
        rationale: editPlan.rationale || "",
        plannedDuration: selectedDuration,
        selectedCount: selected.filter((moment) => moment.selectedForFinalVideo).length,
      },
    });
    const plannedMoments = selected;
    const trackingPool = buildTrackingPool(plannedMoments);
    const tracking = await trackFootball(job.sourceKey, trackingPool, media, id);
    selected = applyTrackingQuality(plannedMoments, tracking);
    let frameableDuration = selectedTimelineDuration(selected);
    if (frameableDuration < job.settings.targetDuration * 0.96) {
      selected = repairPlanWithTrackedBackups(plannedMoments, selected, tracking, job.settings.targetDuration, job.settings.intensity);
      selected = restoreContentBeatOrder(selected, contentPlan.contentBeats);
      frameableDuration = selectedTimelineDuration(selected);
    }
    const frameable = selected.filter((moment) => moment.selectedForFinalVideo);
    if (frameable.length < 2 || frameableDuration < job.settings.targetDuration * 0.68) {
      throw new Error(`Tracked primary and backup evidence could preserve only ${frameableDuration.toFixed(1)} seconds of the approved content plan.`);
    }
    job = await updateJob(job, "tracking", 56, {
      moments: selected,
      trackingSummary: tracking.summary,
      editPlan: {
        ...job.editPlan,
        selectedCount: frameable.length,
        plannedDuration: frameableDuration,
        narrationScript: buildContinuousNarration(selected),
      },
    });
    if (tracking.summary.ballDetectionCoverage < 0.08) job.warnings.push("Ball detection was weak; gameplay scenes that failed the full-screen ball-and-player framing gate were rejected.");
    if (Number(tracking.summary.jointFitCoverage || 0) < 0.55) job.warnings.push("Some gameplay scenes could not fit the football and involved player together in full-screen 9:16, so they were removed instead of letterboxed.");
    if (job.settings.logoMasking && overlayMasks.length === 0) job.warnings.push("No persistent logo or watermark region was confidently detected, so no mask was applied.");
    job = await updateJob(job, "generating_commentary", 60);
    const ttsFiles = job.settings.commentary ? await makeSpeech(selected, id) : new Map();
    if (job.settings.commentary && ttsFiles.size === 0 && selected.some((moment) => moment.commentary)) {
      job.warnings.push("Google Cloud TTS produced no narration audio; the result contains silence because source audio is muted in commentary mode.");
    }
    if (job.settings.captions && !selected.some((moment) => moment.commentary)) job.warnings.push("No evidence-based commentary text was available, so no captions were burned in.");
    job = await updateJob(job, "editing", 72);
    const destination = join(outputRoot, id);
    await mkdir(destination, { recursive: true });
    const outputPath = join(destination, "final.mp4");
    job = await updateJob(job, "rendering", 84);
    const renderResult = await renderVideoV2(job.sourceKey, outputPath, selected, job.settings, media, ttsFiles, overlayMasks, tracking);
    job = await updateJob(job, "validating", 96, {
      editPlan: { ...job.editPlan, synchronization: renderResult.synchronization },
    });
    const renderValidation = await validateRenderedVideo(outputPath, job.settings);
    let qualityReview;
    if (process.env.GEMINI_API_KEY) {
      try {
        qualityReview = await reviewRenderedVideoWithGemini(outputPath, renderValidation.media, id, job.settings);
        if (!qualityReview.approved) {
          const issues = qualityReview.issues.slice(0, 3).join("; ");
          job.warnings.push(`AI quality review scored this edit ${qualityReview.score}/100${issues ? `: ${issues}` : "."}`);
        }
      } catch (error) {
        job.warnings.push(`The final AI quality review could not run: ${sanitizeProviderError(String(error?.message || error))}`);
      }
    }
    job = await updateJob(job, "completed", 100, {
      outputKey: outputPath,
      outputUrl: `http://127.0.0.1:${port}/outputs/${id}/final.mp4`,
      renderValidation,
      qualityReview,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`Job ${id} failed`, error);
    job.error = { code: "PROCESSING_FAILED", message: error instanceof Error ? error.message : "Processing failed", retryable: true };
    await updateJob(job, "failed", job.progress || 0);
  }
}
async function analyzeWithGemini(sourcePath, media, targetDuration, id) {
  const model = process.env.GEMINI_MODEL;
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is missing.");
  if (!process.env.GOOGLE_CLOUD_PROJECT || !process.env.GOOGLE_CLOUD_LOCATION) throw new Error("GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION are required for Gemini.");
  if (!model) throw new Error("GEMINI_MODEL is required; no fallback model is configured.");
  const ai = new GoogleGenAI({ vertexai: true, apiKey: process.env.GEMINI_API_KEY });
  const proxies = await createAnalysisProxies(sourcePath, media, id);
  const discoveredMoments = [];
  const discoveredMasks = [];
  const warnings = [];
  const visionSummaries = [];
  try {
    for (const [index, excerpt] of proxies.entries()) {
      let visionEvidence;
      if (videoIntelligenceEnabled()) {
        try {
          visionEvidence = await analyzeVideoIntelligenceFile(excerpt.path, excerpt.startTime);
          visionSummaries.push(visionEvidence.summary);
        } catch (error) {
          warnings.push(`Google Video Intelligence could not analyze excerpt ${index + 1}; Gemini continued without it: ${sanitizeProviderError(String(error?.message || error))}`);
        }
      }
      const proxy = await readFile(excerpt.path);
      const contents = [
        { inlineData: { data: proxy.toString("base64"), mimeType: "video/mp4" } },
        { text: buildAnalysisPrompt(targetDuration, excerpt, index + 1, proxies.length, Boolean(visionEvidence)) },
      ];
      if (visionEvidence) contents.push({
        text: `Supporting Google Video Intelligence evidence follows. Its timestamps are ABSOLUTE source-video seconds; your requested output timestamps must remain RELATIVE to this excerpt. Treat object labels as supporting evidence, verify all events from the video, and never infer a goal merely from a ball/person track.\n${JSON.stringify(compactVideoIntelligenceEvidence(visionEvidence))}`,
      });
      const response = await ai.models.generateContent({
        model,
        contents,
        config: { responseMimeType: "application/json", temperature: 0.15 },
      });
      let parsed = JSON.parse(response.text || "{}");
      let normalized = normalizeMoments(parsed.moments, media.duration, excerpt.startTime);
      if (normalized.length === 0) {
        warnings.push(`Gemini returned no usable numeric moments for excerpt ${index + 1}; the processor retried that excerpt with a simplified recovery prompt.`);
        const retryContents = [
          { inlineData: { data: proxy.toString("base64"), mimeType: "video/mp4" } },
          { text: buildAnalysisRecoveryPrompt(excerpt, index + 1, proxies.length) },
        ];
        if (visionEvidence) retryContents.push({
          text: `Supporting shot/object evidence with ABSOLUTE source timestamps follows. The response itself must still use numeric seconds RELATIVE to this excerpt.\n${JSON.stringify(compactVideoIntelligenceEvidence(visionEvidence))}`,
        });
        const retryResponse = await ai.models.generateContent({
          model,
          contents: retryContents,
          config: { responseMimeType: "application/json", temperature: 0.05 },
        });
        parsed = JSON.parse(retryResponse.text || "{}");
        normalized = normalizeMoments(parsed.moments, media.duration, excerpt.startTime);
      }
      if (normalized.length === 0) {
        warnings.push(`Gemini could not identify usable football scenes in excerpt ${index + 1}; that excerpt was skipped instead of stopping the whole job.`);
        continue;
      }
      discoveredMoments.push(...enrichMomentsWithVideoIntelligence(normalized, visionEvidence));
      discoveredMasks.push(...normalizeMasks(parsed.overlayMasks));
    }
    const moments = mergeAnalyzedMoments(discoveredMoments);
    if (moments.length === 0) throw new Error("Gemini could not return numeric football scenes after retrying every analysis excerpt.");
    return {
      moments,
      overlayMasks: mergeOverlayMasks(discoveredMasks),
      warnings,
      videoIntelligenceSummary: summarizeVideoIntelligence(visionSummaries, proxies.length),
    };
  } catch (error) {
    throw classifyGeminiError(error, model);
  }
}

function buildAnalysisPrompt(targetDuration, excerpt, chunkNumber, chunkCount, hasVideoIntelligence = false) {
  return [
    `You are the first-pass football video analyst for a professional short-form editor. Analyze every visible scene and all audio in excerpt ${chunkNumber} of ${chunkCount}.`,
    `This excerpt starts at source time ${excerpt.startTime.toFixed(3)} seconds and lasts ${excerpt.duration.toFixed(3)} seconds. Return all startTime and endTime values RELATIVE TO THIS EXCERPT, beginning at zero.`,
    `The eventual montage target is about ${targetDuration} seconds, but do not select the final edit yet. Build a comprehensive candidate/story timeline first.`,
    "Return JSON only with top-level moments and overlayMasks arrays.",
    "For moments, identify observable football micro-scenes of 1.2 to 5.0 seconds: anticipation or build-up, skill/pass/dribble, decisive action, result, reaction/celebration, and replay when present. Split longer actions at natural visual boundaries while keeping the same storyId. Include useful context and explicitly identify weak footage.",
    "Every moment must contain: startTime, endTime, eventType (goal|penalty|assist|big_chance|shot_on_target|save|foul|yellow_card|red_card|free_kick|var|skill|dribble|tackle|celebration|normal_play), storyId, storyPhase (hook|build_up|action|payoff|reaction|replay|standalone), keepDecision (keep|support|replay|reject), importanceScore 0-100, hookScore 0-100, flowScore 0-100, visualClarity 0-100, excitementScore 0-100, narrativeCompleteness 0-100, description, rejectReason, confidence 0-1, ballVisible, mainPlayerVisible, isReplay, commentary, analysisPurpose, onScreenText, and focusX 0-1.",
    "Prefer complete actions with a few seconds of context. Do not merge unrelated events. Do not discard replays; label them so the edit director can decide. Mark obstructed, static, duplicate, irrelevant, or unclear footage as reject.",
    "Never invent names, teams, scores, or events. Commentary must be one short evidence-based analytical sentence that adds explanation, criticism, or meaning rather than merely announcing what happens. analysisPurpose must state why this exact excerpt is needed. onScreenText must be a clean 2-to-6-word hook, never a paragraph.",
    "For gameplay, mark keep or support only when the relevant player and football are both visible in the same composition. Player-only footage is allowed only for a celebration, reaction, or introduction. Do not select ball-only or player-only running footage.",
    hasVideoIntelligence ? "Use the supplied shot boundaries and tracked-object coordinates to improve temporal precision and horizontal focus, while trusting the visible video over an incorrect generic object label." : "",
    "Return an empty overlayMasks array for ownership logos or attribution watermarks. Fair-use commentary does not require concealing ownership information.",
  ].filter(Boolean).join(" ");
}

function buildAnalysisRecoveryPrompt(excerpt, chunkNumber, chunkCount) {
  return [
    `Re-inspect football excerpt ${chunkNumber} of ${chunkCount}. The previous response contained no usable moments.`,
    `The excerpt duration is ${excerpt.duration.toFixed(3)} seconds. Return startTime and endTime as JSON numbers in seconds RELATIVE to this excerpt, from 0 through ${excerpt.duration.toFixed(3)}. Never use HH:MM:SS strings.`,
    "Return JSON only as {moments:[...],overlayMasks:[]}. If football is visible, return at least four distinct observable 1.2-to-5.0-second scenes. Include weak or obstructed scenes with keepDecision reject instead of returning an empty array.",
    "Every moment requires startTime, endTime, eventType, storyId, storyPhase, keepDecision, importanceScore, hookScore, flowScore, visualClarity, excitementScore, narrativeCompleteness, description, rejectReason, confidence, ballVisible, mainPlayerVisible, isReplay, commentary, analysisPurpose, onScreenText, and focusX.",
    "Use eventType goal|penalty|assist|big_chance|shot_on_target|save|foul|yellow_card|red_card|free_kick|var|skill|dribble|tackle|celebration|normal_play. Do not invent identities, scores, or outcomes. Commentary must explain only visible evidence.",
  ].join(" ");
}

function summarizeVideoIntelligence(summaries, totalChunks) {
  if (!summaries.length) return videoIntelligenceEnabled() ? { enabled: true, processedChunks: 0, totalChunks } : undefined;
  const labels = {};
  for (const summary of summaries) {
    for (const [label, count] of Object.entries(summary.labels || {})) labels[label] = (labels[label] || 0) + count;
  }
  return {
    enabled: true,
    processedChunks: summaries.length,
    totalChunks,
    shotCount: summaries.reduce((total, item) => total + item.shotCount, 0),
    objectTrackCount: summaries.reduce((total, item) => total + item.objectTrackCount, 0),
    personTrackCount: summaries.reduce((total, item) => total + item.personTrackCount, 0),
    labels,
  };
}

async function createAnalysisProxies(sourcePath, media, id) {
  const directory = join(outputRoot, id, "analysis");
  await mkdir(directory, { recursive: true });
  const excerpts = [];
  const step = Math.max(30, analysisChunkSeconds - analysisChunkOverlap);
  for (let startTime = 0, index = 0; startTime < media.duration - 0.05; startTime += step, index += 1) {
    const duration = Math.min(analysisChunkSeconds, media.duration - startTime);
    const proxyPath = join(directory, `video-proxy-${String(index + 1).padStart(3, "0")}.mp4`);
    const targetBytes = 13.5 * 1024 * 1024;
    const totalKbps = targetBytes * 8 / Math.max(1, duration) / 1000;
    const videoKbps = Math.round(clamp(totalKbps - (media.hasAudio ? 36 : 0), 140, 900));
    const args = [
      "-hide_banner", "-y", "-ss", startTime.toFixed(3), "-i", sourcePath, "-t", duration.toFixed(3),
      "-vf", `fps=${analysisFps},scale=-2:${analysisHeight}`,
      "-c:v", "libx264", "-preset", "veryfast", "-b:v", `${videoKbps}k`, "-maxrate", `${videoKbps}k`, "-bufsize", `${videoKbps * 2}k`, "-pix_fmt", "yuv420p",
    ];
    if (media.hasAudio) args.push("-c:a", "aac", "-b:a", "32k", "-ac", "1", "-ar", "16000");
    else args.push("-an");
    args.push("-movflags", "+faststart", proxyPath);
    await run(ffmpegPath, args);
    const info = await stat(proxyPath);
    if (info.size > 15 * 1024 * 1024) throw new Error(`Gemini analysis excerpt ${index + 1} exceeds the safe inline upload limit.`);
    excerpts.push({ path: proxyPath, startTime, duration });
    if (startTime + duration >= media.duration - 0.05) break;
  }
  return excerpts;
}

function compactPlanningCandidates(candidates) {
  return selectDirectorCandidates(candidates).map((moment) => ({
    id: moment.id,
    startTime: moment.startTime,
    endTime: moment.endTime,
    eventType: moment.eventType,
    storyId: moment.storyId,
    storyPhase: moment.storyPhase,
    keepDecision: moment.keepDecision,
    importanceScore: moment.importanceScore,
    hookScore: moment.hookScore,
    flowScore: moment.flowScore,
    visualClarity: moment.visualClarity,
    excitementScore: moment.excitementScore,
    narrativeCompleteness: moment.narrativeCompleteness,
    confidence: moment.confidence,
    ballVisible: moment.ballVisible,
    mainPlayerVisible: moment.mainPlayerVisible,
    isReplay: moment.isReplay,
    description: moment.description,
    analysisPurpose: moment.analysisPurpose || "",
    videoIntelligence: moment.videoIntelligence,
  }));
}

async function writeAnalysisContentWithGemini(candidates, media, settings) {
  const ai = new GoogleGenAI({ vertexai: true, apiKey: process.env.GEMINI_API_KEY });
  const prompt = buildContentWritingPrompt({ sourceDuration: media.duration, targetDuration: settings.targetDuration });
  const timeline = compactPlanningCandidates(candidates);
  let response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL,
    contents: [{ text: prompt }, { text: JSON.stringify({ completeObservationTimeline: timeline }) }],
    config: { responseMimeType: "application/json", temperature: 0.16 },
  });
  let content = normalizeContentPlan(JSON.parse(response.text || "{}"), settings.targetDuration);
  let problems = contentPlanProblems(content, settings.targetDuration);
  if (problems.length) {
    response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL,
      contents: [
        { text: prompt },
        { text: "Rewrite the content completely. Correct these validation failures: " + problems.join(", ") + ". Return the required JSON only." },
        { text: JSON.stringify({ completeObservationTimeline: timeline, rejectedDraft: content }) },
      ],
      config: { responseMimeType: "application/json", temperature: 0.1 },
    });
    content = normalizeContentPlan(JSON.parse(response.text || "{}"), settings.targetDuration);
    problems = contentPlanProblems(content, settings.targetDuration);
  }
  if (problems.length) throw new Error("Gemini content draft failed validation: " + problems.join(", "));
  return content;
}

async function alignContentToVideoWithGemini(content, candidates, settings) {
  const ai = new GoogleGenAI({ vertexai: true, apiKey: process.env.GEMINI_API_KEY });
  const prompt = buildEvidenceAlignmentPrompt({ targetDuration: settings.targetDuration, intensity: settings.intensity });
  const timeline = compactPlanningCandidates(candidates);
  const beatMap = new Map(content.contentBeats.map((beat) => [beat.beatId, beat]));
  const requestAlignment = async (correction = "") => {
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL,
      contents: [
        { text: prompt + (correction ? " " + correction : "") },
        { text: JSON.stringify({ approvedContent: content, completeObservationTimeline: timeline }) },
      ],
      config: { responseMimeType: "application/json", temperature: 0.08 },
    });
    const parsed = JSON.parse(response.text || "{}");
    const seenBeats = new Set();
    const segments = (Array.isArray(parsed.segments) ? parsed.segments : []).map((segment) => {
      const beat = beatMap.get(String(segment.beatId));
      const firstForBeat = beat && !seenBeats.has(beat.beatId);
      if (beat) seenBeats.add(beat.beatId);
      return {
        ...segment,
        beatId: beat?.beatId || String(segment.beatId || ""),
        commentary: firstForBeat ? beat.narration : "",
        onScreenText: segment.onScreenText || beat?.captionText,
        analysisPurpose: segment.analysisPurpose || beat?.evidenceNeed,
      };
    });
    return { rationale: String(parsed.rationale || "Content-led evidence alignment"), segments };
  };
  let alignment = await requestAlignment();
  let duration = plannedSegmentDuration(alignment.segments);
  const coveredBeats = new Set(alignment.segments.map((segment) => segment.beatId)).size;
  if (duration < settings.targetDuration * 0.96 || coveredBeats < content.contentBeats.length) {
    alignment = await requestAlignment(
      "The previous alignment was incomplete. Cover every beat exactly once with narration, add supporting evidence clips when needed, and make the visual timeline at least "
      + settings.targetDuration + " seconds without exceeding " + (settings.targetDuration + 3) + " seconds.",
    );
    duration = plannedSegmentDuration(alignment.segments);
  }
  const finalCoveredBeats = new Set(alignment.segments.filter((segment) => segment.commentary).map((segment) => segment.beatId)).size;
  if (duration < settings.targetDuration * 0.96 || finalCoveredBeats < content.contentBeats.length) {
    throw new Error("Gemini evidence alignment did not cover the complete 60-second content plan.");
  }
  return { ...content, rationale: alignment.rationale, plannedDuration: duration, segments: alignment.segments };
}
function classifyGeminiError(error, model) {
  const raw = String(error?.message || error);
  if (/api key|unauthenticated|permission_denied|401|403/i.test(raw)) return new Error("Gemini authentication failed. Verify the Agent Platform API key and project access.");
  if (/model|not found|unsupported|404/i.test(raw)) return new Error(`Gemini model ${model} is unavailable for this Agent Platform key. No fallback model was selected.`);
  if (/quota|billing|resource_exhausted|429/i.test(raw)) return new Error("Gemini quota or billing prevented video analysis.");
  return new Error(`Gemini video analysis failed: ${sanitizeProviderError(raw)}`);
}

function sanitizeProviderError(message) { return message.replace(/AQ\.[A-Za-z0-9._-]+/g, "[REDACTED]").slice(0, 700); }
function normalizeMasks(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => ({
    id: `overlay-${index + 1}`, kind: "watermark",
    x: clamp(Number(item.x), 0, 1), y: clamp(Number(item.y), 0, 1),
    width: clamp(Number(item.width), 0, 1), height: clamp(Number(item.height), 0, 1),
    confidence: clamp(Number(item.confidence), 0, 1),
  })).filter((item) => item.confidence >= 0.7 && item.width >= 0.01 && item.height >= 0.01 && item.x + item.width <= 1.01 && item.y + item.height <= 1.01);
}

function normalizeMoments(items, duration, offset = 0) {
  const eventTypes = new Set(["goal", "penalty", "assist", "big_chance", "shot_on_target", "save", "foul", "yellow_card", "red_card", "free_kick", "var", "skill", "dribble", "tackle", "celebration", "normal_play"]);
  if (!Array.isArray(items)) return [];
  const normalized = items.flatMap((item, index) => {
    const rawStart = Number(item.startTime);
    const rawEnd = Number(item.endTime);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawEnd <= 0) return [];
    const startTime = clamp(offset + rawStart, 0, duration);
    const endTime = clamp(offset + rawEnd, 0, duration);
    if (endTime - startTime < 1) return [];
    const focusX = clamp(Number(item.focusX ?? 0.5), 0, 1);
    const importance = scoreField(item.importanceScore, 45);
    const hookScore = scoreField(item.hookScore, importance);
    const flowScore = scoreField(item.flowScore, importance);
    const visualClarity = scoreField(item.visualClarity, importance);
    const excitementScore = scoreField(item.excitementScore, importance);
    const narrativeCompleteness = scoreField(item.narrativeCompleteness, importance);
    const editorialScore = Math.round(
      importance * 0.34 + hookScore * 0.14 + flowScore * 0.12 + visualClarity * 0.14
      + excitementScore * 0.12 + narrativeCompleteness * 0.14,
    );
    const keepDecision = ["keep", "support", "replay", "reject"].includes(item.keepDecision) ? item.keepDecision : "keep";
    const storyPhase = ["hook", "build_up", "action", "payoff", "reaction", "replay", "standalone"].includes(item.storyPhase) ? item.storyPhase : "standalone";
    const storyKey = String(item.storyId || `scene-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
    return [{
      id: `candidate-${Math.round(offset * 1000)}-${index + 1}`, startTime, endTime,
      eventType: eventTypes.has(item.eventType) ? item.eventType : "normal_play",
      storyId: `story-${Math.round(offset)}-${storyKey}`, storyPhase, keepDecision,
      importanceScore: editorialScore, sourceImportanceScore: importance,
      hookScore, flowScore, visualClarity, excitementScore, narrativeCompleteness,
      description: String(item.description || "Observed football passage").slice(0, 240),
      rejectReason: String(item.rejectReason || "").slice(0, 200) || undefined,
      confidence: clamp(Number(item.confidence), 0, 1), ballVisible: Boolean(item.ballVisible), mainPlayerVisible: Boolean(item.mainPlayerVisible),
      isReplay: Boolean(item.isReplay) || storyPhase === "replay" || keepDecision === "replay",
      recommendedCrop: [{ time: startTime, x: focusX, y: 0.5, confidence: clamp(Number(item.confidence), 0, 1) }],
      selectedForFinalVideo: false,
      commentary: String(item.commentary || "").slice(0, 220) || undefined,
      analysisPurpose: String(item.analysisPurpose || "").slice(0, 180) || undefined,
      onScreenText: cleanOverlayText(item.onScreenText, 6),
    }];
  });
  return normalized.sort((a, b) => a.startTime - b.startTime);
}

function scoreField(value, fallback) {
  const number = Number(value);
  return Math.round(clamp(Number.isFinite(number) ? number : fallback, 0, 100));
}

function mergeAnalyzedMoments(items) {
  const unique = [...items]
    .sort((a, b) => b.importanceScore - a.importanceScore || b.confidence - a.confidence)
    .filter((item, index, ranked) => !ranked.slice(0, index).some((existing) => (
      temporalOverlap(item, existing) >= 0.82
      && item.eventType === existing.eventType
      && item.storyPhase === existing.storyPhase
    )))
    .sort((a, b) => a.startTime - b.startTime);
  return unique.map((item, index) => ({ ...item, id: `gemini-${index + 1}` }));
}

function mergeOverlayMasks(items) {
  return [...items]
    .sort((a, b) => b.confidence - a.confidence)
    .filter((item, index, ranked) => !ranked.slice(0, index).some((existing) => (
      Math.abs(item.x - existing.x) < 0.035
      && Math.abs(item.y - existing.y) < 0.035
      && Math.abs(item.width - existing.width) < 0.05
      && Math.abs(item.height - existing.height) < 0.05
    )))
    .map((item, index) => ({ ...item, id: `overlay-${index + 1}` }));
}

function temporalOverlap(a, b) {
  const overlap = Math.max(0, Math.min(a.endTime, b.endTime) - Math.max(a.startTime, b.startTime));
  return overlap / Math.max(0.001, Math.min(a.endTime - a.startTime, b.endTime - b.startTime));
}
function buildFallbackMoments(duration, targetDuration) {
  const desiredDuration = Math.min(duration, targetDuration);
  const clipLength = Math.min(duration, Math.min(8, Math.max(4, desiredDuration / 9)));
  const count = Math.max(1, Math.min(10, Math.ceil(desiredDuration / clipLength)));
  const maximumStart = Math.max(0, duration - clipLength);
  return Array.from({ length: count }, (_, index) => {
    const startTime = count === 1 ? 0 : (maximumStart * index) / (count - 1);
    return {
      id: `sample-${index + 1}`, startTime, endTime: Math.min(duration, startTime + clipLength), eventType: "normal_play",
      importanceScore: 40, description: "Motion-sampled section from the source video", confidence: 1,
      ballVisible: false, mainPlayerVisible: false,
      recommendedCrop: [{ time: startTime, x: 0.5, y: 0.5, confidence: 0.5 }], selectedForFinalVideo: false,
    };
  });
}

function buildDeterministicContentPlan(candidates, settings) {
  const evidence = [...candidates]
    .filter((moment) => moment.keepDecision !== "reject" && framingEligible(moment))
    .sort((a, b) => Number(b.importanceScore || 0) - Number(a.importanceScore || 0));
  const templates = [
    "Pressure changes the passing angles before the decisive finish becomes possible.",
    "One defender follows the ball, opening a second route forward.",
    "The attacker recognizes that space before the defensive line can recover.",
    "Arriving later would let the covering player close that gap.",
    "The next touch forces another defender to commit toward the ball.",
    "That step creates a cleaner lane into the dangerous area.",
    "Strong control and body position preserve every attacking option.",
    "The defence works hard, but each reaction arrives slightly late.",
    "A second angle confirms how quickly the spacing changes during buildup.",
    "The goalkeeper and nearest defender react instead of controlling events.",
    "Early recognition, precise timing, and execution combine to decide the outcome.",
    "The advantage exists before the final touch makes it obvious.",
  ];
  const beats = templates.map((narration, index) => {
    const moment = evidence[index % Math.max(1, evidence.length)];
    return {
      beatId: "beat-" + (index + 1),
      role: index === 0 ? "hook" : index === templates.length - 1 ? "conclusion" : "analysis",
      narration,
      evidenceNeed: moment?.description || "Visible evidence of the player, ball, and defensive reaction.",
      captionText: ["THE REAL CAUSE", "SPACE OPENS", "TIMING MATTERS", "ONE LATE STEP"][index % 4],
    };
  });
  return normalizeContentPlan({
    title: "Why the move succeeds",
    editorialThesis: "The decisive outcome is created by connected movement, timing, and defensive reactions before the final action.",
    contentAngle: "Explain the causal chain rather than announcing visible events.",
    storyQuestion: "Which decisions create the decisive advantage?",
    storyAnswer: "Early recognition and coordinated movement force the defence into late reactions.",
    contentBeats: beats,
  }, settings.targetDuration);
}

function buildDeterministicEditPlan(candidates, settings, contentPlan) {
  const ranked = candidates
    .filter((moment) => moment.keepDecision !== "reject" && moment.confidence >= 0.4 && framingEligible(moment))
    .sort((a, b) => Number(b.importanceScore || 0) - Number(a.importanceScore || 0));
  const hook = [...ranked].sort((a, b) => Number(b.hookScore || 0) - Number(a.hookScore || 0))[0];
  const ordered = [
    ...(hook ? [hook] : []),
    ...ranked.filter((moment) => moment.id !== hook?.id).sort((a, b) => a.startTime - b.startTime),
  ];
  let total = 0;
  const selected = [];
  for (const moment of ordered) {
    if (total >= settings.targetDuration) break;
    const effect = deterministicEffect(moment, settings.intensity);
    const playbackRate = effect === "slow_motion" ? 0.84 : effect === "speed_up" ? 1.12 : 1;
    const sourceLength = Math.min(MAX_SCENE_SECONDS * playbackRate, moment.endTime - moment.startTime);
    const remaining = settings.targetDuration - total;
    const desiredOutput = Math.min(sourceLength / playbackRate, remaining + 0.2);
    if (desiredOutput < 1.2) continue;
    const beat = contentPlan.contentBeats[selected.length] || null;
    selected.push({
      candidateId: moment.id,
      beatId: beat?.beatId || "support-" + (selected.length + 1),
      startTime: moment.startTime,
      endTime: Math.min(moment.endTime, moment.startTime + desiredOutput * playbackRate),
      editOrder: selected.length,
      role: beat?.role || moment.storyPhase || "evidence",
      transitionIn: selected.length === 0 ? "cut" : moment.isReplay ? "flash" : "cut",
      transitionDuration: selected.length === 0 ? 0.04 : moment.isReplay ? 0.12 : 0.06,
      effect,
      playbackRate,
      playerHighlight: moment.mainPlayerVisible && (moment.ballVisible || playerOnlyAllowed(moment)),
      commentary: beat?.narration || "",
      analysisPurpose: beat?.evidenceNeed || moment.analysisPurpose || "Support the approved football analysis with visible evidence.",
      onScreenText: beat?.captionText || moment.onScreenText || eventHeadline(moment),
      eventCallout: calloutForEvent(moment),
      colorGrade: gradeForScene(moment),
      soundEffect: soundForEvent(moment),
    });
    total += desiredOutput - (selected.length === 1 ? 0 : selected.at(-1).transitionDuration);
  }
  return {
    ...contentPlan,
    rationale: "Content-first conservative evidence alignment",
    plannedDuration: total,
    segments: selected,
  };
}

function selectedTimelineDuration(moments) {
  return moments
    .filter((moment) => moment.selectedForFinalVideo)
    .sort((a, b) => Number(a.editOrder) - Number(b.editOrder))
    .reduce((total, moment, index) => {
      const rate = clamp(Number(moment.playbackRate || 1), 0.72, 1.18);
      const transition = index === 0 ? 0 : clamp(Number(moment.transitionDuration || 0.04), 0.04, 0.36);
      return total + (moment.endTime - moment.startTime) / rate - transition;
    }, 0);
}
function deterministicEffect(moment, intensity) {
  if (intensity === "natural") return moment.isReplay ? "replay_treatment" : "none";
  if (moment.isReplay) return "replay_treatment";
  if (["goal", "save", "shot_on_target", "big_chance"].includes(moment.eventType)) return "slow_motion";
  if (["skill", "dribble", "assist"].includes(moment.eventType)) return "punch_zoom";
  return intensity === "high_energy" ? "speed_up" : "none";
}

function playerOnlyAllowed(moment) {
  return moment.eventType === "celebration" || ["reaction"].includes(moment.storyPhase) || ["reaction"].includes(moment.role);
}

function framingEligible(moment) {
  return playerOnlyAllowed(moment) || (Boolean(moment.ballVisible) && Boolean(moment.mainPlayerVisible));
}

function normalizeChoice(value, choices, fallback) {
  return choices.includes(value) ? value : fallback;
}

function cleanOverlayText(value, maximumWords = 6) {
  const words = String(value || "").replace(/[\r\n]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  return words.slice(0, maximumWords).join(" ").slice(0, 64);
}

function eventHeadline(moment) {
  const headlines = {
    goal: "WHAT A FINISH",
    penalty: "THE DECISIVE MOMENT",
    assist: "PERFECTLY WEIGHTED PASS",
    big_chance: "SO CLOSE",
    shot_on_target: "WHAT A SHOT",
    save: "GREAT SAVE",
    foul: "CLEAR FOUL",
    yellow_card: "YELLOW CARD",
    red_card: "RED CARD",
    free_kick: "SET PIECE DANGER",
    var: "DECISION UNDER REVIEW",
    skill: "AMAZING CONTROL",
    dribble: "DEFENDER BEATEN",
    tackle: "PERFECTLY TIMED",
    celebration: "PURE EMOTION",
    normal_play: "WATCH THE MOVEMENT",
  };
  return headlines[moment.eventType] || "KEY MOMENT";
}

function calloutForEvent(moment) {
  if (moment.eventType === "goal") return "goal";
  if (["yellow_card", "red_card"].includes(moment.eventType)) return "card";
  if (moment.eventType === "foul") return "foul";
  if (moment.eventType === "save") return "save";
  if (moment.eventType === "shot_on_target") return "shot";
  if (moment.eventType === "big_chance") return "close";
  if (moment.eventType === "assist") return "pass";
  if (["skill", "dribble"].includes(moment.eventType)) return "amazing";
  if (moment.eventType === "celebration") return "celebration";
  return "none";
}

function soundForEvent(moment) {
  if (moment.eventType === "goal") return "goal";
  if (["foul", "yellow_card", "red_card"].includes(moment.eventType)) return "whistle";
  if (["shot_on_target", "save", "tackle"].includes(moment.eventType)) return "impact";
  if (["skill", "dribble", "celebration"].includes(moment.eventType)) return "sparkle";
  if (["assist", "free_kick"].includes(moment.eventType)) return "whoosh";
  return "none";
}

function gradeForScene(moment) {
  if (moment.eventType === "goal") return "goal_gold";
  if (moment.isReplay || moment.storyPhase === "replay") return "replay_blue";
  return moment.storyPhase === "hook" ? "dramatic" : "clean";
}

function applyEditPlan(candidates, plan, targetDuration) {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const used = new Set();
  const planned = [...(Array.isArray(plan?.segments) ? plan.segments : [])]
    .sort((a, b) => Number(a.editOrder) - Number(b.editOrder));

  const edits = [];
  let outputDuration = 0;
  for (const directive of planned) {
    const candidate = byId.get(String(directive.candidateId));
    if (!candidate || used.has(candidate.id) || !framingEligible(candidate)) continue;

    let startTime = clamp(Number(directive.startTime), candidate.startTime, candidate.endTime - 1.2);
    let endTime = clamp(Number(directive.endTime), startTime + 1.2, candidate.endTime);
    if (!Number.isFinite(startTime)) startTime = candidate.startTime;
    if (!Number.isFinite(endTime)) endTime = candidate.endTime;
    const playbackRate = clamp(Number(directive.playbackRate || 1), 0.72, 1.18);
    endTime = Math.min(endTime, startTime + MAX_SCENE_SECONDS * playbackRate);
    let effectiveLength = (endTime - startTime) / playbackRate;
    const remaining = targetDuration - outputDuration;
    if (effectiveLength > remaining + 1) {
      if (remaining < 1.2) continue;
      endTime = Math.min(candidate.endTime, startTime + remaining * playbackRate);
      effectiveLength = (endTime - startTime) / playbackRate;
    }
    if (endTime - startTime < 1.2) continue;
    const transitionIn = ["cut", "crossfade", "crosszoom", "whip", "flash"].includes(directive.transitionIn) ? directive.transitionIn : "cut";
    const effect = ["none", "punch_zoom", "slow_motion", "speed_up", "replay_treatment"].includes(directive.effect) ? directive.effect : "none";
    edits.push({
      ...candidate,
      startTime,
      endTime,
      selectedForFinalVideo: true,
      editOrder: edits.length,
      role: String(directive.role || candidate.storyPhase || "evidence"),
      beatId: String(directive.beatId || "") || undefined,
      transitionIn,
      transitionDuration: clamp(Number(directive.transitionDuration || 0.04), 0.04, 0.36),
      effect,
      playbackRate,
      playerHighlight: Boolean(directive.playerHighlight) && candidate.mainPlayerVisible && (candidate.ballVisible || playerOnlyAllowed(candidate)),
      commentary: String(directive.commentary || "").slice(0, 360) || undefined,
      analysisPurpose: String(directive.analysisPurpose || candidate.analysisPurpose || "").slice(0, 220) || undefined,
      onScreenText: cleanOverlayText(directive.onScreenText || candidate.onScreenText || eventHeadline(candidate), 4),
      eventCallout: normalizeChoice(directive.eventCallout, ["none", "amazing", "goal", "shot", "save", "foul", "card", "close", "pass", "celebration"], "none"),
      colorGrade: normalizeChoice(directive.colorGrade, ["clean", "dramatic", "goal_gold", "replay_blue"], gradeForScene(candidate)),
      soundEffect: normalizeChoice(directive.soundEffect, ["none", "whoosh", "impact", "goal", "whistle", "sparkle"], "none"),
    });
    used.add(candidate.id);
    outputDuration += effectiveLength;
    if (outputDuration >= targetDuration - 0.5) break;
  }
  if (edits.length === 0) throw new Error("The edit plan did not contain any usable football segments from one coherent story.");
  const selectedById = new Map(edits.map((edit) => [edit.id, edit]));
  return candidates.map((candidate) => selectedById.get(candidate.id) || { ...candidate, selectedForFinalVideo: false });
}

function restoreOriginalPlannedScenes(moments, contentBeats) {
  const replacements = new Map(
    moments
      .filter((moment) => moment.selectedForFinalVideo && moment.replacesMomentId)
      .map((moment) => [moment.replacesMomentId, moment]),
  );
  let restored = moments.map((moment) => {
    const replacement = replacements.get(moment.id);
    if (replacement) return {
      ...moment,
      selectedForFinalVideo: true,
      editOrder: replacement.editOrder,
      beatId: replacement.beatId,
      role: replacement.role,
      commentary: replacement.commentary,
      analysisPurpose: replacement.analysisPurpose,
      onScreenText: replacement.onScreenText,
    };
    if (moment.selectedForFinalVideo && moment.replacesMomentId) {
      return { ...moment, selectedForFinalVideo: false, commentary: undefined };
    }
    return moment;
  });
  for (const beat of Array.isArray(contentBeats) ? contentBeats : []) {
    const expected = normalizeBeatText(beat.narration);
    const represented = restored.some((moment) => moment.selectedForFinalVideo
      && (String(moment.beatId || "") === String(beat.beatId) || normalizeBeatText(moment.commentary) === expected));
    if (represented) continue;
    const candidate = restored
      .filter((moment) => !moment.selectedForFinalVideo && normalizeBeatText(moment.commentary) === expected)
      .sort((a, b) => Number(Boolean(a.replacesMomentId)) - Number(Boolean(b.replacesMomentId))
        || Number(b.importanceScore || 0) - Number(a.importanceScore || 0))[0];
    if (!candidate) continue;
    restored = restored.map((moment) => moment.id === candidate.id ? {
      ...moment,
      selectedForFinalVideo: true,
      beatId: beat.beatId,
      role: beat.role,
      commentary: beat.narration,
      onScreenText: moment.onScreenText || beat.captionText,
    } : moment);
  }
  return restored;
}
function restoreContentBeatOrder(moments, contentBeats) {
  const beats = Array.isArray(contentBeats) ? contentBeats : [];
  if (beats.length === 0) return moments;
  const beatIndexById = new Map(beats.map((beat, index) => [String(beat.beatId), index]));
  const beatIndexByNarration = new Map(beats.map((beat, index) => [normalizeBeatText(beat.narration), index]));
  const usedPrimaryBeats = new Set();
  const ordered = moments
    .filter((moment) => moment.selectedForFinalVideo)
    .sort((a, b) => Number(a.editOrder) - Number(b.editOrder))
    .map((moment, originalIndex) => {
      const narrationIndex = beatIndexByNarration.get(normalizeBeatText(moment.commentary));
      const declaredIndex = beatIndexById.get(String(moment.beatId || ""));
      const beatIndex = Number.isInteger(narrationIndex) ? narrationIndex : declaredIndex;
      const primary = Number.isInteger(beatIndex) && !usedPrimaryBeats.has(beatIndex)
        && (Boolean(moment.commentary) || Number.isInteger(narrationIndex));
      if (primary) {
        usedPrimaryBeats.add(beatIndex);
        const beat = beats[beatIndex];
        return {
          ...moment,
          beatId: beat.beatId,
          role: beat.role,
          commentary: beat.narration,
          onScreenText: moment.onScreenText || beat.captionText,
          contentSort: beatIndex * 10,
        };
      }
      const finalBeatIndex = Math.max(1, beats.length - 1);
      const supportAnchor = Number.isInteger(beatIndex)
        ? beatIndex >= finalBeatIndex ? beatIndex * 10 - 1 : beatIndex * 10 + 1
        : finalBeatIndex * 10 - 1;
      return {
        ...moment,
        commentary: undefined,
        contentSort: supportAnchor + originalIndex / 1000,
      };
    })
    .sort((a, b) => a.contentSort - b.contentSort)
    .map((moment, index) => {
      const restored = { ...moment, editOrder: index };
      delete restored.contentSort;
      return restored;
    });
  const selectedById = new Map(ordered.map((moment) => [moment.id, moment]));
  return moments.map((moment) => selectedById.get(moment.id) || { ...moment, selectedForFinalVideo: false });
}

function normalizeBeatText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function buildTrackingPool(moments, backupLimit = 14) {
  const planned = moments.filter((moment) => moment.selectedForFinalVideo);
  const plannedIds = new Set(planned.map((moment) => moment.id));
  const candidates = moments
    .filter((moment) => !plannedIds.has(moment.id) && moment.keepDecision !== "reject" && moment.confidence >= 0.4 && framingEligible(moment));
  const backups = rankSemanticBackups(planned, candidates)
    .slice(0, backupLimit)
    .map((item) => item.moment);
  const trackedIds = new Set([...plannedIds, ...backups.map((moment) => moment.id)]);
  return moments.map((moment) => ({ ...moment, selectedForFinalVideo: trackedIds.has(moment.id) }));
}

function repairPlanWithTrackedBackups(plannedMoments, assessedMoments, tracking, targetDuration, intensity) {
  const approvedById = new Map(assessedMoments.filter((moment) => moment.selectedForFinalVideo).map((moment) => [moment.id, moment]));
  const rejectedPlanned = plannedMoments
    .filter((moment) => moment.selectedForFinalVideo && !approvedById.has(moment.id))
    .sort((a, b) => Number(a.editOrder) - Number(b.editOrder));
  const backups = plannedMoments
    .filter((moment) => !moment.selectedForFinalVideo && tracking?.moments?.[moment.id])
    .map((moment) => ({ moment, assessment: assessPlannedSceneTracking(moment, tracking.moments[moment.id]) }))
    .filter((item) => item.assessment.usable)
    .sort((a, b) => Number(b.moment.importanceScore || 0) - Number(a.moment.importanceScore || 0));
  const desired = [...approvedById.values()];
  const used = new Set(desired.map((moment) => moment.id));

  for (const rejected of rejectedPlanned) {
    const reusable = desired
      .filter((moment) => !moment.commentary && !moment.beatId)
      .map((moment) => ({ moment, semanticScore: semanticBackupScore(rejected, moment) }))
      .sort((a, b) => b.semanticScore - a.semanticScore)
      .find((item) => item.semanticScore >= 30);
    let next = reusable;
    if (reusable) desired.splice(desired.findIndex((moment) => moment.id === reusable.moment.id), 1);
    else next = backups
      .filter((item) => !used.has(item.moment.id))
      .map((item) => ({ ...item, semanticScore: semanticBackupScore(rejected, item.moment) }))
      .sort((a, b) => b.semanticScore - a.semanticScore
        || Number(b.moment.importanceScore || 0) - Number(a.moment.importanceScore || 0))
      .find((item) => item.semanticScore >= 30);
    if (!next) continue;
    used.add(next.moment.id);
    const backup = next.moment;
    const playbackRate = clamp(Number(rejected.playbackRate || 1), 0.72, 1.18);
    const desiredSourceLength = Math.min(MAX_SCENE_SECONDS * playbackRate, rejected.endTime - rejected.startTime);
    desired.push({
      ...backup,
      startTime: backup.startTime,
      endTime: Math.min(backup.endTime, backup.startTime + desiredSourceLength),
      selectedForFinalVideo: true,
      editOrder: rejected.editOrder,
      beatId: rejected.beatId,
      role: rejected.role,
      transitionIn: rejected.transitionIn,
      transitionDuration: rejected.transitionDuration,
      effect: deterministicEffect(backup, intensity),
      playbackRate,
      playerHighlight: backup.mainPlayerVisible && (backup.ballVisible || playerOnlyAllowed(backup)),
      commentary: rejected.commentary,
      analysisPurpose: rejected.analysisPurpose,
      onScreenText: rejected.onScreenText,
      eventCallout: calloutForEvent(backup),
      colorGrade: gradeForScene(backup),
      soundEffect: soundForEvent(backup),
      trackingDecision: "replacement_for_planned_scene",
      replacesMomentId: rejected.id,
    });
  }

  let supportOrder = Math.max(0, ...desired.map((moment) => Number(moment.editOrder || 0))) + 0.01;
  for (const next of backups) {
    if (selectedTimelineDuration(desired) >= targetDuration * 0.96) break;
    if (used.has(next.moment.id)) continue;
    used.add(next.moment.id);
    const backup = next.moment;
    const playbackRate = 1;
    const semanticAnchor = plannedMoments
      .filter((moment) => moment.selectedForFinalVideo && moment.beatId && moment.commentary && moment.role !== "conclusion")
      .map((moment) => ({ moment, score: semanticBackupScore(moment, backup) }))
      .sort((a, b) => b.score - a.score)[0]?.moment;
    desired.push({
      ...backup,
      startTime: backup.startTime,
      endTime: Math.min(backup.endTime, backup.startTime + MAX_SCENE_SECONDS),
      selectedForFinalVideo: true,
      editOrder: supportOrder,
      beatId: semanticAnchor?.beatId,
      replacesMomentId: undefined,
      role: "evidence",
      transitionIn: "cut",
      transitionDuration: 0.06,
      effect: deterministicEffect(backup, intensity),
      playbackRate,
      playerHighlight: backup.mainPlayerVisible && (backup.ballVisible || playerOnlyAllowed(backup)),
      commentary: "",
      analysisPurpose: "Additional tracked evidence supporting the approved content.",
      onScreenText: undefined,
      eventCallout: calloutForEvent(backup),
      colorGrade: gradeForScene(backup),
      soundEffect: soundForEvent(backup),
      trackingDecision: "tracked_support_scene",
    });
    supportOrder += 0.01;
  }

  const ordered = desired
    .sort((a, b) => Number(a.editOrder) - Number(b.editOrder))
    .map((moment, index) => ({ ...moment, editOrder: index }));
  const selectedById = new Map(ordered.map((moment) => [moment.id, moment]));
  return plannedMoments.map((moment) => selectedById.get(moment.id) || { ...moment, selectedForFinalVideo: false });
}

function applyTrackingQuality(moments, tracking) {
  const approved = new Map();
  for (const moment of moments.filter((item) => item.selectedForFinalVideo)) {
    const evidence = tracking?.moments?.[moment.id];
    const assessment = assessPlannedSceneTracking(moment, evidence);
    if (assessment.usable) approved.set(moment.id, { ...moment, trackingDecision: assessment.mode });
  }
  return moments.map((moment) => {
    if (!moment.selectedForFinalVideo) return { ...moment, selectedForFinalVideo: false, trackingDecision: "not_planned" };
    const planned = approved.get(moment.id);
    if (!planned) return { ...moment, selectedForFinalVideo: false, trackingDecision: "rejected_after_plan" };
    return { ...planned, selectedForFinalVideo: true };
  });
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

async function trackFootball(sourcePath, moments, media, id) {
  for (const [label, path] of [["Python tracking runtime", trackingPythonPath], ["football tracking script", trackingScriptPath], ["YOLO tracking model", trackingModelPath]]) {
    try { await stat(path); }
    catch { throw new Error(`${label} is missing at ${path}. Run npm run setup:tracking once, then retry.`); }
  }
  const selected = fitSelectedMoments(moments, Number.MAX_SAFE_INTEGER);
  if (selected.length === 0) throw new Error("No valid moments are available for player and ball tracking.");
  const directory = join(outputRoot, id, "tracking");
  await mkdir(directory, { recursive: true });
  const inputPath = join(directory, "moments.json");
  const outputPath = join(directory, "tracking.json");
  await writeFile(inputPath, JSON.stringify({
    moments: selected.map((moment) => ({
      id: moment.id,
      startTime: moment.startTime,
      endTime: moment.endTime,
      eventType: moment.eventType,
      focusX: clamp(moment.recommendedCrop?.[0]?.x ?? 0.5, 0, 1),
      storyPhase: moment.storyPhase,
      role: moment.role,
      isReplay: Boolean(moment.isReplay),
      playerHighlight: moment.playerHighlight !== false,
    })),
    media,
  }));
  try {
    await run(trackingPythonPath, [
      trackingScriptPath,
      "--source", sourcePath,
      "--moments", inputPath,
      "--output", outputPath,
      "--model", trackingModelPath,
      "--sample-fps", String(trackingSampleFps),
      "--image-size", String(trackingImageSize),
      "--confidence", String(trackingConfidence),
      "--output-width", String(outputWidth),
      "--output-height", String(outputHeight),
      "--window-height", String(outputHeight),
      "--window-top", "0",
      "--zoom", "1",
    ]);
  } catch (error) {
    throw new Error(`Local player/ball tracking failed: ${String(error?.message || error).slice(-1200)}`);
  }
  const tracking = JSON.parse(await readFile(outputPath, "utf8"));
  if (!tracking?.moments || !tracking?.summary || !tracking?.markerPaths) throw new Error("The local tracker returned incomplete keyframe data.");
  return tracking;
}

async function loadOrTrackFootball(sourcePath, moments, media, id) {
  const path = join(outputRoot, id, "tracking", "tracking.json");
  try {
    const tracking = JSON.parse(await readFile(path, "utf8"));
    const selected = fitSelectedMoments(moments, Number.MAX_SAFE_INTEGER);
    if (tracking.version === 10 && selected.every((moment) => tracking.moments?.[moment.id]?.keyframes?.length)) return tracking;
  } catch { /* Re-run tracking when cached data is missing or stale. */ }
  return trackFootball(sourcePath, moments, media, id);
}
async function makeSpeech(moments, id) {
  const provider = (process.env.TTS_PROVIDER || "").toLowerCase();
  if (provider !== "google_cloud") throw new Error("TTS_PROVIDER must be google_cloud. No TTS fallback was selected.");
  const narratable = moments
    .filter((moment) => moment.selectedForFinalVideo && moment.commentary)
    .sort((a, b) => Number(a.editOrder) - Number(b.editOrder));
  if (narratable.length === 0) return new Map();
  const speechDir = join(outputRoot, id, "speech");
  const manifestPath = join(speechDir, "beat-manifest.json");
  await mkdir(speechDir, { recursive: true });
  let previous = {};
  try { previous = JSON.parse(await readFile(manifestPath, "utf8")); } catch { /* Generate missing or stale beat files. */ }
  const files = new Map();
  const durations = new Map();
  const manifest = {};
  const voiceSignature = [process.env.TTS_MODEL, process.env.TTS_LANGUAGE, process.env.TTS_VOICE].join(":");
  for (const moment of narratable) {
    const key = String(moment.id);
    const narration = String(moment.commentary).trim();
    const filename = `${key.replace(/[^a-z0-9_-]/gi, "-")}.wav`;
    const output = join(speechDir, filename);
    let reusable = previous[key]?.narration === narration && previous[key]?.voiceSignature === voiceSignature;
    if (reusable) {
      try { reusable = (await stat(output)).size > 0; } catch { reusable = false; }
    }
    if (!reusable) await synthesizeGoogleCloudSpeech(narration, output);
    const duration = await probeAudioDuration(output);
    files.set(key, output);
    durations.set(key, duration);
    manifest[key] = { beatId: moment.beatId, narration, filename, duration, voiceSignature };
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  files.durations = durations;
  files.narrationScript = narratable.map((moment) => String(moment.commentary).trim()).join(" ");
  return files;
}
async function probeAudioDuration(path) {
  const raw = await run(ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path]);
  const duration = Number(raw.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Could not measure the generated narration duration.");
  return duration;
}

// Legacy renderer retained for saved pre-v2 jobs.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function renderVideo(sourcePath, outputPath, moments, settings, media, ttsFiles, overlayMasks, tracking) {
  const selected = fitSelectedMoments(moments, settings.targetDuration);
  if (selected.length === 0) throw new Error("No moments were selected for the final edit.");
  const captionFiles = settings.captions ? await makeCaptionFiles(selected, outputPath) : new Map();
  const args = ["-hide_banner", "-y", "-i", sourcePath];
  const ttsInputs = new Map();
  for (const moment of selected) {
    const speech = ttsFiles.get(moment.id);
    if (speech) { ttsInputs.set(moment.id, args.filter((item) => item === "-i").length); args.push("-i", speech); }
  }
  const highlightedIndexes = selected.flatMap((moment, index) => moment.playerHighlight === false ? [] : [index]);
  let markerInputIndex = null;
  if (settings.playerHighlight && tracking?.markerPath && highlightedIndexes.length) {
    markerInputIndex = args.filter((item) => item === "-i").length;
    args.push("-loop", "1", "-framerate", "30", "-i", tracking.markerPath);
  }
  const filters = [];
  if (markerInputIndex !== null) {
    const labels = highlightedIndexes.map((index) => `[ring${index}]`).join("");
    filters.push(highlightedIndexes.length === 1
      ? `[${markerInputIndex}:v]format=rgba${labels}`
      : `[${markerInputIndex}:v]format=rgba,split=${highlightedIndexes.length}${labels}`);
  }
  const useOriginalAudio = !settings.commentary && media.hasAudio && settings.originalAudio !== "muted";
  const gain = settings.originalAudio === "reduced" ? 0.28 : 1;
  const masks = settings.logoMasking ? sourceMaskFilters(overlayMasks, media) : [];
  const masking = masks.length ? `${masks.join(",")},` : "";
  const clipDurations = [];
  selected.forEach((moment, index) => {
    const sourceLength = Math.max(1.2, moment.endTime - moment.startTime);
    const playbackRate = clamp(Number(moment.playbackRate || 1), 0.72, 1.18);
    const outputLength = sourceLength / playbackRate;
    clipDurations.push(outputLength);
    const fallbackX = clamp(moment.recommendedCrop?.[0]?.x ?? 0.5, 0, 1);
    const keyframes = retimeKeyframes(tracking?.moments?.[moment.id]?.keyframes || [], playbackRate);
    const cameraX = keyframeExpression(keyframes, "cameraX", fallbackX);
    const cameraY = keyframeExpression(keyframes, "cameraY", 0.5);
    const crop = media.width / media.height >= 9 / 16
      ? `crop=ih*9/16:ih:x='max(0,min(iw-ow,iw*(${cameraX})-ow/2))':y=0`
      : `crop=iw:iw*16/9:x=0:y='max(0,min(ih-oh,ih*(${cameraY})-oh/2))'`;
    filters.push(`[0:v]trim=start=${moment.startTime.toFixed(3)}:duration=${sourceLength.toFixed(3)},setpts=PTS-STARTPTS,${masking}${crop},scale=${outputWidth}:${outputHeight}:flags=lanczos,setsar=1${visualEffectFilter(moment, settings.intensity)},setpts=PTS/${playbackRate.toFixed(5)},fps=30,settb=AVTB,format=yuv420p[clip${index}]`);
    let videoLabel = `clip${index}`;
    if (markerInputIndex !== null && highlightedIndexes.includes(index)) {
      const markerX = keyframeExpression(keyframes, "markerX", -256);
      const markerY = keyframeExpression(keyframes, "markerY", -256);
      const markerEnabled = visibilityExpression(keyframes);
      filters.push(`[${videoLabel}][ring${index}]overlay=x='${markerX}':y='${markerY}':enable='${markerEnabled}':eval=frame:eof_action=repeat:shortest=1[marked${index}]`);
      videoLabel = `marked${index}`;
    }
    const captionPath = captionFiles.get(moment.id);
    if (captionPath) {
      const captionFont = escapeFilterPath(resolveSetting(process.env.CAPTION_FONT_PATH || "C:/Windows/Fonts/arialbd.ttf"));
      filters.push(`[${videoLabel}]drawtext=fontfile='${captionFont}':textfile='${escapeFilterPath(captionPath)}':fontcolor=white:fontsize=48:line_spacing=12:box=1:boxcolor=black@0.62:boxborderw=22:x=(w-text_w)/2:y=h-text_h-180[v${index}]`);
    } else filters.push(`[${videoLabel}]null[v${index}]`);
    const speechIndex = ttsInputs.get(moment.id);
    if (speechIndex !== undefined) {
      filters.push(`[${speechIndex}:a]aresample=48000,apad,atrim=duration=${outputLength.toFixed(3)},volume=1,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[speech${index}]`);
      if (useOriginalAudio) {
        filters.push(`[0:a]atrim=start=${moment.startTime.toFixed(3)}:duration=${sourceLength.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,atempo=${playbackRate.toFixed(5)},volume=${gain.toFixed(2)},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[base${index}]`);
        filters.push(`[base${index}][speech${index}]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a${index}]`);
      } else filters.push(`[speech${index}]anull[a${index}]`);
    } else if (useOriginalAudio) {
      filters.push(`[0:a]atrim=start=${moment.startTime.toFixed(3)}:duration=${sourceLength.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,atempo=${playbackRate.toFixed(5)},volume=${gain.toFixed(2)},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${index}]`);
    } else filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${outputLength.toFixed(3)},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${index}]`);
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
  const filterScriptPath = join(dirname(outputPath), "filtergraph.txt");
  await writeFile(filterScriptPath, filters.join(";\n"));
  args.push("-/filter_complex", filterScriptPath, "-map", "[outv]", "-map", "[outa]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-b:a", "192k", "-movflags", "+faststart", outputPath);
  await run(ffmpegPath, args);

function retimeKeyframes(keyframes, playbackRate) {
  return keyframes.map((frame) => ({ ...frame, time: Number(frame.time) / playbackRate }));
}

function visualEffectFilter(moment, intensity) {
  if (intensity === "natural" && moment.effect !== "replay_treatment") return "";
  if (moment.effect === "punch_zoom") return ",scale=1166:2074:flags=lanczos,crop=1080:1920:x=(iw-ow)/2:y=(ih-oh)/2,eq=saturation=1.06:contrast=1.03";
  if (moment.effect === "replay_treatment") return ",eq=saturation=0.88:contrast=1.08:brightness=-0.01";
  if (moment.effect === "slow_motion") return ",eq=saturation=1.05:contrast=1.025,unsharp=5:5:0.35:5:5:0";
  if (moment.effect === "speed_up") return ",eq=saturation=1.08:contrast=1.04";
  return "";
}

function transitionFilter(moment, previousDuration, currentDuration) {
  const requested = clamp(Number(moment.transitionDuration || 0.04), 0.04, 0.45);
  const duration = Math.min(requested, previousDuration / 4, currentDuration / 4);
  const names = { cut: "fade", crossfade: "fade", crosszoom: "zoomin", whip: "smoothleft", flash: "fadefast" };
  return { name: names[moment.transitionIn] || "fade", duration: Math.max(0.04, duration) };
}
}
async function makeCaptionFiles(moments, outputPath) {
  const files = new Map();
  const captionDir = join(dirname(outputPath), "captions");
  await mkdir(captionDir, { recursive: true });
  for (const [index, moment] of moments.entries()) {
    if (!moment.commentary) continue;
    const path = join(captionDir, `${index}.txt`);
    await writeFile(path, wrapCaption(moment.commentary));
    files.set(moment.id, path);
  }
  return files;
}

function wrapCaption(value, width = 36) {
  const words = String(value).replace(/[\r\n]+/g, " ").split(/\s+/).filter(Boolean);
  const lines = []; let current = "";
  for (const word of words) {
    if (current && `${current} ${word}`.length > width) { lines.push(current); current = word; }
    else current = current ? `${current} ${word}` : word;
  }
  if (current) lines.push(current);
  return lines.slice(0, 4).join("\n");
}

function escapeFilterPath(path) { return path.replaceAll("\\", "/").replace(":", "\\:").replaceAll("'", "\\'"); }

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
  let tolerance = field.startsWith("camera") ? 0.004 : 7;
  values = simplifySeries(values, tolerance);
  while (values.length > 40) {
    tolerance *= 1.5;
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

function visibilityExpression(keyframes) {
  const values = keyframes
    .map((frame) => ({ time: Number(frame.time), visible: Number(frame.markerVisible) >= 0.5 }))
    .filter((frame) => Number.isFinite(frame.time))
    .sort((a, b) => a.time - b.time);
  const intervals = [];
  let start = null;
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index];
    if (current.visible && start === null) start = current.time;
    const nextVisible = values[index + 1]?.visible ?? false;
    if (start !== null && (!current.visible || !nextVisible)) {
      const end = current.visible ? (values[index + 1]?.time ?? current.time + 0.25) : current.time;
      if (end > start) intervals.push([start, end]);
      start = null;
    }
  }
  if (intervals.length === 0) return "0";
  return intervals.map(([from, to]) => `between(t,${from.toFixed(3)},${to.toFixed(3)})`).join("+");
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
    if (error > maximumError) { maximumError = error; splitIndex = index; }
  }
  if (maximumError <= tolerance || splitIndex < 1) return [first, last];
  return [
    ...simplifySeries(values.slice(0, splitIndex + 1), tolerance).slice(0, -1),
    ...simplifySeries(values.slice(splitIndex), tolerance),
  ];
}
async function validateRenderedVideo(outputPath, settings) {
  const media = await probe(outputPath);
  if (media.width !== outputWidth || media.height !== outputHeight) {
    throw new Error(`Rendered video is ${media.width}x${media.height}; expected full-screen ${outputWidth}x${outputHeight}.`);
  }
  if (!media.hasAudio) throw new Error("Rendered video is missing its narration/silence audio track.");
  if (media.duration < 1) throw new Error("Rendered video duration is invalid.");
  return {
    passed: true,
    media,
    targetDuration: settings.targetDuration,
    durationDelta: Number((media.duration - settings.targetDuration).toFixed(3)),
    originalAudioMutedDuringNarration: Boolean(settings.commentary),
  };
}

async function reviewRenderedVideoWithGemini(outputPath, media, id, settings) {
  const model = process.env.GEMINI_MODEL;
  const ai = new GoogleGenAI({ vertexai: true, apiKey: process.env.GEMINI_API_KEY });
  const proxyPath = join(outputRoot, id, "quality-review.mp4");
  const videoKbps = Math.round(clamp(13 * 1024 * 1024 * 8 / Math.max(1, media.duration) / 1000 - 32, 180, 700));
  const args = ["-hide_banner", "-y", "-i", outputPath, "-vf", "fps=2,scale=-2:360", "-c:v", "libx264", "-preset", "veryfast", "-b:v", `${videoKbps}k`, "-maxrate", `${videoKbps}k`, "-bufsize", `${videoKbps * 2}k`, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "24k", "-ac", "1", "-ar", "16000", "-movflags", "+faststart", proxyPath];
  await run(ffmpegPath, args);
  const proxy = await readFile(proxyPath);
  const prompt = [
    "Act as a strict football-analysis Shorts quality controller. Watch the complete rendered video from beginning to end before scoring it.",
    "Return JSON only with approved boolean, score 0-100, issues array, storyCoherence 0-100, voiceStyle 0-100, fullBleed 0-100, ballTracking 0-100, playerHighlight 0-100, framing 0-100, pacing 0-100, transitions 0-100, captions 0-100, watermarkMasking 0-100, and audio 0-100.",
    "Reject the edit if it becomes a compilation of unrelated highlights instead of answering one football question with setup, visible evidence, cause, decisive action, proof, consequence, and optional emotional payoff.",
    "Every gameplay scene must fill the 1080x1920 canvas edge-to-edge without black bars, blurred panels, or a small horizontal inset. The football and involved player must remain visible together. Player-only framing is allowed only for a brief reaction or celebration.",
    "Reject any opening freeze or moving highlight that marks a player while the football is absent. Replays may use a moving ball ring or player marker when they clarify evidence.",
    "Scenes must last 1.2 to 5 seconds. Prefer hard cuts and use slow motion, freezes, zooms, transitions, color changes, emojis, callouts, and sound accents only when they explain a visible point.",
    "The base color grade must stay consistent and natural. Replay or decisive-proof treatment may differ, but random alternating color grades are a defect.",
    "Captions must animate in readable 2-to-4-word groups, remain inside mobile safe areas, avoid large opaque boxes, and follow the spoken analysis.",
    "When narration is requested, require one continuous natural adult male football-analyst performance. Reject fragmented per-scene delivery, robotic play-by-play, generic hype, narration that merely states what is visible, or original broadcast speech competing with the analyst.",
    "Narration requested: " + settings.commentary + ". Player highlighting requested: " + settings.playerHighlight + ". Logo masking requested: " + settings.logoMasking + ".",
    "Do not invent problems that cannot be observed. Approve only at score 80 or higher with no severe story, full-screen framing, missing-action, narration, or caption issue.",
  ].join(" ");
  const response = await ai.models.generateContent({
    model,
    contents: [{ inlineData: { data: proxy.toString("base64"), mimeType: "video/mp4" } }, { text: prompt }],
    config: { responseMimeType: "application/json", temperature: 0.05 },
  });
  const parsed = JSON.parse(response.text || "{}");
  const issues = Array.isArray(parsed.issues) ? parsed.issues.map((issue) => String(issue).slice(0, 240)).slice(0, 8) : [];
  const score = scoreField(parsed.score, 0);
  return {
    approved: Boolean(parsed.approved) && score >= 80,
    score,
    issues,
    storyCoherence: scoreField(parsed.storyCoherence, 0),
    voiceStyle: scoreField(parsed.voiceStyle, 0),
    fullBleed: scoreField(parsed.fullBleed, 0),
    ballTracking: scoreField(parsed.ballTracking, 0),
    playerHighlight: scoreField(parsed.playerHighlight, 0),
    framing: scoreField(parsed.framing, 0),
    pacing: scoreField(parsed.pacing, 0),
    transitions: scoreField(parsed.transitions, 0),
    captions: scoreField(parsed.captions, 0),
    watermarkMasking: scoreField(parsed.watermarkMasking, 0),
    audio: scoreField(parsed.audio, 0),
  };
}

async function probe(sourcePath) {
  const output = await run(ffprobePath, ["-v", "error", "-show_entries", "format=duration:stream=index,codec_type,width,height", "-of", "json", sourcePath]);
  const value = JSON.parse(output);
  const video = value.streams?.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("No video stream was found in the uploaded file.");
  const duration = Number(value.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Could not read the video duration.");
  return { duration, width: Number(video.width), height: Number(video.height), hasAudio: value.streams.some((stream) => stream.codec_type === "audio"), mimeType: mimeFor(sourcePath) };
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, windowsHide: true, shell: false });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 12000) stderr = stderr.slice(-12000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(`${basename(command)} exited with code ${code}: ${stderr.slice(-2000)}`)));
  });
}

async function receiveFile(request, path) {
  let bytes = 0;
  const stream = createWriteStream(path, { flags: "wx" });
  await new Promise((resolvePromise, reject) => {
    request.on("data", (chunk) => { bytes += chunk.length; if (bytes > maxUploadBytes) request.destroy(new Error("Video exceeds the 2 GB local limit.")); });
    request.on("error", reject); stream.on("error", reject); stream.on("finish", resolvePromise); request.pipe(stream);
  });
  if (bytes === 0) throw new Error("The uploaded video was empty.");
}

async function getJob(response, id) {
  try { return json(response, 200, publicJob(await readJob(id))); }
  catch { return json(response, 404, { error: "Job not found" }); }
}

async function streamOutput(request, response, id) {
  const path = join(outputRoot, id, "final.mp4");
  try {
    const info = await stat(path);
    const { createReadStream } = await import("node:fs");
    const range = String(request.headers.range || "").match(/^bytes=(\d*)-(\d*)$/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= info.size) {
        response.writeHead(416, { "Content-Range": `bytes */${info.size}` }); return response.end();
      }
      response.writeHead(206, { "Content-Type": "video/mp4", "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${info.size}`, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
      return createReadStream(path, { start, end }).pipe(response);
    }
    response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": info.size, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
    return createReadStream(path).pipe(response);
  } catch { return json(response, 404, { error: "Output not found" }); }
}

async function updateJob(job, stage, progress, extra = {}) {
  const next = { ...job, ...extra, stage, progress, updatedAt: new Date().toISOString() };
  await saveJob(next); return next;
}
async function saveJob(job) { const path = join(jobRoot, `${job.id}.json`); const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(job, null, 2)); await rename(temp, path); }
async function readJob(id) { return JSON.parse(await readFile(join(jobRoot, `${id}.json`), "utf8")); }
function publicJob(job) {
  const safe = { ...job };
  delete safe.sourceKey; delete safe.outputKey;
  return safe;
}

function parseSettings(header) {
  const defaults = { targetDuration: 60, aspectRatio: "9:16", commentary: true, playerHighlight: true, captions: true, logoMasking: true, originalAudio: "muted", intensity: "dynamic" };
  if (!header) return defaults;
  try { return { ...defaults, ...JSON.parse(Buffer.from(header, "base64url").toString("utf8")) }; }
  catch { throw new Error("Invalid edit settings."); }
}
function safeFileName(name) { return basename(name).replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180) || "source.mp4"; }
function resolveSetting(value) { return isAbsolute(value) ? value : resolve(projectRoot, value); }
function resolveExecutable(value) { return /[\\/]/.test(value) ? resolveSetting(value) : value; }
function mimeFor(path) { return extname(path).toLowerCase() === ".mov" ? "video/quicktime" : extname(path).toLowerCase() === ".webm" ? "video/webm" : "video/mp4"; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)); }
function setCors(request, response) { const origin = String(request.headers.origin || ""); if (allowedOrigins.has(origin)) response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Access-Control-Allow-Headers", "content-type,x-file-name,x-edit-settings"); response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS"); }
function json(response, status, value) { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); }
function send(response, status) { response.writeHead(status); response.end(); }
async function inspectTools() {
  const [ffmpeg, ffprobe, trackingPython, trackingModel] = await Promise.all([
    run(ffmpegPath, ["-version"]).then(() => true).catch(() => false),
    run(ffprobePath, ["-version"]).then(() => true).catch(() => false),
    stat(trackingPythonPath).then(() => true).catch(() => false),
    stat(trackingModelPath).then(() => true).catch(() => false),
  ]);
  return { ffmpeg, ffprobe, trackingPython, trackingModel, ffmpegPath, ffprobePath };
}
async function loadDotEnv(path) { try { const text = await readFile(path, "utf8"); for (const line of text.split(/\r?\n/)) { const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!match || process.env[match[1]] !== undefined) continue; process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2"); } } catch { /* The local .env file is optional. */ } }
