import http from "node:http";
import { localStudioOrigins, localStudioReturnOrigin } from './local-studio-origin.mjs';
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { quotaRetryDelay, retryAfterMilliseconds, serviceRetryDelay, restoredGeminiRetryDelay, geminiServiceFailure, geminiRetryDeadline, geminiVideoDeadline, withGeminiDeadline } from "./gemini-request-scheduler.mjs";
import {geminiLimitEvidence,geminiLimitMessage,geminiResourceExhausted} from './gemini-limit-evidence.mjs';
import {createGeminiModelGate} from './gemini-model-gate.mjs';
import {geminiFailoverModels,chooseGeminiFailoverModel,geminiFailoverCooldown,recordGeminiGeneration,geminiResponseProvenance,mergeGeminiModelCooldowns} from './gemini-model-failover.mjs';
import {geminiGenerationConfig} from './gemini-generation-config.mjs';
import { geminiTrafficPolicy, geminiTrafficResult } from "./gemini-traffic-policy.mjs";
import { footballVideoPart, NARRATION_VIDEO_PROFILE } from "./gemini-media-policy.mjs";
import { compactNarrationEvidence } from './narration-request-policy.mjs';
import { renderedNarrationManifest, narrationSlotBudgets, recordTimedNarration, normalizeRecapResultEnding } from './completed-video-narration.mjs';
import { captionAss, narrationSubtitleCues } from './short-form-policy.mjs';
import { migrateRetiringGeminiModels } from './gemini-model-lifecycle.mjs';
import { installGeminiTransport } from "./gemini-http-transport.mjs";
import { GOAL_OUTCOME_VERSION, OUTCOME_OBSERVATION_PROMPT_VERSION, SOURCE_OUTCOME_OBSERVATION_VERSION, outcomeScoreConflict, outcomeEvidenceConflict, outcomeObservationSchema, reusableSourceOutcome, sameIncidentOutcomeWindows, outcomeConflictSampleTimes, singleActionObservationContract, reusableCompletedOutcome, reusableDenseGoalOutcome, sameIncidentDecisionWindows, goalOutcomeDetail, goalOutcomeDetailIndexes, invalidateOlderGoalOutcomes, needsGoalOutcomeObservation } from "./goal-outcome-detail.mjs";
import {hasInitialSceneEvidence} from './scene-selection-evidence.mjs';
import {INITIAL_SECTION_VERSION,INITIAL_SECTION_SCHEMA,initialObservationProblems,initialScoringObservations,initialScoringCoverage,observeInitialSections,selectInitialActionViews} from './initial-section-analysis.mjs';
import {parseSourceShotCheckpoint,sourceShotCheckpointMatches} from './shot-checkpoint.mjs';
import { geminiOutputTruncated, geminiJsonRetryConfig,geminiInvalidRequestDetails,parseGeminiJson } from "./gemini-json-policy.mjs";
import { synthesizeGoogleCloudSpeech } from "./google-cloud-tts.mjs";
import { normalizeFinishedAudio, outputDimensions, renderVideoV2 } from "./render-video-v2.mjs";
import { filterGraphFileArgs } from "./ffmpeg-compat.mjs";
import { boundedFfmpegArgs } from "./ffmpeg-thread-budget.mjs";
import { createJobQueue } from "./job-queue.mjs";
import {geminiWorkloadModel,initialDiscoveryFps,restoreInitialSectionResponse,needsBroadExtraDiscovery,unifiedDiscoverySummary,UNIFIED_DISCOVERY_VERSION} from './gemini-workload-policy.mjs';
import { assertSourceDuration } from './source-duration-policy.mjs';
import { processingInterruption, createRecoveryScheduler } from './processing-recovery.mjs';
import { createSerializedJsonStore } from "./serialized-json-store.mjs";
import { createYouTubePublisher } from "./youtube-publisher.mjs";
import { mapWithConcurrency, createStreamingWorkQueue } from "./bounded-concurrency.mjs";
import { downgradeToSafeStatic, recoverSafeStaticCandidates, safeStaticFallbackEligible, usesSafeStaticPresentation } from "./delivery-policy.mjs";
import { restoreContentBeatOrder } from "./pipeline-state.mjs";
import { downloadAuthorizedYouTubeSource, normalizeAuthorizedYouTubeUrl } from "./source-import.mjs";
import { incidentCoverage, assertIncidentCoverage } from "./incident-coverage.mjs";
import { isDecisionScene, normalizeDecisionOnlyScene, repairDecisionFraming } from "./decision-framing.mjs";
import { trackSceneWithGemini, assessGeminiFraming, reviewedFramingEvent, reviewedFramingNarration, reviewedLeadInScene, FramingVerificationError } from "./gemini-framing.mjs";
import { keyframeProvider, hybridDetectorScene, providerEvidenceMatches, HYBRID_TRACKING_VERSION } from "./hybrid-tracking-policy.mjs";
import { reviewHybridCrop, reviewedHybridPhaseBrief, hybridEvidenceWindowMatches } from "./hybrid-framing.mjs";
import { fastTrackingPolicy } from './fast-tracking-policy.mjs';
import { createWorkflowPerformance } from './workflow-performance.mjs';
import {ACTION_GUIDANCE_VERSION,actionGuidanceKey,matchingActionGuidance,actionGuidanceRequest,observeValidatedActionGuidance,applySavedActionGuidance,actionGuideObservationKey,matchingActionGuideObservation,sharedActionGuideObservation} from './action-guidance.mjs';
import {sourceActionGuideWindow,selectGuidedSourceAction} from './source-action-selection.mjs';
import {BLOCKED_SELECTION_VERSION,SOURCE_RESELECTION_FPS,blockedSelectionScenes,blockedSelectionWindow,blockedSelectionRequest,applyBlockedSelection,mergeBlockedSelections} from './blocked-source-selection.mjs';
import {framingVideoClockFilter} from './gemini-video-framing.mjs';
import {outcomeNarrationProblems} from './narration-outcome-policy.mjs';
import { lockedNarrationContract, lockedNarrationResponseSchema, projectLockedNarration } from './locked-narration.mjs';
import { fixedSceneQueue, assertFixedSceneQueue, LIVE_FIRST_SELECTION_POLICY } from './fixed-scene-queue.mjs';
import {prepareSplitSceneAssets,splitSceneInput,sceneWithLocalClock,savePortraitSceneAsset} from './split-scene-assets.mjs';
import {buildWorkflowProgress,workflowPhase} from './workflow-progress.mjs';
import { splitNarrationForTts } from './tts-policy.mjs';
import { sourceContentFingerprint } from "./source-content-fingerprint.mjs";
import { observeSourceScore } from "./observe-source-score.mjs";
import { scoreAnchorForScene, bindSourceScoreCandidates, contradictsStableLiveScore, stableLiveScoreContext, sourceScoreCoverage } from "./source-score-ledger.mjs";
import { SCORE_ACTION_SCHEMA, validScoreActionDraft, scoreActionObservationProfile, scoreActionSearchWindows, hasCompleteLiveScoreCandidate } from "./score-action-schema.mjs";
import { CLEAR_ANGLE_WORKFLOW_VERSION, selectClearIncidentAngles, trimCompleteCameraView, sourceScoreShotProposals } from "./clear-incident-angle.mjs";
import { RECAP_ACTION_INVENTORY_VERSION, RECAP_EXTRA_SCHEMA, validRecapExtraDraft, normalizeRecapExtraDraft, recapExtraDraftProblems, recapExtraPrompt, selectRecapExtraActions } from "./recap-action-inventory.mjs";
import {step1DiscoveryPlan,unobservedSourceShotWindows,selectSectionSceneIds,sectionSelectionSummary} from './step1-discovery-plan.mjs';
import { alignActionToShot, linkImmediateGoalReplays, trimToVerifiedActionOrigin } from "./action-boundaries.mjs";
import { SEMANTIC_VERIFICATION_VERSION, stableSignature, semanticSignature, needsSemanticReview, mergeSemanticReview, incidentManifest, evidenceReport, parseTrackingProgress, matchingTrackingEvidence, summarizeTracking } from "./pipeline-state.mjs";
import { sourceCompletionDetailTimes, conflictingSourceActionWindowIds, applyReviewedSourceActionWindow, correctSemanticReelClock, invalidSemanticTimingIds, semanticReviewSchema, missingSemanticReviewIds, mergeMissingSemanticReview, semanticClipManifest, semanticReviewInputArgs, semanticReviewLabel, semanticReviewBatches, semanticReviewWindow, syntheticReactionMismatch, unsupportedNormalPlay, reconcileVerifiedGoalDecisions } from "./semantic-observation-policy.mjs";
import { COMPLETE_RECAP_MINIMUM_SECONDS, COMPLETE_RECAP_MAXIMUM_SECONDS, completeRecapDurationBounds, automaticDurationSettings, naturalStoryCapacity, uniqueEvidenceCandidates } from "./automatic-duration.mjs";
import { obviousIdentityProblems, shortReactionCandidates, unverifiedNamedEntities } from "./short-form-policy.mjs";
import { buildViralReelPlan, isViralReel, viralReelDurationBounds } from "./viral-reel-policy.mjs";
import { analysisProxyWindows, buildBroadcastShotInventory, inventoryForExcerpt, passageFitsShotSequence } from "./passage-inventory.mjs";
import { durationOnlyRecovery, durationRecoveryWindowLimit, boundedRecoveryWindows, coverageCandidateState, coverageRecoveryWindows, isDurationRecoveryAction, scenesNeedingCoverageRecovery, goalRecoveryWindow, goalCountRecoveryWindows, GOAL_RECOVERY_LOOKBACK_SECONDS } from "./coverage-recovery.mjs";
import { filterUnprovedRecoveryGoals, goalTotalFromFilename, liveGoalStoryCount, verifiedPrimaryReplayGoal, sourceGoalCountCoverage } from "./goal-count-evidence.mjs";
import { normalizeEditorialScore } from "./score-normalization.mjs";
import { holdAndPanCamera, isActionHandoffCut } from "./hold-pan-camera.mjs";
import { buildVisualReviewManifest } from "./visual-review-manifest.mjs";
import { assessNativeFrameAction, canRenderLockedNativeAction, canUseNativeSemanticFallback, recoverNativeFullFrameIncidents } from "./native-frame-action.mjs";
import {
  MIN_SCENE_SECONDS,
  MAX_SCENE_SECONDS,
  COMPLETE_ACTION_SECONDS,
  COMPLETE_HIGHLIGHT_MAX_PLAYBACK_RATE,
  completeActionPlaybackRate,
  analysisFirstIncidentOrder,
  assessPlannedSceneTracking,
  assignContentBeatsToMoments,
  playerOnlyEvidenceAllowed,
  buildContentWritingPrompt,
  buildContinuousNarration,
  buildEvidenceAlignmentPrompt,
  contentPlanProblems,
  narrationWordBudget,
  recapTimelineProblems,
  contentEvidenceBindingProblems,
  editableEvidenceDuration,
  expandVerifiedTimeline,
  fitContentPlanToEvidenceSlots,
  fitSegmentPlaybackToDuration,
  highlightSequenceProblems,
  highlightStoryDeficiencies,
  chooseTrackedIncidentAngles,
  incidentViewQualityScore,
  limitIncidentActionViews,
  normalizeContentPlan,
  plannedSegmentDuration,
  rankSemanticBackups,
  renderableEvidenceCapacity,
  selectDirectorCandidates,
  semanticBackupScore,
} from "./editorial-policy.mjs";
import {
  analyzeVideoIntelligenceFile,
  compactVideoIntelligenceEvidence,
  enrichMomentsWithVideoIntelligence,
  videoIntelligenceEnabled,
} from "./google-video-intelligence.mjs";
import {
  extractGroundingSources,
  bindVerifiedIdentitiesToIncidents,
  discoverVerifiedResearchSources,
  verifyClaimedResearchSources,
  identityBindingProblems,
  matchResearchPrompt,
  normalizeMatchContext,
  scoreClaimIsVerified,
  verifiedIdentityNames,
} from "./match-research.mjs";
import {
  FOOTBALL_EDITOR_SKILL_VERSION,
  footballAlignmentContract,
  footballObservationContract,
  footballQualityContract,
  expandMomentToReviewedAction,
  normalizeReviewedTrackingBrief,
  normalizeTrackingBrief,
} from "./football-editor-skill.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
await loadDotEnv(join(projectRoot, ".env"));
for (const change of migrateRetiringGeminiModels()) {
  console.info(`Gemini lifecycle migration: ${change.key} ${change.before} -> ${change.after}`);
}
installGeminiTransport();

const port = Number(process.env.LOCAL_PROCESSOR_PORT || 8787);
const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, "");
const dataRoot = resolveSetting(process.env.LOCAL_DATA_DIR || "./local-data");
const uploadRoot = join(dataRoot, "uploads");
const outputRoot = join(dataRoot, "outputs");
const jobRoot = join(dataRoot, "jobs");
const ffmpegPath = resolveExecutable(process.env.FFMPEG_PATH || "ffmpeg");
const ffprobePath = resolveExecutable(process.env.FFPROBE_PATH || "ffprobe");
const trackingPythonPath = resolveExecutable(process.env.TRACKING_PYTHON || "./.venv-tracking/Scripts/python.exe");
// CALF is a useful offline anchor generator on a CUDA host, but its CPU pass
// can take longer than the entire requested edit. Gemini still audits every
// PySceneDetect shot, so keep CALF as an explicit quality/recall option rather
// than a default latency tax on local CPU installations.
const soccerNetEnabled = String(process.env.SOCCERNET_CALF_ENABLED || "false").toLowerCase() === "true";
const soccerNetPythonPath = resolveExecutable(process.env.SOCCERNET_CALF_PYTHON || "./.venv-soccernet/Scripts/python.exe");
const soccerNetScriptPath = resolveSetting(process.env.SOCCERNET_CALF_SCRIPT || "./local-processor/soccernet-calf.py");
const soccerNetRepoPath = resolveSetting(process.env.SOCCERNET_CALF_REPO || "./tools/external/soccernet-sn-spotting");
const soccerNetModelPath = join(soccerNetRepoPath, "Benchmarks", "CALF", "models", "CALF_benchmark", "model.pth.tar");
const trackingScriptPath = resolveSetting(process.env.TRACKING_SCRIPT || "./local-processor/track-football-v2.py");
// Preserve the deployed provider until the isolated hybrid regression passes.
// Legacy hybrid shares role weights. Fast hybrid uses a dedicated ball model.
const activeKeyframeProvider = keyframeProvider(process.env.KEYFRAME_PROVIDER || "gemini");
const hybridKeyframing = activeKeyframeProvider === "hybrid";
const fastTracking = fastTrackingPolicy();
const hybridModelPath = resolveSetting(process.env.HYBRID_TRACKING_MODEL || "./tools/tracking/football-role-detector.pt");
const trackingModelPath = hybridKeyframing ? hybridModelPath : resolveSetting(process.env.TRACKING_MODEL || "./tools/tracking/yolo11n.pt");
const trackingBallModelPath = hybridKeyframing
  ? (fastTracking.enabled ? resolveSetting(fastTracking.ballModel) : hybridModelPath)
  : resolveSetting(process.env.TRACKING_BALL_MODEL || "./tools/tracking/yolo-football-ball-detection.pt");
const trackingSampleFps = clamp(Number(process.env.TRACKING_SAMPLE_FPS || 10), 1, 15);
const trackingCoarseSampleFps = clamp(Number(process.env.TRACKING_COARSE_SAMPLE_FPS || 5), 1, trackingSampleFps);
const trackingDevice = String(process.env.TRACKING_DEVICE || "auto").trim() || "auto";
const trackingImageSize = Math.round(clamp(Number(process.env.TRACKING_IMAGE_SIZE || 960), 320, 1280));
const trackingBallImageSize = Math.round(clamp(Number(process.env.TRACKING_BALL_IMAGE_SIZE || 1280), 640, 1600));
const trackingConfidence = clamp(Number(process.env.TRACKING_CONFIDENCE || 0.08), 0.01, 0.8);
const trackingBallConfidence = clamp(Number(process.env.TRACKING_BALL_CONFIDENCE || 0.03), 0.01, 0.5);
const trackingSceneConcurrency = Math.round(clamp(Number(process.env.TRACKING_SCENE_CONCURRENCY || 2), 1, 4));
// Native 16:9 edits do not move a portrait crop, so they only need enough
// samples to validate the action and place optional overlays. Running the
// portrait 15 fps / 1600 px pass here was the largest avoidable CPU cost.
const nativeTrackingSampleFps = Math.round(clamp(Number(process.env.NATIVE_TRACKING_SAMPLE_FPS || 8), 4, 10));
const nativeTrackingImageSize = Math.round(clamp(Number(process.env.NATIVE_TRACKING_IMAGE_SIZE || 800), 640, 960));
const nativeTrackingBallImageSize = Math.round(clamp(Number(process.env.NATIVE_TRACKING_BALL_IMAGE_SIZE || 1280), 960, 1440));
// Keep cloud video requests bounded. A single near-ten-minute inline request
// can repeatedly hit Vertex's 504 deadline even though its media size is valid.
// Overlapping three-minute windows retain cross-boundary action context and
// are merged back into absolute source time before scene selection.
const analysisChunkSeconds = Math.round(clamp(Number(process.env.ANALYSIS_CHUNK_SECONDS || 180), 60, 600));
const analysisChunkOverlap = clamp(Number(process.env.ANALYSIS_CHUNK_OVERLAP || 4), 0, 12);
const analysisFps = clamp(Number(process.env.ANALYSIS_FPS || 3), 1, 8);
const analysisHeight = Math.round(clamp(Number(process.env.ANALYSIS_HEIGHT || 480), 360, 720));
const analysisProxyConcurrency = Math.round(clamp(Number(process.env.ANALYSIS_PROXY_CONCURRENCY || 3), 1, 4));
const geminiRequestTimeoutMs = Math.round(clamp(Number(process.env.GEMINI_REQUEST_TIMEOUT_MS || 180000), 30000, 600000));
// Retained in health responses for compatibility; old environment pacing
// settings can no longer delay successful requests.
const geminiMinimumIntervalMs = 0;
const geminiKeyframing = activeKeyframeProvider === "gemini";
const geminiQuotaBaseDelayMs = Math.round(clamp(Number(process.env.GEMINI_QUOTA_BASE_DELAY_MS || 15000), 1000, 600000));
const geminiQuotaMaximumDelayMs = Math.round(clamp(Number(process.env.GEMINI_QUOTA_MAXIMUM_DELAY_MS || 60000), geminiQuotaBaseDelayMs, 1800000));
const passageInventoryVersion = 4;
const passageInventoryExcerptVersion = 3;
class Step1CoverageError extends Error {
  constructor(selectedSeconds, minimum) {
    super(`Step 1 selected only ${selectedSeconds.toFixed(1)} naturally paced seconds; it must discover and validate at least ${minimum} seconds of complete actions before keyframe tracking begins.`);
    this.selectedSeconds = selectedSeconds;
    this.minimum = minimum;
  }
}
const blockingAiQualityReview = /^(1|true|yes)$/i.test(String(process.env.BLOCKING_AI_QUALITY_REVIEW || ""));
// Cloud Run uses Application Default Credentials with Vertex AI, while local
// development may continue to use an explicit API key. Keep the pipeline gate
// independent from the credential transport so no long-lived key is required
// in the worker container.
const geminiEnabled = Boolean(
  String(process.env.GEMINI_API_KEY || "").trim()
  || (String(process.env.GOOGLE_CLOUD_PROJECT || "").trim() && String(process.env.GOOGLE_CLOUD_LOCATION || "").trim()),
);
const outputWidth = 1080;
const outputHeight = 1920;
const maxUploadBytes = 2 * 1024 * 1024 * 1024;
const allowedOrigins = new Set(
  [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    ...localStudioOrigins(),
    process.env.SITE_URL,
  ].filter(Boolean),
);
const youtubeCredentialFile = process.env.YOUTUBE_OAUTH_CLIENT_FILE ? resolveSetting(process.env.YOUTUBE_OAUTH_CLIENT_FILE) : "";
const youtubeRedirectUri = String(process.env.YOUTUBE_OAUTH_REDIRECT_URI || `http://127.0.0.1:${port}/youtube/oauth/callback`);
const jobQueue = createJobQueue(error => console.error("Job queue error", error));
const recoveryScheduler = createRecoveryScheduler({readJob,isQueued:id=>jobQueue.has(id),
  retry:job=>job.processingRecovery.action==='render'?retryRenderJob(null,job.id,true):retryAnalysisJob(null,job.id,true),
  onError:async(error,id)=>{console.error('Automatic retry could not start',id,error);
    await handleProcessingInterruption(id,error);}});

async function handleProcessingInterruption(id,error) {
  const job=await readJob(id);
  const next=processingInterruption(job,error);
  // The completed-video narration workflow must resume its own checkpoints,
  // not the legacy render repair path that rewrites copy from source notes.
  if(job.narrationProductionVersion===1 && next.processingRecovery)
    next.processingRecovery.action='analysis';
  await updateJob(job,next.stage,job.progress||0,next);
  if(next.stage==='waiting_retry') recoveryScheduler.schedule(id,Date.parse(next.processingRecovery.retryAt));
}

async function restoreProcessingRetries() {
  const interruptedStages=new Set(['queued','detecting_moments','tracking','writing_content',
    'aligning','aligning_content','generating_commentary','editing','rendering','validating']);
  for(const name of await readdir(jobRoot)) {
    if(!name.endsWith('.json'))continue;
    try {const job=await readJob(name.slice(0,-5));
      if(job.stage==='waiting_retry')recoveryScheduler.schedule(job.id,Date.parse(job.processingRecovery?.retryAt)||Date.now());
      else if(interruptedStages.has(job.stage)&&!jobQueue.has(job.id)&&job.presentationOnly!==true) {
        // The in-memory execution disappeared with this processor. Leaving
        // its saved stage as "tracking" makes Reconnect poll forever without
        // any worker. Resume real checkpoints, not upload or completed jobs.
        await handleProcessingInterruption(job.id,Object.assign(
          new Error('The processor restarted; continuing from saved scenes and completed work.'),
          {code:'PROCESSOR_RESTART'}));
      }
    }catch(error){console.error('Could not restore saved retry',name,error);}
  }
}
const geminiRequestGate = createGeminiModelGate({
  maxConcurrent: Number(process.env.GEMINI_REQUEST_CONCURRENCY || 2), overloadDelayMs:geminiQuotaBaseDelayMs });
let activeGeminiJobId = null;
const geminiCapacityStates = new Map();
const geminiModelCooldownStates = new Map();
const workflowPerformance = createWorkflowPerformance();
const pendingActionGuideObservations = new Map();
const restoredCapacityCooldownJobs = new Set();
const unavailableGeminiFailoverModels = new Set();

await Promise.all([mkdir(uploadRoot, { recursive: true }), mkdir(outputRoot, { recursive: true }), mkdir(jobRoot, { recursive: true })]);
const saveJobJson = createSerializedJsonStore(jobRoot);
const youtubePublisher = await createYouTubePublisher({
  dataRoot,
  credentialFile: youtubeCredentialFile,
  redirectUri: youtubeRedirectUri,
  allowedReturnOrigins: [...allowedOrigins],
});

const server = http.createServer(async (request, response) => {
  try {
    setCors(request, response);
    if (request.method === "OPTIONS") return send(response, 204);
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      const tools = await inspectTools();
      return json(response, 200, {
        ok: tools.ffmpeg && tools.ffprobe && tools.trackingPython && tools.trackingModel && tools.trackingBallModel && (!soccerNetEnabled || (tools.soccerNetPython && tools.soccerNetModel)),
        storage: dataRoot,
        analysisProvider: geminiEnabled ? (videoIntelligenceEnabled() ? "gemini+video_intelligence" : "gemini") : "local_fallback",
        videoIntelligence: videoIntelligenceEnabled(),
        ttsProvider: process.env.TTS_PROVIDER || "gemini",
        footballEditorSkillVersion: FOOTBALL_EDITOR_SKILL_VERSION,
        geminiRequests: { minimumIntervalMs: geminiMinimumIntervalMs, quotaRetry: "persistent",
          quotaBaseDelayMs: geminiQuotaBaseDelayMs, quotaMaximumDelayMs: geminiQuotaMaximumDelayMs,
          ...geminiRequestGate.status() },
        geminiModels:{discovery:geminiWorkloadModel('discovery'),script:geminiWorkloadModel('script'),framing:geminiWorkloadModel('framing')},
        geminiFailover:{discovery:geminiFailoverModels(geminiWorkloadModel('discovery')),
          script:geminiFailoverModels(geminiWorkloadModel('script')),
          framing:geminiFailoverModels(geminiWorkloadModel('framing'))},
        workers: { analysisProxyConcurrency, trackingSceneConcurrency, nativeTrackingSampleFps },
        tools,
      });
    }
    if (request.method === "GET" && url.pathname === "/youtube/channels") return json(response, 200, await youtubePublisher.status());
    if (request.method === "GET" && url.pathname === "/youtube/oauth/start") {
      const location = await youtubePublisher.authorizationUrl(url.searchParams.get("returnTo") || localStudioReturnOrigin());
      response.writeHead(302, { Location: location, "Cache-Control": "no-store" }); return response.end();
    }
    if (request.method === "GET" && url.pathname === "/youtube/oauth/callback") {
      if (url.searchParams.get("error")) return youtubeCallbackHtml(response, { error: url.searchParams.get("error_description") || url.searchParams.get("error") });
      try {
        const result = await youtubePublisher.completeAuthorization({ code: url.searchParams.get("code"), state: url.searchParams.get("state") });
        return youtubeCallbackHtml(response, { channel: result.channel, returnOrigin: result.returnOrigin });
      } catch (error) {
        return youtubeCallbackHtml(response, { error: error instanceof Error ? error.message : "YouTube authorization failed." });
      }
    }
    if (request.method === "POST" && url.pathname === "/youtube/uploads") {
      const body = await readJsonBody(request, 64 * 1024);
      const jobId = String(body.jobId || "");
      if (!/^[a-f0-9-]{36}$/i.test(jobId)) return json(response, 400, { error: "A completed video job is required." });
      const job = await readJob(jobId);
      if (job.stage !== "completed" || !job.outputKey) return json(response, 409, { error: "Finish rendering the video before uploading it." });
      const upload = await youtubePublisher.upload({
        jobId,
        channelId: String(body.channelId || ""),
        outputPath: job.outputKey,
        title: String(body.title || job.editPlan?.title || "Touchline AI football recap"),
        description: String(body.description || ""),
      });
      return json(response, 200, upload);
    }
    if (request.method === "POST" && url.pathname === "/jobs") return await createJob(request, response);
    if (request.method === "GET" && url.pathname === "/jobs") return await listLocalJobs(response);
    if (request.method === "POST" && url.pathname === "/imports/youtube") return await createLocalYouTubeImport(request, response);
    const retryImportMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]+)\/retry-import$/i);
    if (request.method === "POST" && retryImportMatch) return await retryLocalYouTubeImport(response, retryImportMatch[1]);
    const startMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]+)\/start$/i);
    if (request.method === "POST" && startMatch) return await startLocalImportedJob(request, response, startMatch[1]);
    const retryAnalysisMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]+)\/retry-analysis$/i);
    if (request.method === "POST" && retryAnalysisMatch) return await retryAnalysisJob(response, retryAnalysisMatch[1]);
    const reselectBlockedMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]+)\/reselect-blocked$/i);
    if (request.method === "POST" && reselectBlockedMatch) return await retryAnalysisJob(response,reselectBlockedMatch[1],false,true);
    const retryRenderMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]+)\/retry-render$/i);
    if (request.method === "POST" && retryRenderMatch) {
      // Presentation-only retries reuse the locked scenes, tracking and
      // narration. This is used when a render-layer overlay changes and must
      // never reopen discovery or semantic analysis.
      return await retryRenderJob(response, retryRenderMatch[1], false, url.searchParams.get("presentationOnly") === "1");
    }
    const jobMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]+)$/i);
    if (request.method === "GET" && jobMatch) return await getJob(response, jobMatch[1]);
    const outputMatch = url.pathname.match(/^\/outputs\/([a-f0-9-]+)\/final\.mp4$/i);
    if (request.method === "GET" && outputMatch) return await streamOutput(request, response, outputMatch[1]);
    const sourceMatch = url.pathname.match(/^\/sources\/([a-f0-9-]+)$/i);
    if (request.method === "GET" && sourceMatch) return await streamLocalSource(request, response, sourceMatch[1]);
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return json(response, 500, { error: error instanceof Error ? error.message : "Unexpected processor error" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Touchline local processor: http://127.0.0.1:${port}`);
  console.log(`Private storage: ${dataRoot}`);
  void restoreProcessingRetries().catch(console.error);
});

async function createJob(request, response) {
  const length = Number(request.headers["content-length"] || 0);
  if (length > maxUploadBytes) return json(response, 413, { error: "Video exceeds the 2 GB local limit." });
  const originalName = safeFileName(decodeURIComponent(String(request.headers["x-file-name"] || "source.mp4")));
  const contentType = String(request.headers["content-type"] || "application/octet-stream");
  if (!contentType.startsWith("video/")) return json(response, 415, { error: "Upload must be a video file." });
  const settings = parseSettings(String(request.headers["x-edit-settings"] || ""));
  const requestedId = String(request.headers["x-job-id"] || "").trim();
  const allowExternalJobId = /^(1|true|yes)$/i.test(String(process.env.ALLOW_EXTERNAL_JOB_ID || ""));
  if (requestedId && (!allowExternalJobId || !/^[a-f0-9-]{36}$/i.test(requestedId))) {
    return json(response, 400, { error: "The requested job ID is not allowed." });
  }
  const id = requestedId || randomUUID();
  if (requestedId) {
    try {
      await stat(join(jobRoot, `${id}.json`));
      return json(response, 409, { error: "This job ID already exists." });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
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
  let media;
  try {media=await probe(sourcePath);assertSourceDuration(media.duration);}
  catch(error){await rm(sourcePath,{force:true});return json(response,422,{error:error.message,code:'SOURCE_VALIDATION'});}
  const job = {
    id, stage: "uploaded", progress: 5, sourceKey: sourcePath, sourceName: originalName,
    settings, media, moments: [], warnings: [], createdAt: now, updatedAt: now,
  };
  await saveJob(job);
  await jobQueue.submit(id, () => true, () => processJob(id));
  return json(response, 202, publicJob(job));
}

async function retryAnalysisJob(response, id, automatic=false, reselectBlocked=false) {
  if (jobQueue.has(id)) return json(response, 409, { error: "This video is already queued or processing. Wait for its current run to finish." });
  recoveryScheduler.cancel(id);
  await jobQueue.submit(id, async () => {
  let job;
  try { job = await readJob(id); }
  catch { json(response, 404, { error: "Job not found" }); return false; }
  try { await stat(job.sourceKey); }
  catch { if(automatic){const error=new Error('The saved source video is missing; upload it again.');error.code='SOURCE_VALIDATION';throw error;}
    json(response, 409, { error: "The saved source video is missing; upload it again." }); return false; }
  const sourceSelectionUpgrade = Number(job.clearAngleWorkflowVersion || 0)>0
    && Number(job.clearAngleWorkflowVersion)<CLEAR_ANGLE_WORKFLOW_VERSION
    && (Number(job.progress || 0)>=30 || job.resumeTrackingOnly===true);
  const savedLockedScenes = sourceSelectionUpgrade || (job.clearAngleWorkflowVersion === CLEAR_ANGLE_WORKFLOW_VERSION
    && (Number(job.progress || 0) >= 34 || job.resumeTrackingOnly === true))
    ? await loadStep1SceneManifest(id, job.settings, {sourceOnly:sourceSelectionUpgrade}) : [];
  const hasSavedSceneLock = savedLockedScenes.some(moment => moment.selectionLocked === true);
  if(reselectBlocked && (!geminiEnabled||!hasSavedSceneLock||job.stage!=='attention_required')) {
    json(response,409,{error:'Blocked source reselection requires a saved scene lock that needs attention.'});
    return false;
  }
  const reusableCandidates = Number(job.progress || 0) >= 30
    && job.media
    && (hasSavedSceneLock || (Array.isArray(job.moments) && job.moments.length > 0))
    && !/Gemini video analysis failed|could not return numeric football scenes/i.test(String(job.error?.message || ""));
  const trackingOnlyRetry = reusableCandidates
    && job.clearAngleWorkflowVersion === CLEAR_ANGLE_WORKFLOW_VERSION
    && (hasSavedSceneLock || job.moments.some(moment => moment.selectionLocked === true))
    && (Number(job.progress || 0) >= 34
      || ["tracking", "writing_content", "aligning", "aligning_content", "generating_commentary", "editing", "rendering", "validating", "completed"].includes(job.stage)
      || /Locked scene|keyframe|tracking or framing repair|incident\(s\).*tracking has not passed|Complete-match coverage is missing/i.test(String(job.error?.message || "")));
  // Only a job that passed Step 1 may be restored from the immutable lock
  // manifest. A pre-lock semantic failure must resume from its saved inventory
  // so the newer verifier can re-review it; attempting to synthesize a locked
  // manifest here repeats the old duration failure inside the HTTP request.
  const savedStep1Scenes = trackingOnlyRetry || sourceSelectionUpgrade ? savedLockedScenes : [];
  const restarted = reusableCandidates
    ? { ...job, moments: savedStep1Scenes.length ? savedStep1Scenes : (job.observedMoments?.length ? job.observedMoments : job.moments), resumeFromCandidates: true }
    : { ...job, moments: [], warnings: [], overlayMasks: [], discoveryPassesCompleted: 0 };
  restarted.resumeTrackingOnly = trackingOnlyRetry;
  if(reselectBlocked) restarted.resumeBlockedSelection=true;
  restarted.processingRecovery=automatic?{...job.processingRecovery,status:'retrying'}:undefined;
  for (const key of ["error", "outputKey", "outputUrl", "completedAt", "qualityReview", "renderValidation", "editPlan", "trackingSummary", "evidenceReport"]) delete restarted[key];
  restarted.progress = trackingOnlyRetry ? 34 : reusableCandidates ? 30 : 5;
  restarted.progressDetail = trackingOnlyRetry
    ? "Resuming player-and-ball framing from the saved scene lock; discovery is not restarting."
    : reusableCandidates ? "Resuming source selection from saved observations." : "Starting source analysis.";
  job = await updateJob(restarted, trackingOnlyRetry ? "tracking" : reusableCandidates ? "detecting_moments" : "uploaded", restarted.progress);
  json(response, 202, publicJob(job));
  return true;
  }, () => processJob(id));
}
async function retryRenderJob(response, id, automatic=false, presentationOnly=false) {
  if (jobQueue.has(id)) return json(response, 409, { error: "This video is already queued or processing. Wait for its current run to finish." });
  const saved = await readJob(id).catch(()=>null);
  if(saved?.narrationProductionVersion===1 && !presentationOnly) return retryAnalysisJob(response,id,automatic);
  recoveryScheduler.cancel(id);
  await jobQueue.submit(id, async () => {
  let job;
  try { job = await readJob(id); }
  catch { json(response, 404, { error: "Job not found" }); return false; }
  if (!job.sourceKey || !job.media || !Array.isArray(job.moments)) {
    if(automatic)throw new Error('Saved render scene data needs repair before rendering can retry.');
    json(response, 409, { error: "This job does not have enough saved data to retry rendering." }); return false; }
  const cleanJob = { ...job, progress:84, presentationOnly, processingRecovery:automatic?{...job.processingRecovery,status:'retrying'}:undefined, progressDetail:"Re-rendering the saved visual edit; approved tracking and narration will be reused.", retryRenderReason: String(job.error?.message || job.processingRecovery?.lastError || "") };
  delete cleanJob.error;
  job = await updateJob(cleanJob, "queued", 84);
  json(response, 202, publicJob(job));
  return true;
  }, () => resumeRender(id));
}

async function resumeRender(id) {
  let job = await readJob(id);
  const destination = join(outputRoot, id);
  const premixPath = join(destination, "premix.mp4");
  const outputPath = join(destination, "final.mp4");
  if (job.presentationOnly === true && isCompleteHighlights(job.settings) && job.settings.commentary) {
    try {
      await resumePresentationOnlyRender(job, destination, outputPath);
    } catch (error) {
      console.error(`Job ${id} presentation-only render failed`, error);
      await handleProcessingInterruption(id, error);
    }
    return;
  }
  if (/final audio mix failed/i.test(String(job.retryRenderReason || ""))) {
    try {
      await stat(premixPath);
      await stat(outputPath);
      job = await updateJob(job, "rendering", 94, { progressDetail: "Re-normalizing the saved final audio mix without re-encoding video." });
      const loudness = await normalizeFinishedAudio(premixPath, outputPath);
      const renderValidation = await validateRenderedVideo(outputPath, job.settings);
      delete job.retryRenderReason;
      await updateJob(job, "completed", 100, {
        outputKey: outputPath,
        outputUrl: publicOutputUrl(id),
        renderValidation,
        qualityReview: job.qualityReview,
        completedAt: new Date().toISOString(),
        progressDetail: "Audio normalized and final video validated.",
        loudness,
      });
      return;
    } catch {
      // If the saved premix is unavailable or invalid, continue through the
      // normal render-only path below.
    }
  }
  if (isCompleteHighlights(job.settings) && job.media?.duration) {
    const requestedDuration = requestedRecapSeconds(job.settings.recapBrief);
    if (!["narration_fitted", "paced_complete_actions"].includes(job.settings.durationMode) && requestedDuration && requestedDuration > Number(job.settings.targetDuration || 0)) {
      job.settings = { ...job.settings, durationMode: "requested", targetDuration: requestedDuration };
      job.warnings.push("Restored the original requested visual duration before retrying the saved plan.");
    }
    job.settings = applyCompleteDurationBounds(job.settings, job.media.duration);
    if (job.settings.commentary) job.settings = { ...job.settings, originalAudio: "muted" };
    job.moments = recoverSafeStaticCandidates(job.moments);
  }
  // A render retry is Step 2 presentation repair. Restore any possession-chain
  // footage removed by an older tracker before checking semantic signatures;
  // a locked Step-1 approval must never be sent back for rejection merely
  // because its start was extended to include the passer/carrier.
  job.moments = restorePossessionChainStarts(job.moments);
  try {
    // A presentation-only retry is intentionally render-only. The scene
    // boundaries, tracking evidence, and narration are already locked; do not
    // spend new provider requests rechecking semantic source observations.
    const staleSemanticIds = job.presentationOnly ? [] : job.moments.filter(needsSemanticReview).map((moment) => moment.id);
    if (staleSemanticIds.length) {
      job = await updateJob(job, "verifying_scenes", 42, {
        progressDetail: `Rechecking ${staleSemanticIds.length} saved scene(s) for complete contact, ball flight and payoff boundaries.`,
      });
      const semantic = await verifyCandidateSemanticsWithGemini(job.sourceKey, job.moments, id, staleSemanticIds);
      job = await updateJob(job, "tracking", 48, {
        moments: semantic.candidates,
        observedMoments: semantic.candidates,
        progressDetail: "Saved scenes now contain complete reviewed action boundaries; repairing portrait keyframes.",
      });
    }
    const pacedPreview = applyCompleteHighlightTreatment(job.moments, job.settings);
    const naturallyPacedDuration = selectedTimelineDuration(pacedPreview);
    const previousTargetDuration = Number(job.settings.targetDuration || 0);
    const savedLockedDuration=Number(job.editPlan?.plannedDuration || 0);
    const timingReferenceDuration=savedLockedDuration>0
      && job.moments.filter(moment=>moment.selectedForFinalVideo).every(moment=>moment.selectionLocked===true)
      ? savedLockedDuration : previousTargetDuration;
    const pacingDurationExpanded = isCompleteHighlights(job.settings)
      && naturallyPacedDuration > timingReferenceDuration + 3;
    if (pacingDurationExpanded) {
      const adjustedTarget = clamp(
        Math.ceil(naturallyPacedDuration),
        Number(job.settings.durationMin ?? COMPLETE_RECAP_MINIMUM_SECONDS),
        Number.isFinite(Number(job.settings.durationMax)) ? Number(job.settings.durationMax) : Infinity,
      );
      job.settings = { ...job.settings, durationMode: "paced_complete_actions", targetDuration: adjustedTarget };
      const warning = `Expanded the edit from the ${previousTargetDuration.toFixed(0)}-second guide to ${adjustedTarget} seconds so every complete action stays at or below ${COMPLETE_HIGHLIGHT_MAX_PLAYBACK_RATE.toFixed(1)}x.`;
      if (!job.warnings.includes(warning)) job.warnings.push(warning);
    }
    const savedMatchContext = job.matchContext || job.editPlan?.matchContext;
    const safeMatchContext = invalidateConflictingMatchContext(
      savedMatchContext || { identityResearchVersion: 5, status: "unverified", confidence: 0, reason: "not_researched", sources: [] },
      job.sourceName,
      verifiedLiveGoalActions(job.moments).length,
    );
    const matchContextInvalidated = savedMatchContext?.status === "verified" && safeMatchContext.status !== "verified";
    const savedScript = String(job.editPlan?.contentScript || job.editPlan?.narrationScript || "");
    const savedWordCount = savedScript.trim().split(/\s+/).filter(Boolean).length;
    const measuredSavedVoice=Number(job.editPlan?.narrationDuration || 0);
    const measuredSavedVoiceRatio=measuredSavedVoice/Math.max(1,naturallyPacedDuration);
    const narrationPacingMismatch = isCompleteHighlights(job.settings)
      && (measuredSavedVoice>0
        ? measuredSavedVoiceRatio<.94 || measuredSavedVoiceRatio>1.10
        : savedWordCount < Math.round(Number(job.settings.targetDuration || 0) * 3.0));
    const unsafeUnverifiedNarration = safeMatchContext.status !== "verified"
      && (unverifiedNamedEntities([savedScript], []).length > 0 || /\b\d{1,2}\s*[-:–—]\s*\d{1,2}\b/.test(savedScript));
    if (!job.presentationOnly && (matchContextInvalidated || unsafeUnverifiedNarration || pacingDurationExpanded || narrationPacingMismatch)) {
      const scriptCandidates = selectDirectorCandidates(job.moments).filter(narratableEvidence);
      const verifiedEvidenceDuration = availableVerifiedEvidenceDuration(scriptCandidates);
      const editableDuration = planningEvidenceCapacity(scriptCandidates, job.settings);
      const verifiedGoalActionCount = verifiedLiveGoalActions(scriptCandidates).length;
      job = await updateJob(job, "writing_content", 50, {
        matchContext: safeMatchContext,
        progressDetail: pacingDurationExpanded || narrationPacingMismatch
          ? `Rewriting narration for the naturally paced ${job.settings.targetDuration}-second edit; gameplay speed is capped at ${COMPLETE_HIGHLIGHT_MAX_PLAYBACK_RATE.toFixed(1)}x.`
          : "The saved match identity conflicts with the visible score/goal inventory. Rewriting narration from verified on-screen evidence without invented names.",
      });
      let correctedContent = await writeAnalysisContentWithGemini(
        scriptCandidates,
        job.media,
        job.settings,
        verifiedEvidenceDuration,
        editableDuration,
        scriptCandidates.length,
        verifiedGoalActionCount,
        safeMatchContext,
      );
      correctedContent = fitContentPlanToEvidenceSlots(correctedContent, scriptCandidates.length, job.settings.targetDuration);
      correctedContent = sanitizeUnverifiedContentPlan(correctedContent, safeMatchContext, job.settings);
      job.editPlan = {
        ...job.editPlan,
        ...correctedContent,
        matchContext: safeMatchContext,
        narrationScript: correctedContent.contentScript,
        synchronization: [],
        verifiedEvidenceDuration,
        editableEvidenceDuration: editableDuration,
      };
      job.matchContext = safeMatchContext;
      job.moments = job.moments.map((moment) => ({
        ...moment,
        commentary: undefined,
        beatId: undefined,
        analysisPurpose: undefined,
      }));
      job = await updateJob(job, "aligning_content", 54, { editPlan: job.editPlan, moments: job.moments });
    }
    job.editPlan = recoverLockedNarrationPlan(job.editPlan, job.moments);
    job.editPlan = sanitizeSavedEditPlan(job.editPlan, job.editPlan?.matchContext, job.settings);
    const savedMasterNarration = authoritativeSavedNarration(job.editPlan, job.moments);
    job.moments = sanitizeUnverifiedMoments(job.moments, job.editPlan?.matchContext);
    job = await updateJob(job, "tracking", 48);
    let originalSavedPlan = restoreOriginalPlannedScenes(job.moments, job.editPlan?.contentBeats);
    originalSavedPlan = applyNarrationToLockedVisualTimeline(originalSavedPlan, job.editPlan);
    const savedSelected = originalSavedPlan.filter((moment) => moment.selectedForFinalVideo);
    const savedCoveredBeatCount = new Set(
      savedSelected.filter((moment) => moment.commentary).map((moment) => String(moment.beatId || "")),
    ).size;
    const savedBeatCount = Array.isArray(job.editPlan?.contentBeats) ? job.editPlan.contentBeats.length : 0;
    const savedDuration = selectedTimelineDuration(originalSavedPlan);
    const savedSequenceProblems = highlightSequenceProblems(savedSelected, { availableMoments: job.moments, requireAvailableCompanionsOnly: isCompleteHighlights(job.settings) });
    const needsAlignmentRepair = savedSelected.length === 0
      || savedCoveredBeatCount < savedBeatCount
      || savedDuration < minimumPlannedDuration(job.settings)
      || savedDuration > planningCeiling(job.settings) + 3
      || (savedSequenceProblems.length && !isCompleteHighlights(job.settings));
    if (!job.presentationOnly && needsAlignmentRepair && savedBeatCount) {
      const verifiedEvidenceDuration = Number(job.editPlan.verifiedEvidenceDuration)
        || availableVerifiedEvidenceDuration(job.moments);
      const editableDuration = Number(job.editPlan.editableEvidenceDuration)
        || editableEvidenceDuration(job.moments);
      let contentPlan = normalizeContentPlan({
        title: job.editPlan.title,
        editorialThesis: job.editPlan.editorialThesis,
        contentAngle: job.editPlan.contentAngle,
        storyQuestion: job.editPlan.storyQuestion,
        storyAnswer: job.editPlan.storyAnswer,
        contentBeats: job.editPlan.contentBeats,
      }, job.settings.targetDuration);
      const verifiedDirectorSlots = selectDirectorCandidates(job.moments).filter(narratableEvidence).length;
      const originalBeatCount = contentPlan.contentBeats.length;
      contentPlan = fitContentPlanToEvidenceSlots(contentPlan, verifiedDirectorSlots, job.settings.targetDuration);
      contentPlan = sanitizeUnverifiedContentPlan(contentPlan, job.editPlan?.matchContext, job.settings);
      if (contentPlan.contentBeats.length < originalBeatCount) {
        const warning = `Consolidated ${originalBeatCount - contentPlan.contentBeats.length} adjacent analysis beat(s) so every narration beat has its own verified scene.`;
        if (!job.warnings.includes(warning)) job.warnings.push(warning);
      }
      job = await updateJob(job, "aligning_content", 48, {
        editPlan: {
          ...job.editPlan,
          contentBeats: contentPlan.contentBeats,
          contentScript: contentPlan.contentScript,
          wordCount: contentPlan.wordCount,
        },
      });
      const resumedEditPlan = await alignContentReliably(contentPlan, job.moments, job.settings, verifiedEvidenceDuration, editableDuration);
      originalSavedPlan = applyEditPlan(job.moments, resumedEditPlan, planningCeiling(job.settings), job.settings);
      originalSavedPlan = restoreContentBeatOrder(originalSavedPlan, contentPlan.contentBeats);
      job = await updateJob(job, "tracking", 56, {
        moments: originalSavedPlan,
        editPlan: {
          ...job.editPlan,
          rationale: resumedEditPlan.rationale || "",
          verifiedEvidenceDuration,
          editableEvidenceDuration: editableDuration,
        },
      });
    }
    let orderedSavedMoments = restorePossessionChainStarts(
      restoreContentBeatOrder(originalSavedPlan, job.editPlan?.contentBeats),
    );
    let trackingPool = buildTrackingPool(orderedSavedMoments);
    let tracking = await loadOrTrackFootball(job.sourceKey, trackingPool, job.media, id);
    tracking = stabilizeTrackingForScenes(tracking, trackingPool, job.media, job.settings.aspectRatio === "16:9");
    const boundaryAdjusted = trimUnframeableDistributionLeadIns(orderedSavedMoments, tracking);
    orderedSavedMoments = boundaryAdjusted.scenes;
    tracking = boundaryAdjusted.tracking;
    trackingPool = buildTrackingPool(orderedSavedMoments);
    tracking = stabilizeTrackingForScenes(tracking, trackingPool, job.media, job.settings.aspectRatio === "16:9");
    await writeFile(join(destination, "tracking", "tracking.json"), JSON.stringify(tracking));
    let plannedMoments = applyCompleteHighlightTreatment(applyTrackingQuality(orderedSavedMoments, tracking, job.settings), job.settings);
    let plannedDuration = selectedTimelineDuration(plannedMoments);
    for (let repairPass = 0; plannedDuration < minimumPlannedDuration(job.settings) && repairPass < orderedSavedMoments.length; repairPass += 1) {
      const repaired = applyCompleteHighlightTreatment(repairPlanWithTrackedBackups(orderedSavedMoments, plannedMoments, tracking, minimumPlannedDuration(job.settings), job.settings.intensity, job.settings), job.settings);
      plannedMoments = restoreContentBeatOrder(repaired, job.editPlan?.contentBeats);
      const repairedDuration = selectedTimelineDuration(plannedMoments);
      if (repairedDuration <= plannedDuration + 0.01) break;
      plannedDuration = repairedDuration;
    }
    if (job.settings.durationMode !== "auto") {
      plannedMoments = expandVerifiedTimeline(plannedMoments, job.settings.targetDuration);
      plannedMoments = fitSelectedTimelineToCeiling(plannedMoments, job.settings.targetDuration, 3);
    }
    plannedMoments = sanitizeUnverifiedMoments(plannedMoments, job.editPlan?.matchContext);
    plannedMoments = applyNarrationToLockedVisualTimeline(plannedMoments, job.editPlan);
    plannedDuration = selectedTimelineDuration(plannedMoments);
    const plannedFrameable = plannedMoments.filter((moment) => moment.selectedForFinalVideo);
    const coveredBeatCount = new Set(
      plannedFrameable.filter((moment) => moment.commentary).map((moment) => String(moment.beatId || "")),
    ).size;
    const requiredBeatCount = Array.isArray(job.editPlan?.contentBeats) ? job.editPlan.contentBeats.length : 0;
    const plannedSequenceProblems = highlightSequenceProblems(plannedFrameable, { availableMoments: plannedMoments, requireAvailableCompanionsOnly: isCompleteHighlights(job.settings) });
    const blockingPlannedSequenceProblems = isCompleteHighlights(job.settings) ? [] : plannedSequenceProblems;
    if (plannedSequenceProblems.length && isCompleteHighlights(job.settings)) {
      const warning = `Complete verified goal actions were preserved without optional companion footage: ${plannedSequenceProblems.join(", ")}.`;
      if (!job.warnings.includes(warning)) job.warnings.push(warning);
    }
    const deliveryFailures = [];
    if (plannedFrameable.length < 1) deliveryFailures.push("no_selected_action_scenes");
    if (uniqueEvidenceCandidates(plannedFrameable).length !== plannedFrameable.length) deliveryFailures.push("duplicate_source_intervals");
    if (plannedDuration < minimumPlannedDuration(job.settings)) deliveryFailures.push(`duration_short_${plannedDuration.toFixed(1)}s`);
    if (plannedDuration > planningCeiling(job.settings) + 3) deliveryFailures.push(`duration_long_${plannedDuration.toFixed(1)}s`);
    if (coveredBeatCount < requiredBeatCount) deliveryFailures.push(`missing_narration_beats_${coveredBeatCount}_of_${requiredBeatCount}`);
    deliveryFailures.push(...blockingPlannedSequenceProblems);
    if (deliveryFailures.length) throw new Error(`Tracked evidence cannot safely render the saved plan: ${deliveryFailures.join(", ")}.`);
    job = await updateJob(job, "generating_commentary", 60, {
      moments: plannedMoments,
      trackingSummary: tracking.summary,
      editPlan: {
        ...job.editPlan,
        selectedCount: plannedMoments.filter((moment) => moment.selectedForFinalVideo).length,
        plannedDuration,
        narrationScript: savedMasterNarration || buildContinuousNarration(plannedMoments),
      },
    });
    const ttsFiles = job.settings.commentary ? await loadSavedSpeech(plannedMoments, id, savedMasterNarration) : new Map();
    if (job.settings.commentary) { await fitContinuousNarrationToLockedTimeline(ttsFiles, plannedDuration, id); job.editPlan = { ...job.editPlan, narrationScript: savedMasterNarration || buildContinuousNarration(plannedMoments), narrationDuration: ttsFiles.narrationDuration }; }
    await mkdir(destination, { recursive: true });
    const stadiumAudioPath = isCompleteHighlights(job.settings) && !job.settings.commentary && job.settings.originalAudio !== "muted"
      ? await makeStadiumAudio(job.sourceKey, plannedFrameable, id)
      : null;
    job = await updateJob(job, "rendering", 84);
    const renderResult = await renderVideoV2(job.sourceKey, outputPath, plannedMoments, job.settings, job.media, ttsFiles, job.overlayMasks || [], tracking, stadiumAudioPath, job.matchContext || job.editPlan?.matchContext);
    job = await updateJob(job, "validating", 96, {
      editPlan: { ...job.editPlan, synchronization: renderResult.synchronization },
    });
    const renderValidation = await validateRenderedVideo(outputPath, job.settings);
    await writeTransformationAudit(destination, job, job.media, plannedFrameable, job.editPlan?.contentScript);
    let qualityReview;
    if (geminiEnabled && blockingAiQualityReview && !job.presentationOnly) {
      try {
        qualityReview = await reviewRenderedVideoWithGemini(outputPath, renderValidation.media, id, job.settings, plannedMoments, job.matchContext);
        if (!qualityReview.approved) {
          const issues = qualityReview.issues.slice(0, 3).join("; ");
          job.warnings.push(`AI quality review scored this edit ${qualityReview.score}/100${issues ? `: ${issues}` : "."}`);
        }
      } catch (error) {
        job.warnings.push(`The final AI quality review could not run, but deterministic media validation passed and the playable export was preserved: ${sanitizeProviderError(String(error?.message || error))}`);
      }
    }
    if (qualityReview && !qualityReview.approved) {
      const issues = qualityReview.issues.slice(0, 3).join("; ");
      job.warnings.push(`AI quality review requested improvements at ${qualityReview.score}/100${issues ? `: ${issues}` : "."} The playable export was preserved instead of failing the job.`);
    }
    await updateJob(job, "completed", 100, {
      outputKey: outputPath,
      outputUrl: publicOutputUrl(id),
      renderValidation,
      qualityReview,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`Job ${id} render retry failed`, error);
    const saved = await readJob(id);
    job = { ...job, ...saved, warnings: [...new Set([...(saved.warnings || []), ...(job.warnings || [])])] };
    await handleProcessingInterruption(id,error);
  }
}

// Rebuild only the visual master and final narration mix after a presentation
// change (for example removing a static corner label). All scene boundaries,
// tracking evidence, and timed narration are already saved, so this path must
// not call Gemini, rediscover scenes, or rewrite the script.
async function resumePresentationOnlyRender(job, destination, outputPath) {
  const locked = JSON.parse(await readFile(join(destination, "locked-visual-timeline.json"), "utf8"));
  const tracking = JSON.parse(await readFile(join(destination, "tracking", "tracking.json"), "utf8"));
  const timedManifest = JSON.parse(await readFile(join(destination, "speech", "timed", "master-manifest.json"), "utf8"));
  const savedMoments = Array.isArray(job.moments) && job.moments.some((moment) => moment?.selectedForFinalVideo === true)
    ? job.moments : locked.moments;
  const selected = (Array.isArray(savedMoments) ? savedMoments : [])
    .filter((moment) => moment?.selectedForFinalVideo !== false);
  const matchContext = job.matchContext || job.editPlan?.matchContext || locked.matchContext || null;
  const media = job.media || await probe(job.sourceKey);
  const visual = await prepareCompletedVisualNarration(
    job,
    selected,
    media,
    job.overlayMasks || [],
    tracking,
    matchContext,
    locked.visualReviewManifest,
  );
  const narrationPath = join(destination, "speech", "timed", String(timedManifest.filename || "narration-master.wav"));
  const files = new Map([["__narration__", narrationPath]]);
  files.timedSections = Array.isArray(timedManifest.takes) ? timedManifest.takes : [];
  files.narrationDuration = Number(timedManifest.duration || 0);
  files.narrationScript = String(timedManifest.narration || "");
  const renderResult = await finishCompletedVisualNarration(visual, outputPath, selected, job.settings, files);
  const renderValidation = await validateRenderedVideo(outputPath, job.settings);
  await updateJob(job, "completed", 100, {
    presentationOnly: false,
    outputKey: outputPath,
    outputUrl: publicOutputUrl(job.id),
    renderValidation,
    qualityReview: job.qualityReview,
    loudness: renderResult.loudness,
    completedAt: new Date().toISOString(),
    progressDetail: "Presentation updated and final video validated without re-running analysis.",
  });
}
async function loadSavedSpeech(moments, id, savedMasterNarration = "") {
  return makeContinuousSpeech(String(savedMasterNarration || "").trim() || buildContinuousNarration(moments), id);
}

function authoritativeSavedNarration(editPlan, moments) {
  const synchronized = (Array.isArray(editPlan?.synchronization) ? editPlan.synchronization : [])
    .find((item) => item?.momentId === "__continuous_master__" && String(item?.narration || "").trim());
  if (synchronized) return String(synchronized.narration).trim();
  return String(editPlan?.narrationScript || "").trim() || buildContinuousNarration(moments);
}

function recoverLockedNarrationPlan(editPlan, moments) {
  const authoritativeScript = authoritativeSavedNarration(editPlan, moments);
  if (!authoritativeScript) return editPlan;
  const recoveredPlan = authoritativeScript === String(editPlan?.narrationScript || "").trim()
    ? editPlan : { ...editPlan, narrationScript: authoritativeScript };
  const locked = (Array.isArray(moments) ? moments : [])
    .filter((moment) => moment.selectedForFinalVideo && String(moment.commentary || "").trim())
    .sort((left, right) => Number(left.editOrder) - Number(right.editOrder));
  const lockedScript = buildContinuousNarration(locked);
  const savedContentScript = (Array.isArray(editPlan?.contentBeats) ? editPlan.contentBeats : [])
    .map((beat) => String(beat?.narration || "").trim()).filter(Boolean).join(" ");
  if (!locked.length || lockedScript !== authoritativeScript || savedContentScript === authoritativeScript) return recoveredPlan;
  const contentBeats = locked.map((moment, index) => ({
    beatId: String(moment.beatId || `beat-${index + 1}`),
    role: String(moment.role || "analysis"),
    narration: String(moment.commentary).trim(),
    evidenceNeed: String(moment.id),
    captionText: String(moment.onScreenText || eventHeadline(moment)),
  }));
  return {
    ...recoveredPlan,
    contentBeats,
    contentScript: authoritativeScript,
    wordCount: authoritativeScript.split(/\s+/).filter(Boolean).length,
  };
}

async function processJob(id) {
  activeGeminiJobId = id;
  let job = await readJob(id);
  try {
    if (isCompleteHighlights(job.settings) && job.media) {
      const updatedSettings = applyCompleteDurationBounds(job.settings, job.media.duration);
      if (Number(job.settings.durationMin) !== Number(updatedSettings.durationMin)) {
        job = await updateJob(job, job.stage, job.progress, { settings: updatedSettings });
      }
    }
    if (job.trackingRepairVersion !== 39) {
      job = await updateJob(job, job.stage, job.progress, {trackingRepairVersion:39,trackingRepairAttempts:[]});
    }
    if (job.pipelineVersion !== 7) {
      const hasLockedScenes = Array.isArray(job.moments) && job.moments.some(moment => moment.selectionLocked === true);
      const expectedGoals = goalTotalFromFilename(job.sourceName);
      const invalidLockedGoals = hasLockedScenes && expectedGoals != null
        && liveGoalStoryCount(job.moments, { lockedOnly: true }) !== expectedGoals;
      // Preserve a valid locked Step 2 manifest. An unlocked inventory, or a
      // locked manifest contradicted by an explicit match score, must reload
      // Step 1 from saved source evidence instead of retaining false goals.
      job = await updateJob(job, job.stage, job.progress, hasLockedScenes && !invalidLockedGoals
        ? { pipelineVersion: 7 }
        : { pipelineVersion: 7, resumeFromCandidates: false, moments: [], discoveryPassesCompleted: 0, trackingRepairAttempts: [],
          warnings: job.warnings.filter(warning => !/Target-aware discovery pass/i.test(warning)) });
    }
    const resumeFromCandidates = job.resumeFromCandidates === true
      && job.media
      && Array.isArray(job.moments)
      && job.moments.length > 0;
    const resumeTrackingOnly = resumeFromCandidates
      && job.resumeTrackingOnly === true
      && job.moments.some(moment => moment.selectionLocked === true);
    let media;
    let candidates;
    let overlayMasks;
    let editPlan;
    if (resumeFromCandidates) {
      media = job.media;
      candidates = job.moments;
      overlayMasks = Array.isArray(job.overlayMasks) ? job.overlayMasks : [];
      delete job.resumeFromCandidates;
      delete job.resumeTrackingOnly;
      const resumeWarning = resumeTrackingOnly
        ? "Resumed the locked Step 2 scene manifest for keyframe repair; Gemini discovery was not restarted."
        : "Resumed from saved whole-video candidates after the local processor restarted.";
      if (!job.warnings.includes(resumeWarning)) job.warnings.push(resumeWarning);
    } else {
      job = await updateJob(job, "analyzing", 12);
      media = await probe(job.sourceKey);
      job.media = media;
      // Apply the current source-aware duration bounds before discovery.
      if (isCompleteHighlights(job.settings)) {
        job.settings = applyCompleteDurationBounds(job.settings, media.duration);
      }
      overlayMasks = [];
      job=await updateJob(job,'analyzing',12,{
        progressDetail:'Indexing source camera cuts locally before the initial Gemini section analysis. No scenes have been combined.'});
      await ensureShotBoundaries(job.sourceKey, id);
      if (geminiEnabled) {
        const inventoryFirst = isCompleteHighlights(job.settings);
        const analysis = (inventoryFirst
          ? await analyzePassageInventoryWithGemini(job.sourceKey, media, job.settings.targetDuration, id)
          : await analyzeWithGemini(job.sourceKey, media, job.settings.targetDuration, id));
        candidates = analysis.moments;
        overlayMasks = analysis.overlayMasks;
        job.analysisProvider = inventoryFirst ? "gemini_initial_sections+pyscenedetect" : analysis.videoIntelligenceSummary?.processedChunks ? "gemini+video_intelligence" : "gemini";
        job.videoIntelligenceSummary = analysis.videoIntelligenceSummary;
        job.passageInventorySummary = analysis.passageInventorySummary;
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
        passageInventorySummary: job.passageInventorySummary,
      });
    }
    if(job.resumeBlockedSelection===true) {
      candidates=await reselectBlockedSourceActions(job.sourceKey,candidates,media,id);
      delete job.resumeBlockedSelection;
      job=await updateJob(await readJob(id),'tracking',34,{moments:candidates,resumeBlockedSelection:undefined,
        progressDetail:'Clearer source actions selected. Approved scene crops are preserved; tracking resumes only changed scenes.'});
    }
    let observedIncidentCandidates;
    if (!resumeTrackingOnly) {
    const initialSectionWorkflow = geminiEnabled && isCompleteHighlights(job.settings);
    if (initialSectionWorkflow) {
      // Old provisional jobs do not carry the new one-pass evidence contract.
      // Upgrade them once; a locked Step-2 retry never enters this branch.
      if (!candidates.every(scene=>scene.sourceSelectionEvidence?.version===INITIAL_SECTION_VERSION)) {
        const analysis=await analyzePassageInventoryWithGemini(job.sourceKey,media,job.settings.targetDuration,id);
        candidates=analysis.moments;overlayMasks=analysis.overlayMasks;
        job.passageInventorySummary=analysis.passageInventorySummary;
        job.warnings.push(...analysis.warnings);
      }
      job.settings=applyCompleteDurationBounds(job.settings,media.duration);
      if(job.settings.commentary) job.settings={...job.settings,originalAudio:'muted'};
      if(hybridKeyframing && fastTracking.enabled)
        candidates=await prepareGuidedSourceSelection(job.sourceKey,candidates,media,id);
      candidates=selectInitialActionViews(candidates.map(scene=>({...scene,
        selectionLocked:false,sceneSelectionApproved:false})));
      candidates=chooseInitialScenesForLock(candidates,job.settings,{
        requireSemanticVerification:true,sourceDuration:media.duration,
        sectionPlan:job.passageInventorySummary?.sectionPlan});
      candidates=candidates.map(scene=>({...scene,semanticSignature:semanticSignature(scene)}));
      const observedGoals=sourceGoalCountCoverage(candidates,null).observed;
      const selectedGoals=sourceGoalCountCoverage(candidates.filter(scene=>scene.sceneSelectionApproved),null).observed;
      if(selectedGoals!==observedGoals) throw new Error('Initial scene selection omitted an observed goal. Source clips are not locked.');
      // This is a local audit, not a scorebug request or missing-goal search.
      const coverage=sourceGoalCountCoverage(candidates.filter(scene=>scene.sceneSelectionApproved),goalTotalFromFilename(job.sourceName));
      const observedScoringCoverage=initialScoringCoverage(job.passageInventorySummary?.scoringObservations||[],
        candidates.filter(scene=>scene.sceneSelectionApproved),{resolvedCandidates:candidates});
      await writeFile(join(outputRoot,id,'source-goal-count-coverage.json'),JSON.stringify({
        ...coverage,complete:coverage.complete&&observedScoringCoverage.complete,
        observedScoringCoverage,coverageScope:'observed_source_incidents',
        expectedTotalKnown:coverage.expected!==null,
        observationPolicy:'initial_section_video_only',filenameScoreIsContext:true},null,2));
      if(!observedScoringCoverage.complete)
        throw Object.assign(new Error(`Initial source selection omitted ${observedScoringCoverage.missing.length} observed scoring incident(s). See source-goal-count-coverage.json and saved section observations; no incomplete scene lock was committed.`),{code:'SOURCE_SELECTION_CONFLICT'});
      if(!coverage.complete) job.warnings.push(`The initial video observations contain ${coverage.observed} scoring incidents; the filename suggests ${coverage.expected}. This discrepancy is recorded, not repaired by repeated discovery or invented goals.`);
    } else {
    // A previous pre-handoff failure may have left provisional lock flags.
    // Only the completed source manifest owns Step 2. Unlock this Step-1 pool
    // so source evidence and angle ranking can actually repair it on retry.
    candidates=candidates.map(scene=>({...scene,selectionLocked:false,sceneSelectionApproved:false}));
    // A retry from an old narrow inventory must run the same broad, budgeted
    // Step 1 as a new upload. Never apply this to an immutable Step-2 queue.
    if(geminiEnabled&&isCompleteHighlights(job.settings)
      && needsBroadExtraDiscovery(candidates,job.passageInventorySummary)
      &&!candidates.some(scene=>scene.sourceActionInventoryVersion===RECAP_ACTION_INVENTORY_VERSION)) {
      const extras=await discoverRecapExtraActions(job.sourceKey,media,id,candidates.filter(scene=>['goal','disallowed_goal'].includes(scene.eventType)),minimumPlannedDuration(job.settings));
      candidates=mergeAnalyzedMoments([...candidates,...extras]);
    }
    // Candidate timestamps from the whole-video observer are provisional. Do
    // not make them immutable until the original 16:9 pixels have confirmed
    // the complete action and its natural broadcast-shot boundaries.
    candidates = uniqueEvidenceCandidates(normalizeInventoryCandidateMetadata(candidates));
    if (isCompleteHighlights(job.settings)) {
      const requestedDuration = requestedRecapSeconds(job.settings.recapBrief);
      if (requestedDuration && requestedDuration > Number(job.settings.targetDuration || 0)) {
        job.settings = { ...job.settings, durationMode: "requested", targetDuration: requestedDuration };
        job.warnings.push(`Restored the original ${requestedDuration}-second recap request before continuing analysis.`);
      }
      job.settings = applyCompleteDurationBounds(job.settings, media.duration);
      if (job.settings.commentary) job.settings = { ...job.settings, originalAudio: "muted" };
    }
    await ensureShotBoundaries(job.sourceKey, id);
    const sourceShots = JSON.parse(await readFile(join(outputRoot, id, "shots.json"), "utf8")).shots;
    candidates = linkImmediateGoalReplays(candidates.map(moment => alignActionToShot(moment, sourceShots)));
    let sourceScoreLedger=null;
    if (geminiEnabled && isCompleteHighlights(job.settings)) {
      const scoreClient=createGeminiClient();
      sourceScoreLedger=await observeSourceScore({sourcePath:job.sourceKey,fingerprint:await sourceContentFingerprint(job.sourceKey),media,
        directory:join(outputRoot,id,'source-score'),model:geminiWorkloadModel('discovery'),ffmpeg:ffmpegPath,run,
        generate:(request,label)=>generateGeminiJson(scoreClient,request,label,3),
        onProgress:async progressDetail=>{const current=await readJob(id);await updateJob(current,'tracking',32,{progressDetail});}});
      await writeFile(join(outputRoot,id,'source-score-ledger.json'),JSON.stringify(sourceScoreLedger,null,2));
      // Reuse measured camera shots before buying another broad video scan.
      // They are observation proposals only: neutral source review below must
      // still establish setup, contact and payoff for every selected goal.
      candidates=[...candidates,...sourceScoreShotProposals(sourceScoreLedger.anchors,sourceShots,candidates)];
      candidates=linkImmediateGoalReplays(uniqueEvidenceCandidates(candidates).map(moment=>alignActionToShot(moment,sourceShots)));
    }
    let goalInventoryAnchor = [];
    // First verify scene identity and action boundaries against the uncropped
    // source. Portrait tracking cannot repair a clip that points at the wrong
    // incident, an incomplete goal, or an unrelated midfield passage.
    if (geminiEnabled) {
      candidates = selectClearIncidentAngles(candidates, sourceShots, sourceScoreLedger);
      job = await updateJob(job, "tracking", 32, {
        moments: candidates,
        progressDetail: "Validating provisional scenes in the original 16:9 footage before selection is locked.",
      });
      const initialSemanticResult = await verifyCandidateSemanticsWithGemini(job.sourceKey, candidates, id);
      candidates = await verifyIndependentGoalOutcomes(job.sourceKey, initialSemanticResult.candidates, id);
      candidates=reconcileSourceScoreCandidates(candidates,sourceScoreLedger);
      job=await updateJob(await readJob(id),'tracking',32,{moments:candidates});
      // An extra-action draft may span a source cut. If its first atomic view
      // is incomplete, inspect one already-discovered alternative in Step 1,
      // not a new whole-video scan or a Step-2 scene replacement.
      const extraAlternatives=selectClearIncidentAngles(candidates,sourceShots,sourceScoreLedger);
      // Persist the post-observation source ranking even when every scene's
      // review is already cached. Otherwise a corrected earlier miss can leave
      // the actual goal marked deferred until another discovery round.
      candidates=extraAlternatives;
      if(extraAlternatives.some(scene=>scene.sourceAdditionalAction===true && scene.sourceAngleSelected===true
        && needsSemanticReview(scene,process.env.GEMINI_MODEL))) {
        candidates=await verifyIndependentGoalOutcomes(job.sourceKey,
          (await verifyCandidateSemanticsWithGemini(job.sourceKey,extraAlternatives,id)).candidates,id);
        candidates=reconcileSourceScoreCandidates(candidates,sourceScoreLedger);
      }
      if(sourceScoreLedger?.anchors.length) {
        let coverage=sourceScoreCoverage(sourceScoreLedger,candidates);
        // Coarse discovery can point at a later replay. First observe actual
        // measured camera shots around the missing transition, scene by scene.
        // This is Step 1 only; an immutable portrait queue is never replaced.
        candidates=[...candidates,...sourceScoreShotProposals(
          sourceScoreLedger.anchors.filter(anchor=>coverage.missing.some(item=>item.id===anchor.id)),
          sourceShots,candidates)];
        for(let attempt=2;coverage.missing.length&&attempt<=8;attempt++) {
          const missingIds=new Set(coverage.missing.map(incident=>incident.id));
          let revised=selectClearIncidentAngles(candidates,sourceShots,sourceScoreLedger);
          const pending = revised.some(scene => missingIds.has(scene.sourceScoreAnchorId)
            && scene.sourceAngleSelected && needsSemanticReview(scene,process.env.GEMINI_MODEL));
          if (!pending) {
            const anchored=await discoverScoreAnchoredActions(job.sourceKey,media,id,
              sourceScoreLedger.anchors.filter(anchor=>missingIds.has(anchor.id)),attempt);
            revised=selectClearIncidentAngles(mergeAnalyzedMoments([...anchored,...candidates]),sourceShots,sourceScoreLedger);
          }
          candidates=await verifyIndependentGoalOutcomes(job.sourceKey,
            (await verifyCandidateSemanticsWithGemini(job.sourceKey,revised,id)).candidates,id);
          candidates=reconcileSourceScoreCandidates(candidates,sourceScoreLedger);
          candidates=selectClearIncidentAngles(candidates,sourceShots,sourceScoreLedger);
          coverage=sourceScoreCoverage(sourceScoreLedger,candidates);
          job=await updateJob(await readJob(id),'tracking',32,{moments:candidates,
            progressDetail:`Source action review: ${coverage.incidents.filter(item=>item.covered).length}/${coverage.incidents.length} score incidents verified. Completed scene observations are saved.`});
        }
        await writeFile(join(outputRoot,id,'source-score-coverage.json'),JSON.stringify(coverage,null,2));
        if(coverage.missing.length) throw new Error(`Step 1 source action coverage is unresolved for ${coverage.missing.map(item=>item.id).join(', ')}. Score context and source observations are saved; portrait tracking has not started.`);
      }
      const explicitGoalTotal = goalTotalFromFilename(job.sourceName);
      if (explicitGoalTotal != null && liveGoalStoryCount(candidates) >= explicitGoalTotal) {
        goalInventoryAnchor = candidates.filter(moment => moment.eventType === "goal"
          && moment.semanticVerified === true && moment.keepDecision !== "reject"
          && !moment.isReplay && moment.storyPhase !== "replay");
      }
      const rejectedPriorityScenes = candidates.filter(moment => moment.semanticVerified === false
        && ["goal", "disallowed_goal", "save", "shot_on_target", "shot_off_target", "big_chance", "celebration"].includes(moment.eventType));
      const rejectedGoalScenes = rejectedPriorityScenes.filter(moment => ["goal", "disallowed_goal"].includes(moment.eventType));
      const replayOnlyGoalStories = [...new Set(candidates
        .filter(moment => ["goal", "disallowed_goal"].includes(moment.eventType)
          && (moment.isReplay || moment.storyPhase === "replay")
          && moment.semanticVerified !== false)
        .map(moment => moment.storyId)
        .filter(storyId => storyId && !candidates.some(moment =>
          moment.storyId === storyId
          && ["goal", "disallowed_goal"].includes(moment.eventType)
          && !moment.isReplay && moment.storyPhase !== "replay"
          && moment.semanticVerified !== false)))];
      const reactionOnlyGoalStories = orphanGoalReactionStories(candidates);
      const suspiciousLateReplays = suspiciousLateGoalReplays(candidates);
      // Step 1 measures source evidence, not a portrait track that does not
      // exist yet. Stale lock/tracking flags from an older retry must not
      // turn complete source footage into zero pre-tracking capacity.
      const verifiedCapacity = sourceSelectionCapacity(candidates);
      const requiredCapacity = minimumPlannedDuration(job.settings);
      // Rejected optional candidates are normal during exhaustive observation.
      // They must not trigger another whole-source Gemini sweep when the first
      // pass already supplies enough verified footage and every goal story has
      // a live action. Recovery is reserved for an actual coverage deficiency.
      if ((!sourceScoreLedger?.anchors.length && (rejectedGoalScenes.length > 0 || replayOnlyGoalStories.length > 0
        || reactionOnlyGoalStories.length > 0 || suspiciousLateReplays.length > 0)
        )
        || verifiedCapacity < requiredCapacity) {
        const durationOnly=durationOnlyRecovery(sourceScoreLedger,candidates,explicitGoalTotal);
        const scenesToRecover = durationOnly ? [] : scenesNeedingCoverageRecovery(rejectedPriorityScenes, requiredCapacity - verifiedCapacity);
        const replayStoriesToRecover=durationOnly?[]:replayOnlyGoalStories;
        const reactionStoriesToRecover=durationOnly?[]:reactionOnlyGoalStories;
        const suspiciousReplaysToRecover=durationOnly?[]:suspiciousLateReplays;
        const recoveryRequests = [
          ...scenesToRecover.map(moment => `Reobserve ${moment.id} (provisional ${moment.eventType}) and find its complete live action, result, and matching reaction at exact source boundaries. Determine the actual outcome; a missed/saved shot must not become a goal to satisfy the provisional label.`),
          ...replayStoriesToRecover.map(storyId => {
            const replay = candidates.find(moment => moment.storyId === storyId
              && (moment.isReplay || moment.storyPhase === "replay"));
            return `Story ${storyId} currently has only replay ${replay?.id || "evidence"} near ${Number(replay?.startTime || 0).toFixed(1)}s. Search earlier nearby source footage for the distinct complete LIVE scoring action: buildup, decisive contact, ball flight, goalmouth result, then reaction. Do not relabel the replay as live.`;
          }),
          ...reactionStoriesToRecover.map(({ storyId, reactionId, startTime }) =>
            `Story ${storyId} currently has only verified post-goal reaction ${reactionId} near ${Number(startTime).toFixed(1)}s. Search the preceding ${GOAL_RECOVERY_LOOKBACK_SECONDS} source seconds for the distinct complete LIVE scoring action: initiating movement, decisive contact, ball flight, visible goalmouth result, then this reaction. Return that action as eventType goal with this exact storyId; do not use the reaction itself as goal proof.`),
          ...suspiciousReplaysToRecover.map(({ replayId, replayStart, liveGoalId, gap }) =>
            `Goal replay ${replayId} begins near ${Number(replayStart).toFixed(1)}s, ${Number(gap).toFixed(1)}s after linked live goal ${liveGoalId}. This may actually be proof of a later scoring incident. Search the preceding ${GOAL_RECOVERY_LOOKBACK_SECONDS} source seconds for a DISTINCT complete live goal, including contact, ball flight, visible goalmouth result, and the subsequent scoreboard transition. If visible, return that live action with a new storyId and keep this replay with that new incident. Do not invent a goal when the live action is absent.`),
        ];
        const recoveryWindows = [
          // A whole-video observer can attach a correct incident description to
          // a later replay or restart shot. Searching only twelve seconds back
          // repeatedly missed the live scoring action (and then validated the
          // wrong play). Keep the search local, but span the normal broadcast
          // replay/reaction cycle before the provisional boundary.
          // Retain the later decision too: an overturned finish may not be
          // resolved until after several replays and the referee's VAR review.
          ...scenesToRecover.map(moment => goalRecoveryWindow(moment.startTime, moment.endTime, media.duration,
            ["goal", "disallowed_goal"].includes(moment.eventType) ? 45 : 12)),
          ...replayStoriesToRecover.flatMap(storyId => candidates
            .filter(moment => moment.storyId === storyId && (moment.isReplay || moment.storyPhase === "replay"))
            .map(moment => goalRecoveryWindow(moment.startTime, moment.endTime, media.duration, 5))),
          ...reactionStoriesToRecover.map(({ startTime }) => goalRecoveryWindow(startTime, startTime, media.duration)),
          ...suspiciousReplaysToRecover.map(({ replayStart }) => goalRecoveryWindow(replayStart, replayStart, media.duration)),
        ];
        if (verifiedCapacity < requiredCapacity) {
          const uncovered = coverageRecoveryWindows(candidates, media.duration,
            {limit:durationRecoveryWindowLimit(requiredCapacity-verifiedCapacity),contextSeconds:2,
              minimumGap:4,searchedWindows:await completedDurationSearchWindows(id)});
          recoveryWindows.push(...uncovered);
          recoveryRequests.push(`The verified edit is ${Math.max(0, requiredCapacity - verifiedCapacity).toFixed(1)} seconds short. Inspect the uncovered source windows ${JSON.stringify(uncovered)} for distinct COMPLETE live shots, saves, big chances, or useful buildup that the first inventory missed. A defended attack may be useful; do not label every non-goal passage as filler. Do not invent action or repeat a selected interval.`);
        }
        job = await updateJob(job, "tracking", 33, {
          moments: candidates,
          progressDetail: durationOnly
            ? `All observed goals have complete source action. Finding one more complete chance in ${recoveryWindows.length} uncovered window(s) for the ${Math.max(0,requiredCapacity-verifiedCapacity).toFixed(1)}s shortfall.`
            : `Repairing ${scenesToRecover.length} rejected scene(s), ${replayStoriesToRecover.length} replay-only story/stories, ${reactionStoriesToRecover.length} reaction-only story/stories, and ${suspiciousReplaysToRecover.length} suspicious replay(s) before selection lock.`,
        });
        const recovered = await discoverAdditionalCandidatesWithGemini(
          job.sourceKey,
          media,
          job.settings.targetDuration,
          id,
          candidates,
          Math.max(0, requiredCapacity - verifiedCapacity),
          1,
          recoveryRequests,
          recoveryWindows,
          goalTotalFromFilename(job.sourceName),
          durationOnly ? 'action_duration' : 'incident_coverage',
        );
        candidates = selectClearIncidentAngles(linkImmediateGoalReplays(uniqueEvidenceCandidates(normalizeInventoryCandidateMetadata(recovered))
          .map(moment => alignActionToShot(moment, sourceShots))),sourceShots,sourceScoreLedger);
        const recoveredSemanticResult = await verifyCandidateSemanticsWithGemini(job.sourceKey, candidates, id);
        candidates = await verifyIndependentGoalOutcomes(job.sourceKey, recoveredSemanticResult.candidates, id);
        candidates=reconcileSourceScoreCandidates(candidates,sourceScoreLedger);
        candidates=selectClearIncidentAngles(candidates,sourceShots,sourceScoreLedger);
        if (goalInventoryAnchor.length) candidates = filterUnprovedRecoveryGoals(goalInventoryAnchor, candidates, explicitGoalTotal);
      }
    }
    candidates = linkImmediateGoalReplays(candidates).map(trimCompleteCameraView)
      .map(moment => moment.semanticVerified === true ? {...moment,semanticSignature:semanticSignature(moment)} : moment);
    if (geminiEnabled) {
      const synthesized = synthesizeMissingGoalReactions(candidates, media.duration);
      if (synthesized.additions.length > 0) {
        candidates = (await verifyCandidateSemanticsWithGemini(job.sourceKey, synthesized.candidates, id)).candidates;
      }
    }
    candidates = limitIncidentActionViews(candidates);
    // A readable scorebug for ONE goal is not whole-match coverage. Resolve
    // the filename count in Step 1 even when duration and partial OCR pass.
    // Completed negative searches rotate to fresh windows, not blind retries.
    if(geminiEnabled&&isCompleteHighlights(job.settings)) {
      const expected=goalTotalFromFilename(job.sourceName);
      const restored=await restoreCompletedGoalCountCandidates(id,job.sourceKey,media,candidates);
      if(restored.length) {
        candidates=selectClearIncidentAngles(mergeAnalyzedMoments([...candidates,...restored]),sourceShots,sourceScoreLedger);
        candidates=await verifyIndependentGoalOutcomes(job.sourceKey,
          (await verifyCandidateSemanticsWithGemini(job.sourceKey,candidates,id)).candidates,id);
        candidates=selectClearIncidentAngles(reconcileSourceScoreCandidates(candidates,sourceScoreLedger),sourceShots,sourceScoreLedger);
      }
      for(let pass=1;!sourceGoalCountCoverage(candidates,expected).complete;pass++) {
        const coverage=sourceGoalCountCoverage(candidates,expected);
        await writeFile(join(outputRoot,id,'source-goal-count-coverage.json'),JSON.stringify(coverage,null,2));
        if(coverage.excess) throw new Error(`Step 1 has ${coverage.observed} independently observed goal stories for an expected ${expected}; resolve duplicate incidents or source metadata before locking scenes.`);
        let scope='gaps';
        let windows=goalCountRecoveryWindows(candidates,sourceScoreLedger,media.duration,
          await completedRecoverySearchWindows(id,'goal_count',scope),4);
        if(!windows.length) {
          scope='source_shots';
          windows=unobservedSourceShotWindows(candidates,sourceShots,media.duration,
            await completedRecoverySearchWindows(id,'goal_count',scope),4);
        }
        if(!windows.length) throw new Error(`Step 1 exhausted fresh source windows after verifying ${coverage.observed}/${expected} goals. Saved source-goal-count-coverage.json needs source review; no incomplete scene lock was committed.`);
        job=await updateJob(await readJob(id),'tracking',32,{moments:candidates,sceneSelectionComplete:false,
          progressDetail:`Step 1: ${coverage.observed}/${expected} goals verified. Checking ${windows.length} fresh source windows for missing goal action; completed reviews are retained.`});
        const recovered=await discoverAdditionalCandidatesWithGemini(job.sourceKey,media,job.settings.targetDuration,id,
          candidates,0,pass,[`The upload name indicates ${expected} goals but ${coverage.observed} distinct complete live goals are independently observed. Locate missing live scoring actions in these windows. Do not return additional chances to fill a duration or invent goals to match the name; report only visible outcomes. Replays of known goals keep the same story identity.`],
          windows,expected,'goal_count',scope);
        // Review new/corrected proposals BEFORE overlap deduplication. A
        // shorter previously approved save might stop before a rebound goal.
        // The new source observation must resolve that, not an importance score.
        const priorIds=new Set(candidates.map(scene=>scene.id));
        const fresh=recovered.filter(scene=>!priorIds.has(scene.id));
        const reviewedFresh=fresh.length?await verifyIndependentGoalOutcomes(job.sourceKey,
          (await verifyCandidateSemanticsWithGemini(job.sourceKey,fresh,id)).candidates,id):[];
        candidates=selectClearIncidentAngles(linkImmediateGoalReplays(uniqueEvidenceCandidates(normalizeInventoryCandidateMetadata(
          mergeAnalyzedMoments([...candidates,...reviewedFresh])))
          .map(moment=>alignActionToShot(moment,sourceShots))),sourceShots,sourceScoreLedger);
        candidates=await verifyIndependentGoalOutcomes(job.sourceKey,
          (await verifyCandidateSemanticsWithGemini(job.sourceKey,candidates,id)).candidates,id);
        candidates=limitIncidentActionViews(selectClearIncidentAngles(reconcileSourceScoreCandidates(candidates,sourceScoreLedger),sourceShots,sourceScoreLedger));
      }
      await writeFile(join(outputRoot,id,'source-goal-count-coverage.json'),JSON.stringify(sourceGoalCountCoverage(candidates,expected),null,2));
    }
    // Brief immediate celebrations finish an independently verified goal's
    // story. Review their pixels before counting them; unrelated reactions and
    // VAR remain deferred. They were previously observed but never reviewed,
    // so a complete match recap lost its actual emotional payoff.
    if (geminiEnabled) {
      candidates = selectClearIncidentAngles(candidates,sourceShots,sourceScoreLedger);
      const goalReactions = candidates.filter(moment => moment.eventType === 'celebration'
        && !moment.sourceSupportDeferred)
        .map(moment => moment.id);
      if (goalReactions.length) candidates = (await verifyCandidateSemanticsWithGemini(
        job.sourceKey,candidates,id,goalReactions)).candidates;
    }
    // A planning estimate can exceed the minimum while the actual Step 1
    // selection falls short after duplicate-angle and reaction limits. Keep
    // discovery inside Step 1 instead of failing and making the user Resume.
    for (let recoveryPass = 2; ; recoveryPass += 1) {
      try {
        // Account for source-origin cleanup BEFORE measuring/locking duration.
        // Step 2 must not discover that its supposedly 60-second source pool
        // included dead pre-roll which it then has to remove.
        candidates=candidates.map(trimToVerifiedActionOrigin)
          .map(moment=>moment.semanticVerified===true?{...moment,semanticSignature:semanticSignature(moment)}:moment);
        candidates = selectRecapExtraActions(candidates, Number.MAX_SAFE_INTEGER, minimumPlannedDuration(job.settings));
        job=await updateJob(job,'tracking',33,{sourceSections:sectionSelectionSummary(
          uniqueEvidenceCandidates(candidates.filter(scene=>hasInitialSceneEvidence(scene,{requireSemanticVerification:geminiEnabled,minimumSeconds:MIN_SCENE_SECONDS}))),
          step1DiscoveryPlan(media.duration,minimumPlannedDuration(job.settings)))});
        candidates = chooseInitialScenesForLock(candidates, job.settings, {requireSemanticVerification:geminiEnabled,sourceDuration:media.duration});
        break;
      } catch (error) {
        if (!(error instanceof Step1CoverageError) || !geminiEnabled) throw error;
        const missingSeconds = error.minimum - error.selectedSeconds;
        // Duration recovery is a bounded discovery assist, not a second
        // selection loop. Once a fresh pass has failed to add distinct
        // complete action, keep the reviewed scenes and start tracking them.
        const boundedRecoveryExhausted = recoveryPass >= 3;
        let windows = coverageRecoveryWindows(candidates, media.duration, {
          limit:durationRecoveryWindowLimit(missingSeconds),contextSeconds:2,minimumGap:4,
          searchedWindows:await completedDurationSearchWindows(id) });
        let searchScope='gaps';
        if(!windows.length) {
          searchScope='source_shots';
          windows=unobservedSourceShotWindows(candidates,sourceShots,media.duration,
            await completedDurationSearchWindows(id,'source_shots'),4);
        }
        if (!windows.length || boundedRecoveryExhausted) {
          candidates = chooseInitialScenesForLock(candidates, job.settings, {
            requireSemanticVerification:geminiEnabled,
            sourceDuration:media.duration,
            allowCoverageShortfall:true,
          });
          const warning = `Step 1 found ${error.selectedSeconds.toFixed(1)} naturally paced seconds of distinct complete action after bounded discovery. Continuing with the reviewed scenes; no padding, duplicate replay, or artificial footage was added.`;
          job = await updateJob(await readJob(id), "tracking", 33, {
            moments:candidates,
            sourceSelectionProgress:{verifiedSeconds:error.selectedSeconds,minimumSeconds:error.minimum,shortfallAccepted:true,searchScope,pass:recoveryPass},
            progressDetail:warning,
            warnings:[...(job.warnings || []), warning],
          });
          break;
        }
        job = await updateJob(job, "tracking", 33, {
          moments: candidates,
          sourceSelectionProgress:{verifiedSeconds:error.selectedSeconds,minimumSeconds:error.minimum,searchScope,pass:recoveryPass},
          progressDetail: `Step 1 has ${error.selectedSeconds.toFixed(1)}/${error.minimum} verified seconds. Reviewing ${windows.length} ${searchScope==='source_shots'?'complete camera shot(s)':'source window(s)'} before scene lock (pass ${recoveryPass}).`,
        });
        const recovered = await discoverAdditionalCandidatesWithGemini(
          job.sourceKey, media, job.settings.targetDuration, id, candidates,
          missingSeconds, recoveryPass,
          [`Find distinct complete LIVE football action in these uncovered windows. The previous selected scenes total ${error.selectedSeconds.toFixed(1)} seconds; do not repeat an existing goal angle or pad with an unrelated reaction.`],
          windows,
          goalTotalFromFilename(job.sourceName),
          'action_duration',
          searchScope,
        );
        candidates = selectClearIncidentAngles(linkImmediateGoalReplays(uniqueEvidenceCandidates(normalizeInventoryCandidateMetadata(recovered))
          .map(moment => alignActionToShot(moment, sourceShots))), sourceShots, sourceScoreLedger);
        candidates = await verifyIndependentGoalOutcomes(job.sourceKey,
          (await verifyCandidateSemanticsWithGemini(job.sourceKey, candidates, id)).candidates, id);
        candidates=reconcileSourceScoreCandidates(candidates,sourceScoreLedger);
        candidates=selectClearIncidentAngles(candidates,sourceShots,sourceScoreLedger);
        if (goalInventoryAnchor.length) candidates = filterUnprovedRecoveryGoals(goalInventoryAnchor, candidates, goalTotalFromFilename(job.sourceName));
        candidates = limitIncidentActionViews(candidates);
      }
    }
    if(sourceScoreLedger?.anchors.length) {
      const finalCoverage=sourceScoreCoverage(sourceScoreLedger,candidates.filter(scene=>scene.sceneSelectionApproved));
      await writeFile(join(outputRoot,id,'source-score-coverage.json'),JSON.stringify(finalCoverage,null,2));
      if(finalCoverage.missing.length) throw new Error('Step 1 selection omitted a source-score incident; scenes have not been locked.');
    }
    const expectedGoalCount = goalTotalFromFilename(job.sourceName);
    const selectedGoalCoverage=sourceGoalCountCoverage(candidates.filter(scene=>scene.sceneSelectionApproved),expectedGoalCount);
    if(geminiEnabled && !selectedGoalCoverage.complete) {
      throw new Error(`Step 1 selection changed verified goal coverage: expected ${expectedGoalCount}, selected ${selectedGoalCoverage.observed}. Source selection is not locked; narration and tracking have not started.`);
    }
    }
    candidates = lockInitialSceneSelection(candidates, { requireSemanticVerification: geminiEnabled,
      fixedSelection: isCompleteHighlights(job.settings) });
    const scenePlan = candidates.filter(scene=>scene.selectionLocked===true)
      .sort((a,b)=>Number(a.startTime)-Number(b.startTime));
    const selectionSections=sectionSelectionSummary(scenePlan,job.passageInventorySummary?.sectionPlan
      || step1DiscoveryPlan(media.duration,minimumPlannedDuration(job.settings)));
    job=await updateJob(job,'tracking',33,{sourceSections:selectionSections,moments:candidates});
    await writeFile(join(outputRoot,id,'step1-recap-plan.json'),JSON.stringify({
      version:2,minimumSeconds:minimumPlannedDuration(job.settings),
      observationPolicy:initialSectionWorkflow?'one_initial_video_response_per_section':'legacy_source_review',
      verifiedSourceSeconds:renderableEvidenceCapacity(scenePlan,.08,{maximumReactionSeconds:7}),
      order:'chronological_source_incidents',playbackRate:1,
      stage:'source_split',combined:false,
      scenePolicy:'one_separate_original_ratio_clip_per_selected_action',
      combinePolicy:'after_tracking_effects_transitions_captions_narration',
      sections:selectionSections,
      scenes:scenePlan.map(scene=>({id:scene.id,storyId:scene.storyId,eventType:scene.eventType,
        startTime:scene.startTime,endTime:scene.endTime})),
      narrationPolicy:'basic_english_natural_pacing_after_visual_lock',
    },null,2));
    await writeFile(join(outputRoot, id, "step1-scene-manifest.json"), JSON.stringify({
      version: 1,
      candidates,
      savedAt: new Date().toISOString(),
    }, null, 2));
    // Preserve the verified whole-source inventory. For the fixed workflow,
    // every source-angle decision is finished here, before any 9:16 tracking.
    await writeFile(join(outputRoot, id, "incidents-observed.json"), JSON.stringify(incidentManifest(candidates), null, 2));
    observedIncidentCandidates = candidates.map(moment => ({ ...moment }));
    } else {
      observedIncidentCandidates = candidates.map(moment => ({ ...moment }));
    }
    candidates = candidates.map(normalizeDecisionSceneEvidence);
    observedIncidentCandidates = observedIncidentCandidates.map(normalizeDecisionSceneEvidence);
    const observedIncidentIds = new Set(observedIncidentCandidates.map(moment => moment.id));
    const incidentRequirementCandidates = (current) => {
      // The discovery ledger is intentionally retained for diagnostics, but
      // it can contain unselected alternate angles and stale Gemini
      // candidates. After Step 1 and angle selection, only the live `current`
      // set represents scenes that are allowed to block rendering. Reusing
      // the whole ledger here caused valid 9:16 jobs to fail on discarded
      // goal/disallowed-goal alternatives.
      return current.filter(moment =>
        moment.selectionLocked === true
        || moment.sceneSelectionApproved === true
        || moment.selectedForFinalVideo === true
      );
    };
    // Verify the actual outcome before the camera is computed, not afterwards.
    // Semantic verification may refine action origin after the initial shot
    // split. Trim stale player-only/empty-field pre-roll before any 9:16 work.
    if (!isCompleteHighlights(job.settings)) candidates = candidates.map(trimToVerifiedActionOrigin);
    const sceneQueue = isCompleteHighlights(job.settings) ? fixedSceneQueue(candidates) : null;
    if (sceneQueue) await writeFile(join(outputRoot,id,'fixed-scene-queue.json'),JSON.stringify(sceneQueue,null,2));
    if(sceneQueue) job=await updateJob(job,'tracking',34,{moments:candidates,sceneSelectionComplete:true,
      progressDetail:`Selected ${sceneQueue.scenes.length} complete source scenes. Saving each separately before tracking.`});
    if(sceneQueue) candidates=await prepareSplitSceneAssets({sourcePath:job.sourceKey,
      fingerprint:await sourceContentFingerprint(job.sourceKey),candidates,media,
      directory:join(outputRoot,id,'source-scenes'),ffmpeg:ffmpegPath,run,probe,
      report:async progressDetail=>updateJob(await readJob(id),'tracking',34,{progressDetail}),
      onScenePrepared:async scene=>{
        const current=await readJob(id);
        await updateJob(current,'tracking',34,{moments:current.moments.map(moment=>moment.id===scene.id?scene:moment)});
      }});
    job = await updateJob(await readJob(id), "tracking", 34, {moments:candidates,clearAngleWorkflowVersion:CLEAR_ANGLE_WORKFLOW_VERSION});
    let prepared = await prepareIncidentEvidence(job.sourceKey, candidates, media, id);
    candidates = linkImmediateGoalReplays(prepared.candidates);
    let tracking = prepared.tracking;
    const firstTrackedCapacity = planningEvidenceCapacity(candidates, job.settings);
    const requiredBeforePlanning = minimumPlannedDuration(job.settings);
    if (!sceneQueue && firstTrackedCapacity + 0.01 < requiredBeforePlanning
      && candidates.some(moment => moment.selectionLocked !== true && moment.semanticVerified === true && moment.keepDecision !== "reject")) {
      job = await updateJob(job, "tracking", 36, {
        moments: candidates,
        observedMoments: candidates,
        progressDetail: `Verified primary scenes provide ${firstTrackedCapacity.toFixed(1)} seconds. Promoting the already-discovered reserve pool without restarting Gemini discovery.`,
      });
      candidates = promoteRemainingScenesForLock(candidates);
      prepared = await prepareIncidentEvidence(job.sourceKey, candidates, media, id, {
        skipVisualRejectedIds: new Set(candidates.filter(scene=>scene.trackingRepairError).map(scene=>scene.id)),
      });
      candidates = linkImmediateGoalReplays(prepared.candidates);
      tracking = prepared.tracking;
    }
    // Legacy workflows may compare tracked alternatives. The fixed workflow
    // instead verifies every scene in its saved queue without source swaps.
    const nativeLandscape = job.settings.aspectRatio === "16:9";
    const incidentAngleQuality = new Map(candidates.map(moment => [
      String(moment.id),
      trackingEvidenceQuality(moment, matchingTrackingEvidence(tracking, moment), nativeLandscape),
    ]));
    const incidentAngleUsable = new Map(candidates.map(moment => [
      String(moment.id),
      (nativeLandscape
        ? assessNativeFrameAction(moment, matchingTrackingEvidence(tracking, moment))
      : assessPlannedSceneTracking(moment, matchingTrackingEvidence(tracking, moment))).usable === true,
    ]));
    if (nativeLandscape && !sceneQueue) {
      candidates = recoverNativeFullFrameIncidents(candidates, incidentAngleQuality, incidentAngleUsable);
    }
    const unverifiedLockedGoals=candidates.filter(moment=>moment.selectionLocked===true && moment.eventType==="goal"
      && !candidates.some(other=>other.selectionLocked===true && other.eventType==="goal"
        && String(other.storyId||other.id)===String(moment.storyId||moment.id)
        && incidentAngleUsable.get(String(other.id))===true));
    if(unverifiedLockedGoals.length) {
      // Do not let angle comparison erase a required incident and then write
      // an incomplete recap. Preserve its scene lock for framing repair.
      job=await updateJob(await readJob(id),"tracking",38,{moments:candidates,observedMoments:candidates,
        resumeTrackingOnly:true,progressDetail:"Repairing the selected goal crops before script writing."});
      throw new Error(`Locked goal framing still needs repair: ${unverifiedLockedGoals.map(moment=>
        `${moment.id} (${assessPlannedSceneTracking(moment,matchingTrackingEvidence(tracking,moment)).issues?.join(", ")||moment.trackingDecision||"unverified crop"})`).join("; ")}. Selected incidents remain saved; narration has not started.`);
    }
    if (sceneQueue) {
      const queueReview = assertFixedSceneQueue(sceneQueue, candidates);
      await writeFile(join(outputRoot,id,'scene-queue-review.json'),JSON.stringify(queueReview,null,2));
      assertFixedSceneQueue(sceneQueue, candidates, { requirePassed: true });
    }
    candidates = chooseTrackedIncidentAngles(candidates, incidentAngleQuality, incidentAngleUsable);
    if (sceneQueue) assertFixedSceneQueue(sceneQueue, candidates, { requirePassed: true });
    await writeFile(join(outputRoot, id, "incident-angle-selection.json"), JSON.stringify({
      version: 1,
      selected: candidates.filter(moment => moment.chosenIncidentAngle === true).map(moment => ({
        id: moment.id,
        storyId: moment.storyId,
        isReplay: Boolean(moment.isReplay || moment.storyPhase === "replay"),
        trackingQuality: incidentAngleQuality.get(String(moment.id)),
        trackingPassed: incidentAngleUsable.get(String(moment.id)) === true,
      })),
      rejectedAlternatives: candidates.filter(moment => ["removed_after_incident_angle_comparison", "incident_has_no_verified_angle"]
        .includes(moment.selectionDecision))
        .map(moment => ({ id: moment.id, storyId: moment.storyId,
          trackingQuality: incidentAngleQuality.get(String(moment.id)),
          trackingPassed: incidentAngleUsable.get(String(moment.id)) === true,
          reason: moment.rejectReason })),
    }, null, 2));
    // All post-track capacity calculations, script writing and alignment see
    // only the winning action angle plus the already-approved support scenes.
    candidates = candidates.filter(moment => moment.selectionLocked === true);
    job = await readJob(id);
    let verifiedEvidenceDuration = availableVerifiedEvidenceDuration(candidates);
    let editableDuration = planningEvidenceCapacity(candidates, job.settings);
    let requiredPlannedDuration = minimumPlannedDuration(job.settings);
    let highlightDeficiencies = highlightStoryDeficiencies(candidates);
    // Step 2 is deliberately one-way. Tracking and keyframe repair operate only
    // on the immutable Step 1 scene manifest. No Gemini discovery, candidate
    // replacement, companion synthesis, or duration-driven reselection is
    // allowed after portrait work begins.
    if (isViralReel(job.settings)) {
      await finishViralReelJob(job, candidates, media, overlayMasks, tracking, id);
      return;
    }
    const incidentReport = incidentCoverage(incidentRequirementCandidates(candidates), candidates.filter(m=>m.keepDecision !== "reject").map(m=>({...m,selectedForFinalVideo:true})));
    await writeFile(join(outputRoot, id, "incident-coverage.json"), JSON.stringify(incidentReport, null, 2));
    job = await updateJob(job, "tracking", 38, {incidentCoverage:incidentReport,moments:candidates,observedMoments:candidates});
    if (editableDuration < requiredPlannedDuration) {
      const report = evidenceReport(candidates, editableDuration, requiredPlannedDuration);
      await writeFile(join(outputRoot, id, "evidence-report.json"), JSON.stringify(report, null, 2));
      await writeFile(join(outputRoot, id, "incidents-verified.json"), JSON.stringify(incidentManifest(candidates), null, 2));
      job = await updateJob(job, "tracking", 38, { moments: candidates, observedMoments: candidates, evidenceReport: report, trackingSummary: tracking.summary });
      const missingGoalEvidence = incidentReport.missing.some(incident => incident.eventTypes.includes("goal"));
      if (isCompleteHighlights(job.settings) && !missingGoalEvidence && editableDuration > 0) {
        // Step 1 already owns the complete source decision. Do not send the
        // user back to discovery just because conservative caps leave a few
        // seconds below the preferred floor. Continue with unique reviewed
        // footage and lower the natural floor to what can really be rendered.
        const naturalFloor = Number(editableDuration.toFixed(1));
        const warning = `The reviewed source contains ${naturalFloor.toFixed(1)} naturally paced seconds after tracking. Continuing without padding or duplicate replay; the recap floor was adjusted to the available evidence.`;
        job.settings = { ...job.settings, targetDuration: Math.min(Number(job.settings.targetDuration || naturalFloor), naturalFloor), durationMin: naturalFloor };
        job.warnings = [...(job.warnings || []), warning];
        requiredPlannedDuration = naturalFloor;
      } else {
        throw new Error(`The current verified edit plan supports ${editableDuration.toFixed(1)} of the required ${requiredPlannedDuration} seconds. ${report.repairable.length} scene(s) need tracking or framing repair. This is a verification shortfall, not proof that the source lacks good action. See the saved scene-level evidence report.`);
      }
    }
    job = await updateJob(job, "tracking", 38, { moments: candidates, observedMoments: candidates });
    const missingGoals = incidentReport.missing.filter(incident => incident.eventTypes.includes("goal"));
    if (missingGoals.length) throw new Error(`Complete-match verification still needs ${missingGoals.length} goal(s). Their action is visible in the source but tracking has not passed. See incident-coverage.json; these goals will not be silently omitted.`);
    const unprovedDecisions = incidentReport.missing.filter(incident => !incident.eventTypes.includes("goal"));
    if (unprovedDecisions.length) job.warnings.push(`${unprovedDecisions.length} decision incident(s) could not be verified in a playable angle and will not be narrated or shown as confirmed.`);
    await writeFile(join(outputRoot, id, "incidents-verified.json"), JSON.stringify(incidentManifest(candidates), null, 2));
    if (job.settings.durationMode !== "auto" && verifiedEvidenceDuration < requiredPlannedDuration) {
      job.warnings.push(`The unique verified footage provides ${verifiedEvidenceDuration.toFixed(1)} seconds. The target-aware plan will use only unique verified source intervals, including genuine alternate camera angles when present; synthetic replay duplication is forbidden.`);
    }
    if (highlightDeficiencies.length) {
      job.warnings.push(`Goal-first discovery could not verify every preferred companion angle: ${highlightDeficiencies.join(", ")}. Gemini must use only the complete goal/shot evidence that passed local tracking.`);
    }
    // Do not spend grounded-search/narration calls while known crop repairs
    // still prevent a complete visual story. Identity work follows the gates.
    let matchContext = job.matchContext || { identityResearchVersion: 5, status: "unverified", confidence: 0, reason: "not_researched", sources: [] };
    if (isCompleteHighlights(job.settings) && geminiEnabled
      && Number(job.matchContext?.identityResearchVersion || 0) < 5) {
      job = await updateJob(job, "tracking", 39, { progressDetail: "Researching the exact fixture and scorers after visual coverage passed." });
      try {
        matchContext = await researchMatchContextWithGemini(job.sourceName, job.settings.recapBrief, candidates);
        if (matchContext.status !== "verified") {
          job.warnings.push("Match identity could not be corroborated by two sources and the verified goal count, so narration uses neutral player roles.");
        }
      } catch (error) {
        matchContext = { identityResearchVersion: 5, status: "unverified", confidence: 0, reason: "grounded_research_failed", sources: [] };
        job.warnings.push(`Grounded match research was unavailable; narration uses neutral player roles: ${sanitizeProviderError(String(error?.message || error))}`);
      }
      await writeFile(join(outputRoot, id, "match-context.json"), JSON.stringify(matchContext, null, 2));
      job.matchContext = matchContext;
    }
    let automaticStory;
    if (isCompleteHighlights(job.settings) && job.settings.durationMode !== "auto") {
      const requestedGuide = Number(job.settings.targetDuration || 120);
      const evidenceFittedTarget = clamp(
        Math.min(requestedGuide, editableDuration),
        Number(job.settings.durationMin ?? COMPLETE_RECAP_MINIMUM_SECONDS),
        Number(job.settings.durationMax || Infinity),
      );
      if (evidenceFittedTarget + 0.1 < requestedGuide) {
        job.warnings.push("Adjusted the preferred narration target from " + requestedGuide.toFixed(1) + " to " + evidenceFittedTarget.toFixed(1) + " seconds so the script fits unique verified football evidence. The " + Number(job.settings.durationMin ?? COMPLETE_RECAP_MINIMUM_SECONDS) + "-second delivery minimum remains enforced.");
      }
      job.settings = { ...job.settings, targetDuration: evidenceFittedTarget };
      requiredPlannedDuration = Number(job.settings.durationMin ?? COMPLETE_RECAP_MINIMUM_SECONDS);
    }
    if (job.settings.durationMode === "auto") {
      candidates = shortReactionCandidates(candidates, isCompleteHighlights(job.settings) ? 7 : 3);
      const automaticMinimum = minimumPlannedDuration(job.settings);
      const automaticMaximum = Number(job.settings.durationMax || Infinity);
      const automaticTarget = clamp(Math.min(editableDuration, automaticMaximum), automaticMinimum, automaticMaximum);
      automaticStory = {
        candidates,
        targetDuration: automaticTarget,
        rationale: "Deterministic duration chosen from unique locally verified football evidence.",
      };
      job.settings = { ...job.settings, targetDuration: automaticStory.targetDuration };
      verifiedEvidenceDuration = availableVerifiedEvidenceDuration(candidates);
      editableDuration = planningEvidenceCapacity(candidates, job.settings);
    }
    job = await updateJob(job, isCompleteHighlights(job.settings) ? "aligning_content" : "writing_content", 40, {
      moments: candidates,
      trackingSummary: tracking.summary,
      progressDetail: isCompleteHighlights(job.settings)
        ? "Locking the exact visual timeline and duration before Gemini writes the final recap script."
        : "Writing analysis against the verified football evidence.",
      editPlan: {
        requestedDuration: job.settings.durationMode === "auto" ? null : job.settings.targetDuration,
        aiSelectedDuration: automaticStory?.targetDuration,
        durationRationale: automaticStory?.rationale,
        minimumDuration: isCompleteHighlights(job.settings)
          ? job.settings.durationMin : (job.settings.durationMode === "auto" ? 0 : undefined),
        verifiedEvidenceDuration,
        editableEvidenceDuration: editableDuration,
        planningMode: job.settings.durationMode === "auto" ? "ai_selected_complete_story" : "target_aware_verified_editorial_expansion",
        matchContext,
      },
    });
    const scriptCandidates = sceneQueue ? candidates.filter(moment=>moment.selectionLocked)
      : selectDirectorCandidates(candidates).filter(narratableEvidence);
    if (!scriptCandidates.some(narratableEvidence)) {
      const repairScenes = candidates.filter(moment => moment.selectionLocked === true
        && moment.eventType !== "celebration" && moment.storyPhase !== "reaction");
      const report = {
        reason: "no_verified_narratable_action", sourceDuration: media.duration,
        usableReactionSeconds: editableDuration,
        repairScenes: repairScenes.map(moment => ({ id: moment.id, reason: moment.trackingDecision })),
      };
      await writeFile(join(outputRoot, id, "narration-readiness.json"), JSON.stringify(report, null, 2));
      job = await updateJob(job, "tracking", 38, { moments: candidates, observedMoments: candidates,
        narrationReadiness: report, resumeFromCandidates: true, resumeTrackingOnly: true });
      throw new Error("The selected action scenes still need player-and-ball tracking repair. Narration has not started; celebration-only footage cannot support a recap. The locked scenes are saved for tracking retry.");
    }
    const verifiedDirectorSlots = scriptCandidates.length;
    const verifiedGoalActionCount = verifiedLiveGoalActions(scriptCandidates).length;
    let contentPlan;
    if (isCompleteHighlights(job.settings)) {
      // The complete-recap script is final production copy, not an input to
      // scene selection. Use a local evidence outline to lock trims, order,
      // transitions and duration first; Gemini writes only after that visual
      // timeline is immutable.
      contentPlan = buildLockedVisualOutline(scriptCandidates, job.settings, matchContext);
    } else if (geminiEnabled) {
      try {
        contentPlan = await writeAnalysisContentWithGemini(scriptCandidates, media, job.settings, verifiedEvidenceDuration, editableDuration, verifiedDirectorSlots, verifiedGoalActionCount, matchContext);
      } catch (error) {
        job.warnings.push("Gemini recap-script validation did not complete; a conservative evidence-based script was used: " + sanitizeProviderError(String(error?.message || error)));
        contentPlan = buildDeterministicContentPlan(scriptCandidates, job.settings);
      }
    } else {
      contentPlan = buildDeterministicContentPlan(scriptCandidates, job.settings);
    }
    const originalBeatCount = contentPlan.contentBeats.length;
    if (!isCompleteHighlights(job.settings)) {
      contentPlan = fitContentPlanToEvidenceSlots(contentPlan, verifiedDirectorSlots, job.settings.targetDuration);
    }
    contentPlan = sanitizeUnverifiedContentPlan(contentPlan, matchContext, job.settings);
    let masterTtsFiles = new Map();
    if (contentPlan.contentBeats.length < originalBeatCount) {
      job.warnings.push(
        `Consolidated ${originalBeatCount - contentPlan.contentBeats.length} adjacent analysis beat(s) so every narration beat has its own verified scene.`,
      );
    }
    job = await updateJob(job, "aligning_content", 48, {
      editPlan: {
        ...job.editPlan,
        title: contentPlan.title,
        editorialThesis: contentPlan.editorialThesis,
        contentAngle: contentPlan.contentAngle,
        storyQuestion: contentPlan.storyQuestion,
        storyAnswer: contentPlan.storyAnswer,
        contentBeats: contentPlan.contentBeats,
        contentScript: contentPlan.contentScript,
        wordCount: contentPlan.wordCount,
        candidateCount: candidates.filter((moment) => moment.keepDecision !== "reject").length,
      },
    });
    editPlan = await alignContentReliably(contentPlan, candidates, job.settings, verifiedEvidenceDuration, editableDuration);
    let planned = applyEditPlan(candidates, editPlan, planningCeiling(job.settings), job.settings);
    planned = restoreContentBeatOrder(planned, contentPlan.contentBeats);
    let selected = applyCompleteHighlightTreatment(applyTrackingQuality(planned, tracking, job.settings), job.settings);
    let selectedDuration = selectedTimelineDuration(selected);
    for (let repairPass = 0; !sceneQueue && selectedDuration < requiredPlannedDuration && repairPass < planned.length; repairPass += 1) {
      const repaired = applyCompleteHighlightTreatment(repairPlanWithTrackedBackups(planned, selected, tracking, requiredPlannedDuration, job.settings.intensity, job.settings), job.settings);
      selected = restoreContentBeatOrder(repaired, contentPlan.contentBeats);
      const repairedDuration = selectedTimelineDuration(selected);
      if (repairedDuration <= selectedDuration + 0.01) break;
      selectedDuration = repairedDuration;
    }
    if (!sceneQueue && job.settings.durationMode !== "auto") {
      selected = expandVerifiedTimeline(selected, job.settings.targetDuration);
      selected = fitSelectedTimelineToCeiling(
        selected,
        isCompleteHighlights(job.settings) ? planningCeiling(job.settings) : job.settings.targetDuration,
        isCompleteHighlights(job.settings) ? 0 : 3,
      );
    }
    selected = sanitizeUnverifiedMoments(selected, matchContext);
    if (sceneQueue) assertFixedSceneQueue(sceneQueue, selected.filter(scene=>scene.selectedForFinalVideo), { requirePassed: true });
    let lockedNarrationCandidates = selected
      .filter((moment) => moment.selectedForFinalVideo)
      .filter(moment=>sceneQueue || narratableEvidence(moment));
    let lockedBindingProblems = contentEvidenceBindingProblems(contentPlan.contentBeats, lockedNarrationCandidates);
    const visualIdentityBindings = bindVerifiedIdentitiesToIncidents(matchContext, lockedNarrationCandidates);
    let visualReviewManifest = buildVisualReviewManifest(selected, tracking.summary, matchContext, visualIdentityBindings, tracking);
    let completedVisual = null;
    if (isCompleteHighlights(job.settings) && job.settings.commentary) {
      job = await updateJob(job, 'editing', 44, { narrationProductionVersion: 1,
        completedVisualReady: false, narrationRecorded: false, narrationScriptApproved: false, renderCompleted: false, progressDetail:
        'Finishing the complete muted visual edit before Gemini watches it and writes the recap.' });
      completedVisual = await prepareCompletedVisualNarration(job, selected, media, overlayMasks, tracking, matchContext, visualReviewManifest);
      visualReviewManifest = completedVisual.manifest;
      selectedDuration = visualReviewManifest.selectedDuration;
    }
    await writeFile(join(outputRoot, id, "locked-visual-timeline.json"), JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      selectedDuration,
      matchContext,
      trackingSummary: tracking.summary,
      visualReviewManifest,
      moments: selected,
    }, null, 2));
    if (isCompleteHighlights(job.settings) || lockedBindingProblems.length) {
      if (!geminiEnabled) {
        throw new Error(`The locked visual timeline requires an exact narration rewrite: ${lockedBindingProblems.join(", ")}.`);
      }
      job = await updateJob(job, "writing_content", 46, {
        visualEditLocked:true,
        completedVisualReady:Boolean(completedVisual),
        progressDetail: "The visual edit is locked. Writing every narration beat against the exact scenes and final duration before voice recording.",
      });
      const lockedEvidenceDuration = availableVerifiedEvidenceDuration(lockedNarrationCandidates);
      const lockedEditableDuration = planningEvidenceCapacity(lockedNarrationCandidates, job.settings);
      const lockedGoalCount = verifiedLiveGoalActions(lockedNarrationCandidates).length;
      const narrationSettings = isCompleteHighlights(job.settings)
        ? { ...job.settings, durationMode: "requested", targetDuration: selectedDuration }
        : job.settings;
      contentPlan = await writeAnalysisContentWithGemini(
        lockedNarrationCandidates,
        media,
        narrationSettings,
        lockedEvidenceDuration,
        lockedEditableDuration,
        lockedNarrationCandidates.length,
        lockedGoalCount,
        matchContext,
        visualReviewManifest,
        null,
        id,
        completedVisual?.videoPart || null,
      );
      contentPlan = fitContentPlanToEvidenceSlots(contentPlan, lockedNarrationCandidates.length, selectedDuration);
      contentPlan = sanitizeUnverifiedContentPlan(contentPlan, matchContext, job.settings);
      lockedBindingProblems = contentEvidenceBindingProblems(contentPlan.contentBeats, lockedNarrationCandidates);
      if (lockedBindingProblems.length) {
        throw new Error(`The locked visual timeline still has ungrounded narration: ${lockedBindingProblems.join(", ")}.`);
      }
    }
    // Scene selection is already locked. Tracking may repair presentation but
    // must not erase the approved script-to-scene metadata. Rebind every beat
    // after tracking and duration fitting, then restore chronological beat
    // order before validating or recording the continuous narration.
    selected = applyNarrationToLockedVisualTimeline(selected, contentPlan);
    selected = restoreContentBeatOrder(selected, contentPlan.contentBeats);
    selectedDuration = selectedTimelineDuration(selected);
    if (completedVisual) selectedDuration = completedVisual.manifest.selectedDuration;
    let frameable = selected.filter((moment) => moment.selectedForFinalVideo);
    const selectedBeatCount = new Set(
      frameable.filter((moment) => moment.commentary).map((moment) => String(moment.beatId || "")),
    ).size;
    const sequenceProblems = highlightSequenceProblems(frameable, { availableMoments: candidates, requireAvailableCompanionsOnly: isCompleteHighlights(job.settings) });
    const blockingSequenceProblems = isCompleteHighlights(job.settings) ? [] : sequenceProblems;
    if (sequenceProblems.length && isCompleteHighlights(job.settings)) {
      job.warnings.push(`Complete verified goal actions were preserved without optional companion footage: ${sequenceProblems.join(", ")}.`);
    }
    const finalRequirements = incidentRequirementCandidates(candidates).filter(moment =>
      !unprovedDecisions.some(incident => incident.id === String(moment.storyId || moment.id)));
    const coverage = assertIncidentCoverage(finalRequirements, frameable);
    await writeFile(join(outputRoot, id, "alignment-review.json"), JSON.stringify({
      contentPlan, alignment: editPlan, moments: selected, sequenceProblems, selectedDuration, coverage,
    }, null, 2));
    const deliveryFailures = [];
    if (frameable.length < 1) deliveryFailures.push("no_selected_action_scenes");
    if (uniqueEvidenceCandidates(frameable).length !== frameable.length) deliveryFailures.push("duplicate_source_intervals");
    if (selectedDuration < requiredPlannedDuration) deliveryFailures.push(`duration_short_${selectedDuration.toFixed(1)}s`);
    if (selectedDuration > planningCeiling(job.settings) + 3) deliveryFailures.push(`duration_long_${selectedDuration.toFixed(1)}s`);
    if (selectedBeatCount < contentPlan.contentBeats.length) deliveryFailures.push(`missing_narration_beats_${selectedBeatCount}_of_${contentPlan.contentBeats.length}`);
    deliveryFailures.push(...blockingSequenceProblems);
    if (deliveryFailures.length) throw new Error(`The verified evidence plan cannot render: ${deliveryFailures.join(", ")}.`);
    if (job.settings.commentary) {
      job = await updateJob(job, "generating_commentary", 64, {
        moments: selected,
        progressDetail: "The visual edit is locked. Recording narration as the final production stage.",
        editPlan: { ...job.editPlan, title: contentPlan.title, contentScript: contentPlan.contentScript, narrationScript: contentPlan.contentScript },
      });
      if (completedVisual) {
        const timed = await makeCompletedTimelineSpeech(contentPlan, completedVisual.manifest, id, matchContext, lockedNarrationCandidates);
        masterTtsFiles = timed.files;
        contentPlan = timed.content;
        selected = applyNarrationToLockedVisualTimeline(selected, contentPlan);
      } else for (let narrationAttempt = 0; narrationAttempt < 3; narrationAttempt += 1) {
        masterTtsFiles = await makeContinuousSpeech(contentPlan.contentScript, id);
        const measuredDuration = Number(masterTtsFiles.narrationDuration || 0);
        const timingRatio = measuredDuration / Math.max(1, selectedDuration);
        if (timingRatio >= 0.94 && timingRatio <= 1.10) break;
        if (narrationAttempt === 2) break;
        // Rewrite against the actual locked visual duration. Deriving this
        // from the earlier estimated target produced a short script and later
        // slowed the recorded voice by 15-25%, creating a bored delivery.
        const correctionTarget = selectedDuration;
        job = await updateJob(job, "writing_content", 64, {
          progressDetail: "The recorded voice does not fit the locked visual timeline. Rewriting narration without changing any scene.",
        });
        const timingSettings = { ...job.settings, durationMode: "requested", targetDuration: correctionTarget };
        lockedNarrationCandidates = selected
          .filter((moment) => moment.selectedForFinalVideo)
          .filter(moment=>sceneQueue || narratableEvidence(moment));
        const lockedEvidenceDuration = availableVerifiedEvidenceDuration(lockedNarrationCandidates);
        const lockedEditableDuration = planningEvidenceCapacity(lockedNarrationCandidates, timingSettings);
        const lockedGoalCount = verifiedLiveGoalActions(lockedNarrationCandidates).length;
        const narrationTiming={narration:masterTtsFiles.narrationScript||contentPlan.contentScript,duration:measuredDuration};
        await writeFile(join(outputRoot,id,'speech','timing-feedback.json'),JSON.stringify({
          visualDuration:selectedDuration,measuredDuration,wordBudget:narrationWordBudget(selectedDuration,'requested',isCompleteHighlights(job.settings),narrationTiming)
        },null,2));
        contentPlan = await writeAnalysisContentWithGemini(lockedNarrationCandidates, media, timingSettings, lockedEvidenceDuration, lockedEditableDuration, lockedNarrationCandidates.length, lockedGoalCount, matchContext, visualReviewManifest,narrationTiming,id);
        contentPlan = sanitizeUnverifiedContentPlan(contentPlan, matchContext, job.settings);
        const timingBindingProblems = contentEvidenceBindingProblems(contentPlan.contentBeats, lockedNarrationCandidates);
        if (timingBindingProblems.length) {
          throw new Error(`The timing rewrite produced ungrounded narration: ${timingBindingProblems.join(", ")}.`);
        }
        selected = applyNarrationToLockedVisualTimeline(selected, contentPlan);
      }
      if (!(Number(masterTtsFiles.narrationDuration || 0) > 0)) {
        throw new Error("Google Cloud TTS produced no narration recording.");
      }
      if (!completedVisual) masterTtsFiles = await fitContinuousNarrationToLockedTimeline(masterTtsFiles, selectedDuration, id);
      contentPlan.narrationDuration = masterTtsFiles.narrationDuration;
      selected = applyNarrationToLockedVisualTimeline(selected, contentPlan);
      frameable = selected.filter((moment) => moment.selectedForFinalVideo);
    }
    job = await updateJob(job, "aligning_content", 56, {
      moments: selected,
      trackingSummary: tracking.summary,
      editPlan: {
        ...job.editPlan,
        title: contentPlan.title,
        editorialThesis: contentPlan.editorialThesis,
        contentAngle: contentPlan.contentAngle,
        storyQuestion: contentPlan.storyQuestion,
        storyAnswer: contentPlan.storyAnswer,
        contentBeats: contentPlan.contentBeats,
        contentScript: contentPlan.contentScript,
        wordCount: contentPlan.wordCount,
        rationale: editPlan.rationale || "",
        selectedCount: frameable.length,
        plannedDuration: selectedDuration,
        verifiedEvidenceDuration,
        editableEvidenceDuration: editableDuration,
        narrationScript: contentPlan.contentScript,
        narrationDuration: masterTtsFiles.narrationDuration,
      },
    });
    if (tracking.summary.ballDetectionCoverage < 0.08) job.warnings.push("Ball detection was weak in some scenes; the native broadcast frame was preserved and unsafe player markers were suppressed.");
    if (Number(tracking.summary.jointFitCoverage || 0) < 0.55) job.warnings.push(job.settings.aspectRatio === "16:9"
      ? "Some gameplay scenes had weak local detector evidence; the stable native frame was preserved and unsafe annotations were suppressed."
      : "Some gameplay scenes required conservative 9:16 repair; their scenes remain in the edit while unsafe highlights and effects are suppressed.");
    if (job.settings.logoMasking) job.warnings.push("Broadcast scorebug/header/channel cleanup is enabled; masks are limited to shallow edge graphics and do not cover the pitch action.");
    const ttsFiles = job.settings.commentary ? masterTtsFiles : new Map();
    if (job.settings.commentary && ttsFiles.size === 0 && selected.some((moment) => moment.commentary)) {
      job.warnings.push("Google Cloud TTS produced no narration audio; the result contains silence because source audio is muted in commentary mode.");
    }
    if (job.settings.captions && !selected.some((moment) => moment.commentary)) job.warnings.push("No evidence-based commentary text was available, so no captions were burned in.");
    job = await updateJob(job, "editing", 72);
    const destination = join(outputRoot, id);
    await mkdir(destination, { recursive: true });
    const stadiumAudioPath = isCompleteHighlights(job.settings) && !job.settings.commentary && job.settings.originalAudio !== "muted"
      ? await makeStadiumAudio(job.sourceKey, frameable, id)
      : null;
    const outputPath = join(destination, "final.mp4");
    job = await updateJob(job, "rendering", 84);
    const renderResult = completedVisual
      ? await finishCompletedVisualNarration(completedVisual, outputPath, selected, job.settings, ttsFiles)
      : await renderVideoV2(job.sourceKey, outputPath, selected, job.settings, media, ttsFiles, overlayMasks, tracking, stadiumAudioPath, job.matchContext || job.editPlan?.matchContext);
    job = await updateJob(job, "validating", 96, {
      editPlan: { ...job.editPlan, synchronization: renderResult.synchronization },
    });
    const renderValidation = await validateRenderedVideo(outputPath, job.settings);
    await writeTransformationAudit(destination, job, media, frameable, contentPlan.contentScript);
    let qualityReview;
    if (geminiEnabled && blockingAiQualityReview) {
      try {
        qualityReview = await reviewRenderedVideoWithGemini(outputPath, renderValidation.media, id, job.settings, selected, job.matchContext);
        if (!qualityReview.approved) {
          const issues = qualityReview.issues.slice(0, 3).join("; ");
          job.warnings.push(`AI quality review scored this edit ${qualityReview.score}/100${issues ? `: ${issues}` : "."}`);
        }
      } catch (error) {
        job.warnings.push(`The final AI quality review could not run, but deterministic media validation passed and the playable export was preserved: ${sanitizeProviderError(String(error?.message || error))}`);
      }
    }
    if (qualityReview && !qualityReview.approved) {
      const issues = qualityReview.issues.slice(0, 3).join("; ");
      job.warnings.push(`AI quality review requested improvements at ${qualityReview.score}/100${issues ? `: ${issues}` : "."} The playable export was preserved instead of failing the job.`);
    }
    job = await updateJob(job, "completed", 100, {
      outputKey: outputPath,
      outputUrl: publicOutputUrl(id),
      renderValidation,
      qualityReview,
      loudness: renderResult.loudness,
      warnings: [...new Set(job.warnings)],
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`Job ${id} failed`, error);
    const saved = await readJob(id);
    job = { ...job, ...saved, warnings: [...new Set([...(saved.warnings || []), ...(job.warnings || [])])] };
    await handleProcessingInterruption(id,error);
  } finally {
    if (activeGeminiJobId === id) activeGeminiJobId = null;
  }
}

function normalizeDecisionSceneEvidence(moment) {
  const normalized = normalizeDecisionOnlyScene(moment);
  return normalized === moment ? moment : { ...normalized, semanticSignature: semanticSignature(normalized) };
}

async function loadStep1SceneManifest(id, settings, {sourceOnly=false}={}) {
  let sourceManifest=[];
  try {
    const saved=JSON.parse(await readFile(join(outputRoot,id,"step1-scene-manifest.json"),"utf8"));
    if(Number(saved?.version||0)>=1 && Array.isArray(saved?.candidates)) sourceManifest=saved.candidates;
    // The immutable lock predates clip preparation. Restore only matching
    // already-saved assets so retry does not falsely display 0 saved clips.
    try {
      const assets=JSON.parse(await readFile(join(outputRoot,id,'source-scenes','manifest.json'),'utf8'));
      sourceManifest=sourceManifest.map(scene=>{
        const asset=assets.scenes?.find(value=>value.id===scene.id
          &&value.sourceStartTime===scene.startTime&&value.sourceEndTime===scene.endTime);
        return asset?{...scene,sourceSceneAsset:asset}:scene;
      });
    } catch { /* A source lock may not yet have saved its separate clips. */ }
  } catch { /* Older jobs may only have semantic checkpoints. */ }
  // A selection-policy upgrade reconciles the original independently reviewed
  // source list, not a later payload whose boundaries/approvals may have been
  // cleared by a framing attempt. It still does not rediscover the source.
  if(sourceOnly) return sourceManifest.map(normalizeDecisionSceneEvidence);
  const requiredLockedIds=sourceManifest.filter(moment=>moment.selectionLocked===true).map(moment=>String(moment.id));
  // A later visual checkpoint is more authoritative than the original Step-1
  // probe set. In particular, a script/TTS retry must preserve the exact
  // post-tracking scene boundaries and must never run scene selection again.
  for (const checkpointName of ["locked-visual-timeline.json", "alignment-review.json"]) {
    try {
      const checkpoint = JSON.parse(await readFile(join(outputRoot, id, checkpointName), "utf8"));
      if (Array.isArray(checkpoint?.moments)
        && checkpoint.moments.some(moment => moment.selectionLocked === true)
        && checkpoint.moments.some(moment => moment.selectedForFinalVideo === true)
        && requiredLockedIds.every(requiredId=>checkpoint.moments.some(moment=>String(moment.id)===requiredId
          && moment.selectionLocked===true && moment.selectedForFinalVideo===true))) {
        return checkpoint.moments.map(normalizeDecisionSceneEvidence);
      }
    } catch { /* The job may not have reached this checkpoint yet. */ }
  }
  if(sourceManifest.length) return sourceManifest.map(normalizeDecisionSceneEvidence);

  // Upgrade an older failed job from its completed semantic batch caches. The
  // post-tracking job payload may contain only the previously passing angles;
  // using it as the retry authority silently erases the incident that needed
  // repair. Semantic cache entries retain the complete verified Step 1 set.
  const semanticDirectory = join(outputRoot, id, "semantic-cache");
  let names;
  try { names = await readdir(semanticDirectory); } catch { return []; }
  const byId = new Map();
  for (const name of names.filter(name => name.endsWith(".json")).sort()) {
    try {
      const saved = JSON.parse(await readFile(join(semanticDirectory, name), "utf8"));
      for (const candidate of Array.isArray(saved?.candidates) ? saved.candidates : []) {
        if (candidate?.id) byId.set(String(candidate.id), candidate);
      }
    } catch { /* Ignore an interrupted cache file; other batches remain usable. */ }
  }
  if (!byId.size) return [];
  let candidates = uniqueEvidenceCandidates(normalizeInventoryCandidateMetadata([...byId.values()].map(normalizeDecisionSceneEvidence)));
  candidates = linkImmediateGoalReplays(candidates);
  candidates = limitIncidentActionViews(candidates);
  candidates = chooseInitialScenesForLock(candidates, settings);
  candidates = lockInitialSceneSelection(candidates, { requireSemanticVerification: geminiEnabled });
  await writeFile(join(outputRoot,id,"step1-scene-manifest.json"), JSON.stringify({ version: 1, candidates, savedAt: new Date().toISOString(), recoveredFromSemanticCache: true }, null, 2));
  return candidates;
}

function tacticalDrawingForMoment(moment) {
  if (moment.eventType === "celebration" || moment.storyPhase === "reaction" || moment.role === "reaction") return "none";
  const tacticalText = [moment.commentary, moment.analysisPurpose, moment.description, moment.semanticDescription,
    ...(Array.isArray(moment.semanticNarrationFacts) ? moment.semanticNarrationFacts : [])]
    .filter(Boolean).join(" ").toLowerCase();
  const verifiedPassLanguage = /\b(?:assist(?:ed)?|cross(?:ed|es|ing)?|cut[ -]?back|through[ -]?ball|thread(?:ed|s|ing)?|square[sd]?|slip(?:ped|s)?|lay(?:off|s|ed)|tee(?:d)? up|knock(?:ed)? down|suppl(?:y|ies|ied)|pass(?:ed|es|ing)?)\b/.test(tacticalText);
  const hasOriginAnchor = Number.isFinite(Number(moment.trackingBrief?.originTime));
  if (["goal", "disallowed_goal", "shot_on_target", "shot_off_target", "save", "big_chance"].includes(moment.eventType)) {
    return verifiedPassLanguage && hasOriginAnchor ? "pass" : "ball";
  }
  if (["assist", "free_kick"].includes(moment.eventType) || ["setup", "build_up"].includes(String(moment.role))) return "pass";
  if (["skill", "dribble", "tackle"].includes(moment.eventType)) return "run";
  if (moment.eventType === "normal_play" && moment.role === "analysis") return "map";
  return "none";
}

function applyCompleteHighlightTreatment(moments, settings) {
  if (!isCompleteHighlights(settings)) return moments;
  const decisive = new Set(["goal", "disallowed_goal", "save", "shot_on_target", "shot_off_target", "big_chance"]);
  let editIndex = 0;
  return moments.map(moment => {
    if (!moment.selectedForFinalVideo) return moment;
    const currentEditIndex = editIndex++;
    const isReaction = moment.eventType === "celebration" || moment.storyPhase === "reaction" || moment.role === "reaction";
    const isReplay = (moment.isReplay || moment.storyPhase === "replay") && !verifiedPrimaryReplayGoal(moment);
    const isDecisiveAction = decisive.has(moment.eventType) && !isReplay && !isReaction;
    const transitionIn = currentEditIndex === 0 ? "cut" : isReplay || isDecisiveAction ? "flash" : "crossfade";
    const transitionDuration = currentEditIndex === 0 ? 0.04 : isReplay || isDecisiveAction ? 0.10 : 0.14;
    const safeStatic = usesSafeStaticPresentation(moment);
    const conservativePresentation = Boolean(moment.fallbackPresentation);
    const hasOriginAnchor = Number.isFinite(Number(moment.trackingBrief?.originTime));
    const hasContactAnchor = Number.isFinite(Number(moment.trackingBrief?.contactTime));
    const hasPayoffAnchor = Number.isFinite(Number(moment.trackingBrief?.payoffStartTime));
    const tacticalDrawing = conservativePresentation ? "none" : tacticalDrawingForMoment(moment);
    const analyticalFreeze = Boolean(String(moment.commentary || "").trim())
      && tacticalDrawing !== "none"
      && (tacticalDrawing === "pass" ? hasOriginAnchor : hasContactAnchor || hasPayoffAnchor);
    const completeActionRate = (freezeDuration = 0) => completeActionPlaybackRate(
      Number(moment.endTime) - Number(moment.startTime),
      freezeDuration,
    );
    const base = {
      ...moment,
      presentationVersion: 2,
      colorGrade: gradeForScene(moment),
      transitionIn,
      transitionDuration,
      playerHighlight: moment.playerHighlight !== false
        && !conservativePresentation && !isReaction
        && moment.mainPlayerVisible !== false && moment.ballVisible !== false,
      tacticalDrawing,
      completeActionCompressed: !isReaction,
    };
    if (isReaction) return { ...base, playerHighlight: false, tacticalDrawing: "none", effect: "none", playbackRate: 1, soundEffect: "sparkle" };
    if (isReplay) return { ...base, playerHighlight: false, tacticalDrawing: "none", effect: "replay_treatment", playbackRate: completeActionRate(), soundEffect: "whoosh" };
    if (!isDecisiveAction) return {
      ...base,
      effect: analyticalFreeze ? "freeze_analysis" : moment.effect,
      freezeAtPhase: analyticalFreeze ? tacticalDrawing === "pass" ? "origin" : hasContactAnchor ? "contact" : "payoff" : moment.freezeAtPhase,
      freezeDuration: analyticalFreeze ? 0.72 : moment.freezeDuration,
      playbackRate: completeActionRate(analyticalFreeze ? 0.72 : 0),
      soundEffect: soundForEvent(moment) === "none" ? "whoosh" : soundForEvent(moment),
    };
    const freezeEligible = analyticalFreeze && (!safeStatic || hasContactAnchor || hasPayoffAnchor);
    return {
      ...base,
      tacticalDrawing: freezeEligible ? tacticalDrawing : "none",
      effect: conservativePresentation ? "none" : freezeEligible ? "freeze_analysis" : "slow_motion",
      freezeAtPhase: freezeEligible ? tacticalDrawing === "pass" ? "origin" : hasContactAnchor ? "contact" : "payoff" : undefined,
      freezeDuration: freezeEligible ? 0.82 : undefined,
      playbackRate: completeActionRate(freezeEligible ? 0.82 : 0),
      colorGrade: conservativePresentation ? "clean" : gradeForScene(moment),
      soundEffect: conservativePresentation ? "none" : moment.eventType === "goal" ? "goal" : "impact",
      eventCallout: conservativePresentation ? "none" : moment.eventType === "goal" ? "goal" : moment.eventType === "save" ? "save" : "shot",
    };
  });
}
function viralAnalysisLine(moment, decisionStory) {
  if (moment.eventType === "goal") return "Freeze here. The decisive touch beats the goalkeeper.";
  if (moment.eventType === "disallowed_goal" || decisionStory) return "Freeze here. The replay changes the decision.";
  if (moment.eventType === "save") return "Freeze here. The reaction stops the final effort.";
  return "Freeze here. This touch creates the danger.";
}
async function finishViralReelJob(job, candidates, media, overlayMasks, tracking, id) {
  const reel = buildViralReelPlan(candidates);
  let selected = applyTrackingQuality(reel.moments, tracking, job.settings);
  if (job.settings.commentary) selected = selected.map(moment => {
    if (!moment.selectedForFinalVideo || moment.role !== "action") return { ...moment, commentary: "" };
    const contactTime = Number(moment.trackingBrief?.contactTime);
    const narrationDelay = clamp((Number.isFinite(contactTime) ? contactTime - moment.startTime : 1.2) - 0.55, 0, 1.5);
    return { ...moment, commentary: viralAnalysisLine(moment, moment.eventType === "disallowed_goal"), narrationDelay };
  });
  const frameable = selected.filter(moment => moment.selectedForFinalVideo);
  if (!frameable.length) throw new Error("The best Viral Reel story failed the final tracking and framing check.");
  const plannedDuration = frameable.reduce((sum, moment) => sum
    + (moment.endTime - moment.startTime) / clamp(Number(moment.playbackRate || 1), 0.72, 1.18)
    + (moment.effect === "freeze_analysis" ? clamp(Number(moment.freezeDuration || 0.72), 0.4, 1) : 0), 0);
  const bounds = viralReelDurationBounds();
  if (plannedDuration < bounds.minimum || plannedDuration > bounds.maximum) {
    throw new Error(`The verified Viral Reel is ${plannedDuration.toFixed(1)} seconds; safe Viral Reels must be ${bounds.minimum}-${bounds.maximum} seconds without filler.`);
  }
  job.settings = { ...job.settings, targetDuration: plannedDuration };
  job.warnings.push("Player names are intentionally omitted because this run has no independent identity verification source.");
  const editPlan = {
    planningMode: "verified_multi_incident_viral_reel",
    viralReelVersion: 1,
    storyId: reel.storyId,
    storyIds: reel.storyIds,
    incidentCount: reel.incidentCount,
    storyScore: reel.score,
    decisionStory: reel.decisionStory,
    selectedCount: frameable.length,
    plannedDuration: Number(plannedDuration.toFixed(3)),
    narrationScript: frameable.map(moment => moment.commentary).filter(Boolean).join(" "),
    identityPolicy: "No player label unless independently verified; this run uses no player names.",
  };
  const destination = join(outputRoot, id);
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "viral-reel-plan.json"), JSON.stringify({ editPlan, moments: selected }, null, 2));
  job = await updateJob(job, job.settings.commentary ? "generating_commentary" : "editing", job.settings.commentary ? 64 : 72, { moments: selected, observedMoments: candidates, trackingSummary: tracking.summary, editPlan });
  const ttsFiles = job.settings.commentary ? await makeSpeech(selected, id) : new Map();
  if (job.settings.commentary && ttsFiles.size === 0) throw new Error("Google Cloud TTS produced no Viral Reel analysis voice-over.");
  job = await updateJob(job, "editing", 72);
  const stadiumAudioPath = job.settings.originalAudio !== "muted"
    ? await makeStadiumAudio(job.sourceKey, frameable, id)
    : null;
  const outputPath = join(destination, "final.mp4");
  job = await updateJob(job, "rendering", 84);
  const renderResult = await renderVideoV2(job.sourceKey, outputPath, selected, job.settings, media, ttsFiles, overlayMasks, tracking, stadiumAudioPath, job.matchContext || job.editPlan?.matchContext);
  job = await updateJob(job, "validating", 96, { editPlan: { ...editPlan, synchronization: renderResult.synchronization } });
  const renderValidation = await validateRenderedVideo(outputPath, job.settings);
  let qualityReview;
  if (geminiEnabled && blockingAiQualityReview) {
    try {
      qualityReview = await reviewRenderedVideoWithGemini(outputPath, renderValidation.media, id, job.settings, selected, job.matchContext);
      if (!qualityReview.approved) {
        const issues = qualityReview.issues.slice(0, 3).join("; ");
        job.warnings.push(`AI quality review requested Viral Reel improvements at ${qualityReview.score}/100${issues ? `: ${issues}` : "."} The playable export was preserved.`);
      }
    } catch (error) {
      job.warnings.push(`The Viral Reel AI quality review could not run, but deterministic media validation passed: ${sanitizeProviderError(String(error?.message || error))}`);
    }
  }
  await updateJob(job, "completed", 100, {
    outputKey: outputPath,
    outputUrl: publicOutputUrl(id),
    renderValidation,
    qualityReview,
    completedAt: new Date().toISOString(),
  });
}

function createGeminiClient() {
  const traffic = geminiTrafficPolicy();
  return new GoogleGenAI({
    vertexai: true,
    project: process.env.GOOGLE_CLOUD_PROJECT,
    location: traffic.location,
    ...(process.env.GEMINI_API_KEY ? { apiKey: process.env.GEMINI_API_KEY } : {}),
    httpOptions: { timeout: geminiRequestTimeoutMs, ...traffic.httpOptions },
  });
}
async function recordGeminiCapacityWait(label, attempt, delayMs, reason = "capacity", providerRetryAfterMs, model, limitEvidence) {
  if (!activeGeminiJobId) return;
  try {
    const current = await readJob(activeGeminiJobId);
    if (["completed", "failed"].includes(current.stage)) return;
    const cooldown={active:true,reason,label,model,
      ...(limitEvidence?{limitEvidence}:{}),attempt,
      providerRetryAfterMs:Number.isFinite(providerRetryAfterMs)?providerRetryAfterMs:null,
      retryAt:new Date(Date.now()+delayMs).toISOString()};
    await updateJob(current, current.stage, current.progress, {
      aiCapacityWait: cooldown,
      ...(model?{aiModelCooldowns:{[model]:cooldown}}:{}),
      resumeFromCandidates: Boolean(current.media && Array.isArray(current.moments) && current.moments.length),
      progressDetail: `${reason === "timeout" ? "Gemini request timed out" : reason === "service" ? "Gemini service temporarily unavailable" : limitEvidence ? geminiLimitMessage(limitEvidence) : "Gemini capacity is busy"}. Saved progress; retrying ${label} in ${Math.ceil(delayMs / 1000)} seconds (attempt ${attempt}).`,
    });
  } catch (error) {
    console.warn(`Could not persist Gemini capacity wait state: ${sanitizeProviderError(String(error?.message || error))}`);
  }
}

async function recordGeminiRequestStarted(label, model) {
  if (!activeGeminiJobId) return;
  try {
    const current = await readJob(activeGeminiJobId);
    // A wait expiring means a request can start, not that Google approved it.
    // Do not leave a stale "capacity busy" status while that request runs,
    // and never clear another parallel excerpt's still-active cooldown.
    if (!current.aiCapacityWait?.active
      || Date.parse(current.aiCapacityWait.retryAt) > Date.now()
      || geminiRequestGate.status(model).nextRequestAt > Date.now()
      || current.aiCapacityWait.model && current.aiCapacityWait.model !== model) return;
    await updateJob(current, current.stage, current.progress, {
      aiCapacityWait: { ...current.aiCapacityWait, active: false, retryStartedAt: new Date().toISOString() },
      progressDetail: `Gemini request in progress: ${label}. Completed observations remain saved.`,
    });
  } catch (error) {
    console.warn(`Could not update Gemini request status: ${sanitizeProviderError(String(error?.message || error))}`);
  }
}

async function clearGeminiCapacityWait(completedLabel, model) {
  if (!activeGeminiJobId) return;
  try {
    const current = await readJob(activeGeminiJobId);
    if (!current.aiCapacityWait?.active) return;
    if (current.aiCapacityWait.model && current.aiCapacityWait.model !== model) return;
    // A parallel excerpt succeeding does not end another excerpt's cooldown.
    // Expired restored waits may still be cleared by the first real response.
    if (current.aiCapacityWait.label !== completedLabel
      && Date.parse(current.aiCapacityWait.retryAt) > Date.now()) return;
    await updateJob(current, current.stage, current.progress, {
      aiCapacityWait: { ...current.aiCapacityWait, active: false, resumedAt: new Date().toISOString() },
      progressDetail: `Gemini response received. Continuing ${completedLabel || current.aiCapacityWait.label}.`,
    });
  } catch (error) {
    console.warn(`Could not clear Gemini capacity wait state: ${sanitizeProviderError(String(error?.message || error))}`);
  }
}

async function generateGeminiContent(ai, request, label, attempts = 3) {
  const performanceJobId=activeGeminiJobId;
  const originalRequest=request;
  const eligibleModels=geminiFailoverModels(request.model,process.env,label);
  for(const candidateModel of eligibleModels) {
  const cooldownRestoreKey = `${activeGeminiJobId}:${candidateModel}`;
  if (activeGeminiJobId && !restoredCapacityCooldownJobs.has(cooldownRestoreKey)) {
    restoredCapacityCooldownJobs.add(cooldownRestoreKey);
    const saved = await readJob(activeGeminiJobId);
    // A persisted Pro cooldown must not be restored into a Flash lane.
    // Legacy waits have no model attribution and cannot safely be assigned
    // to every model. The provider will return a new attributed wait if needed.
    const savedCooldown=saved.aiModelCooldowns?.[candidateModel]||saved.aiCapacityWait;
    if (savedCooldown?.active && savedCooldown.model === candidateModel) {
      const remaining = restoredGeminiRetryDelay(savedCooldown, geminiQuotaMaximumDelayMs);
      if (remaining > 0) {
        geminiRequestGate.defer(remaining, candidateModel);
        if (Date.parse(savedCooldown.retryAt) - Date.now() > remaining + 1000) {
          await recordGeminiCapacityWait(savedCooldown.label, savedCooldown.attempt,
            remaining, savedCooldown.reason, savedCooldown.providerRetryAfterMs, candidateModel, savedCooldown.limitEvidence);
        }
      }
    }
  }
  }
  let transientAttempt = 0;
  let quotaAttempt = 0;
  const timeoutCounts = new Map();
  for (;;) {
    const actualModel=chooseGeminiFailoverModel(eligibleModels,model=>geminiRequestGate.status(model),
      Date.now(),new Set([...unavailableGeminiFailoverModels].filter(model=>model!==originalRequest.model)));
    if(actualModel!==request.model) {
      const previousModel=request.model;
      request={...originalRequest,model:actualModel};
      // Clear ONLY this logical request's old wait, not a parallel scene's wait.
      // Other scenes still respect the rejected model's shared cooldown.
      if(performanceJobId) {
        const current=await readJob(performanceJobId);
        await updateJob(current,current.stage,current.progress,{
          ...(current.aiCapacityWait?.active && current.aiCapacityWait.label===label
            && current.aiCapacityWait.model===previousModel
            ? {aiCapacityWait:{...current.aiCapacityWait,active:false,switchedAt:new Date().toISOString()}}:{}),
          aiModelSwitch:{label,from:previousModel,to:actualModel,at:new Date().toISOString()},
          progressDetail:`Continuing ${label} with ${actualModel}; selected scenes and quality checks are unchanged.`});
      }
      console.info(`Gemini model switch: ${JSON.stringify({label,from:previousModel,to:actualModel})}`);
    }
    const requestStartedAt = Date.now();
    let providerStartedAt;
    const deadlineMs = geminiRetryDeadline(Math.max(geminiRequestTimeoutMs, Number(request.config?.httpOptions?.timeout) || 0), timeoutCounts.get(request.model)||0);
    try {
      const schedule=geminiRequestGate.scheduleAvailable && eligibleModels.length>1
        && geminiRequestGate.status(request.model).nextRequestAt<=Date.now()
        ? geminiRequestGate.scheduleAvailable : geminiRequestGate.schedule;
      const response = await schedule(() => withGeminiDeadline(async signal => {
        providerStartedAt=Date.now();
        await recordGeminiRequestStarted(label, request.model);
        return ai.models.generateContent({ ...request, config: { ...geminiGenerationConfig(request.model,request.config),
          abortSignal: request.config?.abortSignal ? AbortSignal.any([signal, request.config.abortSignal]) : signal,
          // The durable scheduler owns retries and checkpoints. Nested SDK
          // retries must not outlive its hard deadline or hide provider errors.
          httpOptions: { ...request.config?.httpOptions, timeout: deadlineMs, retryOptions: { attempts: 1 } } } });
        },
        deadlineMs, label), request.model);
      const traffic = geminiTrafficResult(response, geminiTrafficPolicy());
      workflowPerformance.request(performanceJobId,{label,model:request.model,status:'success',
        providerStartedAt,
        gateWaitMs:(providerStartedAt??Date.now())-requestStartedAt,
        providerMs:providerStartedAt?Date.now()-providerStartedAt:0,usage:response.usageMetadata});
      if (traffic.requestedTier === "priority") {
        console.info(`Gemini traffic: ${JSON.stringify({ label, ...traffic,
          elapsedSeconds: (Date.now() - requestStartedAt) / 1000,
          promptTokens: response.usageMetadata?.promptTokenCount,
          cachedTokens: response.usageMetadata?.cachedContentTokenCount,
          outputTokens: response.usageMetadata?.candidatesTokenCount,
          thinkingTokens: response.usageMetadata?.thoughtsTokenCount })}`);
      }
      // A restored worker can succeed on its first request while the saved
      // job still has an active wait from the previous worker.
      await clearGeminiCapacityWait(label, request.model);
      recordGeminiGeneration(response,originalRequest.model,request.model);
      return response;
    } catch (error) {
      if(error?.code==='GEMINI_MODEL_COOLDOWN')continue;
      // Explicit cancellation belongs to the caller. A provider CANCELLED
      // response without an aborted caller signal is a transport interruption:
      // retry this request, not the entire scene-selection/tracking pipeline.
      if (request.config?.abortSignal?.aborted) throw error;
      const raw = String(error?.message || error);
      const quotaLimited = geminiResourceExhausted(error);
      workflowPerformance.request(performanceJobId,{label,model:request.model,
        providerStartedAt,limitEvidence:quotaLimited?geminiLimitEvidence(error):undefined,
        status:quotaLimited?'capacity':geminiServiceFailure(error)?.deadline?'timeout':'error',
        gateWaitMs:(providerStartedAt??Date.now())-requestStartedAt,
        providerMs:providerStartedAt?Date.now()-providerStartedAt:0});
      if (quotaLimited) {
        quotaAttempt += 1;
        const retryAfterMs = retryAfterMilliseconds(error);
        const retryDelayMs = quotaRetryDelay(quotaAttempt, {
          baseDelayMs: geminiQuotaBaseDelayMs,
          maximumDelayMs: geminiQuotaMaximumDelayMs,
          retryAfterMs,
        });
        // Share the provider-requested cooldown with queued scenes on THIS model.
        // Otherwise other scene workers keep hitting the same busy endpoint.
        const cooldownMs=geminiFailoverCooldown(retryDelayMs,eligibleModels.length>1);
        geminiRequestGate.defer(cooldownMs, request.model);
        const limitEvidence=geminiLimitEvidence(error);
        await recordGeminiCapacityWait(label, quotaAttempt, cooldownMs, "capacity", retryAfterMs, request.model, limitEvidence);
        console.warn(`Gemini resource exhaustion: ${JSON.stringify({label,model:request.model,...limitEvidence})}`);
        console.warn(`${label} received a temporary quota/rate-limit response; model cooldown ${Math.round(cooldownMs / 1000)} seconds. Checking eligible backups (attempt ${quotaAttempt}).`);
        // The per-model gate owns waiting. The next loop can immediately use a
        // healthy qualified backup instead of sleeping on this rejected model.
        continue;
      }
      const failure=geminiServiceFailure(error);
      const deadline = failure?.deadline===true
        || (failure?.status===499 && Date.now()-requestStartedAt>=deadlineMs*.9);
      if (deadline) timeoutCounts.set(request.model,(timeoutCounts.get(request.model)||0)+1);
      const transient = Boolean(failure);
      if (!transient) {
        const status=Number(error?.status||error?.code||error?.response?.status);
        if(request.model!==originalRequest.model && [403,404].includes(status)) {
          // An optional model may not be available to this project. Do not keep
          // probing it, and do not disguise a primary authentication failure.
          unavailableGeminiFailoverModels.add(request.model);
          continue;
        }
        const invalid=geminiInvalidRequestDetails(error,request,label);
        if(invalid) {
          console.error(`Gemini request validation: ${JSON.stringify(invalid)}`);
          if(activeGeminiJobId) {
            const diagnosticsDirectory=join(outputRoot,activeGeminiJobId,'request-diagnostics');
            try {
              await mkdir(diagnosticsDirectory,{recursive:true});
              await writeFile(join(diagnosticsDirectory,`${Date.now()}-${randomUUID()}.json`),JSON.stringify(invalid,null,2));
            } catch(diagnosticError) {console.warn(`Could not save request diagnostics: ${diagnosticError.code||'write failure'}`);}
          }
          const described=new Error(`Gemini rejected ${label} for model ${invalid.model} (400 INVALID_ARGUMENT). Request schema ${invalid.schemaHash?.slice(0,12)||'none'}; ${invalid.media.length} media part(s). Saved request metadata contains no credentials or footage.`);
          described.code='GEMINI_INVALID_REQUEST';described.status=400;described.cause=error;throw described;
        }
        throw error;
      }
      transientAttempt += 1;
      const retryAfterMs = retryAfterMilliseconds(error);
      const retryDelayMs = serviceRetryDelay(transientAttempt,{retryAfterMs});
      const cooldownMs=geminiFailoverCooldown(retryDelayMs,eligibleModels.length>1);
      geminiRequestGate.defer(cooldownMs, request.model);
      await recordGeminiCapacityWait(label, transientAttempt, cooldownMs, deadline ? "timeout" : "service", retryAfterMs, request.model);
      console.warn(`${label} received a temporary timeout/service response on attempt ${transientAttempt}; saved progress and retrying after ${Math.round(retryDelayMs / 1000)} seconds.`);
      console.warn(`Gemini failed request: ${JSON.stringify({label,status:Number(error?.status || error?.code || raw.match(/\b(408|500|502|503|504)\b/)?.[1]) || null,
        transportCode:String(error?.cause?.code || "").slice(0,64),
        reason:deadline ? "deadline" : "service",elapsedSeconds:(Date.now()-requestStartedAt)/1000,deadlineSeconds:deadlineMs/1000})}`);
      // Healthy backup calls have no artificial delay; if all are busy, the
      // selected model gate waits until the earliest provider cooldown ends.
    }
  }
}

async function generateGeminiJson(ai, request, label, attempts = 3) {
  let lastError;
  let nextRequest = request;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await generateGeminiContent(ai, nextRequest, `${label} JSON attempt ${attempt}`, 3);
    try {
      if (geminiOutputTruncated(response) || !String(response.text || "").trim()) {
        throw new Error("Gemini stopped before completing its JSON response.");
      }
      const parsed=parseGeminiJson(response.text);
      // Persist transport provenance with raw evidence caches. Requested model
      // is a cache-policy key; it is NOT a claim about who observed the pixels.
      if(parsed && typeof parsed==='object' && !Array.isArray(parsed))
        parsed.generationProvenance=geminiResponseProvenance(response);
      return { response, parsed, model:geminiResponseProvenance(response)?.actualModel||request.model };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      if (activeGeminiJobId) {
        const current = await readJob(activeGeminiJobId);
        await updateJob(current, current.stage, current.progress, {
          progressDetail: `${label} returned incomplete JSON. Saved progress; requesting a clean complete JSON response (attempt ${attempt + 1}/${attempts}).`,
        });
      }
      nextRequest = {
        ...request,
        contents: [...request.contents, {
          text: "Your previous response was malformed or truncated JSON and could not be parsed. Rewatch the supplied evidence and return the complete required JSON object again. Output JSON only, close every array and object, include every required candidate exactly once, and do not use markdown fences.",
        }],
        config: geminiJsonRetryConfig(nextRequest.config, response),
      };
    }
  }
  throw new Error(`${label} repeatedly returned malformed JSON: ${String(lastError?.message || lastError)}`);
}
function parseGroundedJson(value) {
  const text = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("Grounded match research returned no JSON object.");
  return JSON.parse(text.slice(first, last + 1));
}

function scorePair(value) {
  const match = String(value || "").match(/(?:^|[^0-9])(\d{1,2})\s*[-:–—_]\s*(\d{1,2})(?:[^0-9]|$)/);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function invalidateConflictingMatchContext(context, sourceName, verifiedGoalCount) {
  if (context?.status !== "verified") return context;
  const researchedScore = scorePair(context.finalScore);
  const filenameScore = scorePair(basename(String(sourceName || ""), extname(String(sourceName || ""))));
  const reportedGoals = Array.isArray(context.goals) ? context.goals.length : 0;
  const scoreTotal = researchedScore ? researchedScore[0] + researchedScore[1] : null;
  const sameScore = !filenameScore || !researchedScore
    || (filenameScore[0] === researchedScore[0] && filenameScore[1] === researchedScore[1])
    || (filenameScore[0] === researchedScore[1] && filenameScore[1] === researchedScore[0]);
  const countMatches = reportedGoals === Number(verifiedGoalCount)
    && (scoreTotal === null || scoreTotal === reportedGoals);
  if (sameScore && countMatches) return context;
  return {
    identityResearchVersion: 5,
    status: "unverified",
    confidence: 0,
    reason: !sameScore ? "source_score_conflicts_with_research" : "goal_count_conflicts_with_research",
    sources: Array.isArray(context.sources) ? context.sources : [],
  };
}

async function researchMatchContextWithGemini(sourceName, recapBrief, candidates) {
  const researchModel=geminiWorkloadModel('research');
  const verifiedGoals = verifiedLiveGoalActions(candidates);
  if (String(process.env.MATCH_RESEARCH_ENABLED || "true").toLowerCase() === "false" || verifiedGoals.length === 0) {
    return { identityResearchVersion: 5, status: "unverified", confidence: 0, reason: verifiedGoals.length ? "match_research_disabled" : "no_verified_live_goals", sources: [] };
  }
  const observedIncidents = verifiedGoals.map((moment, index) => ({
    order: index + 1,
    sourceTime: Number(moment.startTime).toFixed(1),
    description: String(moment.semanticDescription || moment.description || "verified live goal").slice(0, 180),
  }));
  const prompt = matchResearchPrompt({
    sourceName,
    recapBrief,
    verifiedGoalCount: verifiedGoals.length,
    observedIncidents,
    currentDate: new Date().toISOString().slice(0, 10),
  });
  let best = { identityResearchVersion: 5, status: "unverified", confidence: 0, reason: "grounding_not_returned", sources: [] };
  let rejectedSourceUris = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const correction = attempt === 1 ? "" : [
      "Execute Google Search again because the previous report URLs failed independent page-content verification.",
      `Do not repeat these rejected URLs: ${JSON.stringify(rejectedSourceUris)}.`,
      "Return at least two DIFFERENT exact canonical match-report URLs that you actually opened and read, not inferred URL slugs, search pages, fixture widgets, homepages, or JavaScript-only scorecards.",
      "Prefer accessible article pages from an official club or competition and a separate reputable written match report such as BBC Sport, Sky Sports, Reuters, AP, ESPN, The Guardian, or The Independent.",
      "Each returned report page must explicitly name both teams, the final score, and every chronological scorer. If two such pages cannot be found, return matchFound false.",
    ].join(" ");
    const response = await generateGeminiContent(createGeminiClient(), {
      model: researchModel,
      contents: [{ text: prompt + correction }],
      config: { tools: [{ googleSearch: {} }], temperature: 0.05,thinkingConfig:{thinkingLevel:'LOW'} },
    }, `Gemini grounded match research attempt ${attempt}`, 2);
    const raw = parseGroundedJson(response.text);
    const groundingSources = extractGroundingSources(response);
    // Player identity is too consequential to accept from citation metadata
    // alone. Fetch every model-declared or grounded report and retain only
    // trusted pages whose text independently contains the exact fixture,
    // score, and every scorer. Two distinct report domains are still required.
    let sources = await verifyClaimedResearchSources({
      ...raw,
      sources: [...(Array.isArray(raw?.sources) ? raw.sources : []), ...groundingSources],
    });
    if (sources.length < 2) sources = [...sources, ...await discoverVerifiedResearchSources(raw)]
      .filter((source, index, all) => all.findIndex((item) => item.uri === source.uri) === index);
    rejectedSourceUris = [...new Set([
      ...rejectedSourceUris,
      ...(Array.isArray(raw?.sources) ? raw.sources.map((source) => String(source?.uri || "")).filter(Boolean) : []),
      ...groundingSources.map((source) => source.uri),
    ])].slice(-12);
    best = {...invalidateConflictingMatchContext(
      normalizeMatchContext(raw, sources, verifiedGoals.length),
      sourceName,
      verifiedGoals.length,
    ),researchModel};
    if (best.status === "verified") return best;
  }
  return best;
}

async function ensureShotBoundaries(sourcePath, id) {
  const outputPath = join(outputRoot, id, "shots.json");
  const sourceInfo = await stat(sourcePath, { bigint: true });
  try {
    const saved = parseSourceShotCheckpoint(await readFile(outputPath, "utf8"));
    if (sourceShotCheckpointMatches(saved,sourcePath,sourceInfo)) return outputPath;
  } catch { /* Missing, stale, or interrupted shot inventory. */ }
  await run(trackingPythonPath, [join(projectRoot, "local-processor", "shot-boundaries.py"),
    "--source", sourcePath, "--output", outputPath, "--ffmpeg", ffmpegPath]);
  return outputPath;
}

async function loadBroadcastShotInventory(id, media) {
  const payload = JSON.parse(await readFile(join(outputRoot, id, "shots.json"), "utf8"));
  const inventory = buildBroadcastShotInventory(payload.shots, media.duration);
  if (!inventory.length) throw new Error("PySceneDetect returned no usable broadcast-shot boundaries.");
  return inventory;
}

async function loadSoccerNetActionAnchors(sourcePath, id) {
  if (!soccerNetEnabled) return { anchors: [], detector: "disabled" };
  const outputPath = join(outputRoot, id, "soccernet-calf.json");
  const sourceInfo = await stat(sourcePath, { bigint: true });
  try {
    const cached = JSON.parse(await readFile(outputPath, "utf8"));
    if (BigInt(cached?.source?.size || 0) === sourceInfo.size && BigInt(cached?.source?.mtimeNs || 0) === sourceInfo.mtimeNs) return cached;
  } catch { /* Run CALF when the job has no matching cache. */ }
  const current = await readJob(id);
  await updateJob(current, "analyzing", 13, { progressDetail: "SoccerNet CALF is spotting goals, shots, set pieces, and other action anchors across the complete upload." });
  await run(soccerNetPythonPath, [soccerNetScriptPath, "--source", sourcePath, "--output", outputPath,
    "--repo", soccerNetRepoPath, "--ffmpeg-dir", dirname(ffmpegPath),
    "--cache-dir", join(dataRoot, "model-cache", "soccernet-calf")]);
  return JSON.parse(await readFile(outputPath, "utf8"));
}
function normalizeInventoryPassages(items, media, excerpt, excerptShots) {
  const constrained = (Array.isArray(items) ? items : []).flatMap((item) => {
    if (!passageFitsShotSequence(item, excerptShots)) return [];
    const shotIds = Array.isArray(item?.shotIds) && item.shotIds.length
      ? item.shotIds.map(String)
      : [String(item?.shotId || "")];
    const firstIndex = excerptShots.findIndex((shot) => shot.shotId === shotIds[0]);
    const lastIndex = excerptShots.findIndex((shot) => shot.shotId === shotIds[shotIds.length - 1]);
    const first = excerptShots[firstIndex];
    const last = excerptShots[lastIndex];
    const startTime = clamp(Number(item.startTime), first.startTime, last.endTime);
    const endTime = clamp(Number(item.endTime), startTime, last.endTime);
    if (endTime - startTime < 1) return [];
    return [{ ...item, shotIds, startTime, endTime, broadcastShotId: first.shotId, broadcastShotIds: shotIds }];
  });
  return normalizeMoments(constrained, media.duration, excerpt.startTime);
}
function buildPassageInventoryPrompt(targetDuration, excerpt, excerptNumber, excerptCount, shots, soccerNetAnchors = []) {
  const requestedCoverage = Math.ceil(excerpt.requestedSeconds ?? targetDuration * 1.65 / Math.max(1, excerptCount));
  return [
    `You are the INITIAL AND ONLY source selector for excerpt ${excerptNumber} of ${excerptCount} of a professional full-match football recap. Watch the entire excerpt from beginning to end and decide complete usable source passages in THIS response. There will be no later discovery, scoreboard sampling, missing-goal search or source-review reel. watchedThroughSeconds must record the excerpt-local end actually watched.`,
    `All response times are seconds RELATIVE to this ${excerpt.duration.toFixed(3)}-second excerpt. Every returned moment must declare shotIds as an ordered array containing one shotId or several consecutive supplied shotIds. A complete football action may cross rapid broadcast cuts, but it must remain inside the union of those consecutive shots and must never skip a shot.`,
    `Return every useful DISTINCT complete action visible: all goals, disallowed goals, shots on target, misses, saves, big chances, blocks, set pieces and useful attacking combinations. Use natural NORMAL-SPEED durations from initiating player WITH BALL through pass/shot and resolved result. This section's SOFT share is ${requestedCoverage} seconds toward the combined recap; stronger sections may supply more and quiet sections less. Do not stop at an arbitrary number of moments. No padding, 5-second cutoff, repeated goal angles or inferred goals from score text.`,
    "A long shot may yield multiple non-overlapping passages, but split only after an action resolves or possession clearly resets. Individual action passages usually last 5-20 seconds and may last up to 30; never force a five-second cut through an unfinished attack. Join consecutive short shotIds only when they visibly continue the SAME action, never its repeated replay. Do not duplicate or overlap intervals.",
    "Choose ONE clearest COMPLETE angle per incident, preferably the first stable live wide view. Use a replay as the primary only if it actually shows the whole action more clearly. Never return both as separate incidents. Keep the initiating pass, scorer's final contact, ball flight, keeper/goalmouth and visible result before cutting. Exclude complex close-up replays, ads, idle players, long VAR and reaction-only 'goals'. An optional immediate celebration is a separate 2-3 second support clip sharing the action's storyId. Step 2 will track these exact clips separately, not remove or replace them.",
    "Decide portrait suitability NOW, in this first observation. In sourceObservation.framingNotes record the starting player WITH BALL, movement/receiver handoff, and the keeper/goalmouth final focus; note any hidden decisive action, violent camera cut or difficult close-up. Give portraitReadability from 0 to 100 based on directly visible complete action and how clearly a 9:16 camera can follow it. Choose the clearest complete view before locking, not an inferior first angle that would need later repair. Do not invent pixel tracks in Step 1 or promise an unobserved crop. Step 2 makes ONE initial video camera plan; no repair/reselection loop exists.",
    "Use normal_play with storyPhase build_up for useful attacks or tactical context that are not special events. Correctly labelled buildup is valuable evidence and must not be rejected merely because it is not a shot or goal.",
    "SoccerNet CALF proposals are temporal search anchors, not final truth. Inspect the video around each proposal, correct an incorrect class label, and include the complete action across consecutive shotIds. Never accept a proposal without visible evidence.",
    `SoccerNet proposals in this excerpt: ${JSON.stringify(soccerNetAnchors)}`,
    "For each action, sourceObservation must describe the visibly observed setup, continuation and result in basic English; outcome MUST equal eventType. Set initiatorAndBallVisible, continuationVisible and resultVisible truthfully. A celebration only has a visible result and must not claim a kick or ball flight. Supply actual excerpt-local originTime, contactTime, flightStartTime, payoffStartTime and payoffEndTime in trackingBrief, never default percentages. For a goal, contactTime is the SCORER'S final touch; flightStartTime may be an earlier assist/pass. The goalmouth/payoff phase may overlap an incoming cross or rebound before that final touch; payoffEndTime must show the resolved result after the final contact. Preserve all these moments in one complete scene. Do not guess player names.",
    "trackingBrief describes semantic action phases, NOT final portrait coordinates. Optional payoffEvidence is only a genuinely seen, time-bounded source result rectangle. Return null when uncertain; Step 2 observes the individual scene video to calculate and verify its own smooth position keyframes.",
    "Return only the supplied JSON schema, with moments, uncertainties and watchedThroughSeconds. Report source uncertainties honestly rather than inventing action, repeating reviews or writing the recap voiceover now.",
    `Broadcast-shot ledger: ${JSON.stringify(shots.map(({ shotId, startTime, endTime, duration }) => ({ shotId, startTime, endTime, duration })))}`,
  ].join(" ");
}

async function analyzePassageInventoryWithGemini(sourcePath, media, targetDuration, id) {
  const model=geminiWorkloadModel('discovery'),discoveryFps=initialDiscoveryFps();
  if(!geminiEnabled||!model) throw new Error("Gemini is not configured for source selection.");
  const fingerprint=await sourceContentFingerprint(sourcePath);
  // A whole maximum-length action crossing a section edge must be visible in
  // at least one initial request; otherwise two half-actions require a search.
  const overlap=Math.max(analysisChunkOverlap,Math.min(MAX_SCENE_SECONDS,analysisChunkSeconds/3));
  const sectionPlan=step1DiscoveryPlan(media.duration,targetDuration,analysisChunkSeconds,overlap);
  const inventoryPath=join(outputRoot,id,'passage-inventory.json');
  const inventoryKey=stableSignature({version:passageInventoryVersion,contract:INITIAL_SECTION_VERSION,
    fingerprint,model,sectionPlan,discoveryFps,analysisHeight});
  try {
    const saved=JSON.parse(await readFile(inventoryPath,'utf8'));
    if(saved.key===inventoryKey&&Array.isArray(saved.summary?.scoringObservations)
      &&Array.isArray(saved.candidates)&&saved.candidates.length
      &&saved.candidates.every(scene=>scene.sourceSelectionEvidence?.version===INITIAL_SECTION_VERSION))
      return {moments:saved.candidates,overlayMasks:saved.overlayMasks||[],warnings:saved.warnings||[],
        passageInventorySummary:saved.summary};
  } catch { /* A fresh upload has no one-pass source selection yet. */ }
  const inventory=await loadBroadcastShotInventory(id,media);
  const soccerNet=await loadSoccerNetActionAnchors(sourcePath,id);
  const proxies=await createAnalysisProxies(sourcePath,media,id,analysisChunkSeconds,`initial-v${INITIAL_SECTION_VERSION}`,overlap,discoveryFps);
  const ai=createGeminiClient(),sourceJob=await readJob(id);
  const directory=join(outputRoot,id,'inventory-excerpts');
  await mkdir(directory,{recursive:true});
  const sections=proxies.map((excerpt,index)=>({...excerpt,
    requestedSeconds:sectionPlan.sections[index]?.requestedSeconds||0,
    shots:inventoryForExcerpt(inventory,excerpt)}));
  const currentWorkload={model,fps:discoveryFps,height:analysisHeight};
  const inventoryKeyForWorkload=profile=>stableSignature({version:passageInventoryVersion,contract:INITIAL_SECTION_VERSION,
    fingerprint,model:profile.model,sectionPlan,discoveryFps:profile.fps,analysisHeight:profile.height});
  const sectionInputKey=section=>stableSignature({version:passageInventoryExcerptVersion,contract:INITIAL_SECTION_VERSION,
    fingerprint,sectionPlan,startTime:section.startTime,duration:section.duration,
    shots:section.shots.map(({shotId,startTime,endTime})=>({shotId,startTime,endTime}))});
  const sectionKey=(section,profile=currentWorkload)=>stableSignature({inventoryKey:inventoryKeyForWorkload(profile),startTime:section.startTime,duration:section.duration,
    shots:section.shots.map(({shotId,startTime,endTime})=>({shotId,startTime,endTime}))});
  const cachePath=index=>join(directory,`excerpt-${String(index+1).padStart(3,'0')}.json`);
  const results=await observeInitialSections({
    sections,
    readCached:async(section,index)=>{
      try {
        const saved=JSON.parse(await readFile(cachePath(index),'utf8'));
        // Older checkpoints have an opaque key but the selection report records
        // model provenance. It is a hint only: the full old key must still match.
        // The base/framing model is also an authenticated-key candidate for
        // legacy EMPTY sections, which have no accepted scene provenance.
        let legacyModels=[geminiWorkloadModel('framing')].filter(Boolean);
        if(saved.inputKey===undefined) try {
          const selection=JSON.parse(await readFile(join(directory,`selection-${String(index+1).padStart(3,'0')}.json`),'utf8'));
          legacyModels=[...new Set([...legacyModels,...(selection.accepted||[]).map(scene=>scene.sourceSelectionEvidence?.model).filter(Boolean)])];
        } catch { /* No authenticated legacy profile; do not guess. */ }
        const restored=restoreInitialSectionResponse(saved,{version:passageInventoryExcerptVersion,
          inputKey:sectionInputKey(section),keyForWorkload:profile=>sectionKey(section,profile),currentWorkload,legacyModels});
        if(restored) {
          section.observedWorkload=restored.workload;
          if(saved.inputKey===undefined) await writeFile(cachePath(index),JSON.stringify({...saved,
            inputKey:sectionInputKey(section),workload:restored.workload}));
          return restored.rawDraft;
        }
      } catch { /* Not completed: only this initial request will be sent. */ }
    },
    observe:async(section,index)=>{
      await updateJob(await readJob(id),'analyzing',14+Math.round(index/sections.length*14),{
        progressDetail:`Gemini is watching initial source section ${index+1}/${sections.length} (${section.startTime.toFixed(1)}–${(section.startTime+section.duration).toFixed(1)}s). Completed sections are saved; no repeated source reviews.`});
      const anchors=(soccerNet.anchors||[]).filter(anchor=>anchor.timeSeconds>=section.startTime
        &&anchor.timeSeconds<=section.startTime+section.duration)
        .map(anchor=>({...anchor,timeSeconds:anchor.timeSeconds-section.startTime}));
      const request={model,contents:[
        footballVideoPart((await readFile(section.path)).toString('base64'),discoveryFps),
        {text:buildPassageInventoryPrompt(targetDuration,section,index+1,sections.length,section.shots,anchors)
          +` Source filename is context only: ${JSON.stringify(String(sourceJob.sourceName||'').slice(0,240))}. Verify the actual video, not model knowledge or that filename.`}],
        config:{responseMimeType:'application/json',responseJsonSchema:INITIAL_SECTION_SCHEMA,
          temperature:.05,maxOutputTokens:16384,
          ...(/^gemini-3/.test(model)?{thinkingConfig:{thinkingLevel:'LOW'}}:{}),
          httpOptions:{timeout:geminiVideoDeadline(geminiRequestTimeoutMs,section.duration)}}};
      // Provider retries recover 429/5xx/timeouts using this SAME request.
      // No JSON regeneration, shot-audit correction or rediscovery request.
      return (await generateGeminiJson(ai,request,`Gemini initial source section ${index+1}`,1)).parsed;
    },
    save:async(section,index,rawDraft)=>{
      section.observedWorkload=currentWorkload;
      await writeFile(cachePath(index),JSON.stringify({
        version:passageInventoryExcerptVersion,key:sectionKey(section),inputKey:sectionInputKey(section),
        workload:currentWorkload,rawDraft,completedAt:new Date().toISOString()}));
    },
    consume:async(draft,section,index)=>{
      if(!Array.isArray(draft?.moments)||!Array.isArray(draft.uncertainties)
        ||!Number.isFinite(draft.watchedThroughSeconds)||draft.watchedThroughSeconds<section.duration-.5
        ||draft.watchedThroughSeconds>section.duration+.5)
        throw new Error(`Initial source section ${index+1} did not report a complete excerpt observation. Its raw response is saved; no automatic second discovery was made.`);
      const rejected=[],accepted=[];
      for(const item of draft.moments) {
        const issues=initialObservationProblems(item,section.duration);
        if(!passageFitsShotSequence(item,section.shots)) issues.push('invalid_camera_shot_interval');
        if(issues.length) {rejected.push({item,issues});continue;}
        const [normalized]=normalizeInventoryPassages([item],media,section,section.shots);
        if(!normalized||normalized.actionComplete!==true) {
          rejected.push({item,issues:['unusable_normalized_interval']});continue;
        }
        // Each singleton normalization starts at index 1; assign a unique ID.
        normalized.id=`initial-${index+1}-${accepted.length+1}`;
        normalized.sourceSelectionEvidence={version:INITIAL_SECTION_VERSION,
          provider:'gemini_initial_section_video',independentReview:false,
          model:(section.observedWorkload||currentWorkload).model,
          fps:(section.observedWorkload||currentWorkload).fps,height:(section.observedWorkload||currentWorkload).height,
          section:index+1,sourceFingerprint:fingerprint,
          sectionStart:section.startTime,sectionDuration:section.duration,
          startTime:normalized.startTime,endTime:normalized.endTime,
          observation:item.sourceObservation};
        // This flag means the initial video supplied a complete semantic
        // observation. It does NOT assert a second opinion or passing crop QA.
        normalized.semanticVerified=true;
        normalized.semanticEvidenceProvider='gemini_initial_section_video';
        normalized.semanticSignature=semanticSignature(normalized);
        normalized.semanticNarrationFacts=[item.sourceObservation.setup,item.sourceObservation.continuation,item.sourceObservation.result];
        accepted.push(normalized);
      }
      await writeFile(join(directory,`selection-${String(index+1).padStart(3,'0')}.json`),
        JSON.stringify({version:INITIAL_SECTION_VERSION,accepted,rejected,
          uncertainties:draft.uncertainties,policy:'local_validation_only'},null,2));
      return {moments:accepted,scoringObservations:initialScoringObservations(draft,section.startTime,index),
        overlayMasks:normalizeMasks(draft.overlayMasks),warnings:[
        ...draft.uncertainties.map(value=>`Source section ${index+1}: ${String(value).slice(0,240)}`),
        ...(rejected.length?[`Section ${index+1}: ${rejected.length} incomplete or inconsistent draft passages were excluded locally before scene lock.`]:[])]};
    },
    onProgress:async({index,restored,results})=>{
      const moments=results.flatMap(result=>result.moments);
      await updateJob(await readJob(id),'analyzing',14+Math.round((index+1)/sections.length*14),{
        moments,sourceSections:sectionSelectionSummary(selectInitialActionViews(moments)
          .filter(scene=>scene.sourceAngleSelected),sectionPlan),
        progressDetail:`${restored?'Restored':'Observed'} initial source section ${index+1}/${sections.length}; ${moments.length} complete action passages saved. No repeat source reviews; clips are not combined.`});
    },
  });
  const moments=mergeAnalyzedMoments(results.flatMap(result=>result.moments))
    .map(scene=>({...scene,sourceDiscoveryPassVersion:UNIFIED_DISCOVERY_VERSION}));
  const masks=mergeOverlayMasks(results.flatMap(result=>result.overlayMasks));
  const warnings=results.flatMap(result=>result.warnings);
  const uniqueSeconds=selectInitialActionViews(moments).filter(scene=>scene.sourceAngleSelected)
    .reduce((sum,scene)=>sum+scene.endTime-scene.startTime,0);
  const summary=unifiedDiscoverySummary({shotCount:inventory.length,candidateCount:moments.length,
    uniqueCandidateSeconds:uniqueSeconds,soccerNetAnchorCount:soccerNet.anchors?.length||0,
    initialSectionVersion:INITIAL_SECTION_VERSION,observationPolicy:'one_initial_video_response_per_section',
    scoringObservations:results.flatMap(result=>result.scoringObservations),
    sectionPlan,completedSections:sections.length});
  await writeFile(inventoryPath,JSON.stringify({version:passageInventoryVersion,key:inventoryKey,
    model,candidates:moments,overlayMasks:masks,warnings,summary},null,2));
  if(!moments.length) throw new Error("Initial section observations found no complete usable football action. See the saved source selection reports; no second discovery was made.");
  return {moments,overlayMasks:masks,warnings,passageInventorySummary:summary};
}
async function analyzeWithGemini(sourcePath, media, targetDuration, id) {
  const model = process.env.GEMINI_MODEL;
  if (!geminiEnabled) throw new Error("Gemini is not configured. Set Vertex AI project/location or an API key.");
  if (!process.env.GOOGLE_CLOUD_PROJECT || !process.env.GOOGLE_CLOUD_LOCATION) throw new Error("GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION are required for Gemini.");
  if (!model) throw new Error("GEMINI_MODEL is required; no fallback model is configured.");
  const ai = createGeminiClient();
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
        footballVideoPart(proxy.toString("base64"), analysisFps),
        { text: buildAnalysisPrompt(targetDuration, excerpt, index + 1, proxies.length, Boolean(visionEvidence)) },
      ];
      if (visionEvidence) contents.push({
        text: `Supporting Google Video Intelligence evidence follows. Its timestamps are ABSOLUTE source-video seconds; your requested output timestamps must remain RELATIVE to this excerpt. Treat object labels as supporting evidence, verify all events from the video, and never infer a goal merely from a ball/person track.\n${JSON.stringify(compactVideoIntelligenceEvidence(visionEvidence))}`,
      });
      const generated = await generateGeminiJson(ai, {
        model,
        contents,
        config: { responseMimeType: "application/json", temperature: 0.15 },
      }, `Gemini football analysis excerpt ${index + 1}`);
      let parsed = generated.parsed;
      let normalized = normalizeMoments(parsed.moments, media.duration, excerpt.startTime);
      if (normalized.length === 0) {
        warnings.push(`Gemini returned no usable numeric moments for excerpt ${index + 1}; the processor retried that excerpt with a simplified recovery prompt.`);
        const retryContents = [
          footballVideoPart(proxy.toString("base64"), analysisFps),
          { text: buildAnalysisRecoveryPrompt(excerpt, index + 1, proxies.length, targetDuration) },
        ];
        if (visionEvidence) retryContents.push({
          text: `Supporting shot/object evidence with ABSOLUTE source timestamps follows. The response itself must still use numeric seconds RELATIVE to this excerpt.\n${JSON.stringify(compactVideoIntelligenceEvidence(visionEvidence))}`,
        });
        const retryGenerated = await generateGeminiJson(ai, {
          model,
          contents: retryContents,
          config: { responseMimeType: "application/json", temperature: 0.05 },
        }, `Gemini football recovery excerpt ${index + 1}`);
        parsed = retryGenerated.parsed;
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

function reconcileSourceScoreCandidates(candidates,ledger) {
  return bindSourceScoreCandidates(candidates,ledger).map(scene=>{
    if(contradictsStableLiveScore(scene,ledger)) return {...scene,semanticVerified:false,keepDecision:'reject',
      selectedForFinalVideo:false,rejectReason:'Proposed live goal contradicts the independently observed unchanged source score; not accepted as a new goal.'};
    return scene;
  });
}

async function discoverRecapExtraActions(sourcePath,media,id,scoringCandidates,minimumSeconds=60) {
  const directory=join(outputRoot,id,"extra-action-inventory");
  await mkdir(directory,{recursive:true});
  await ensureShotBoundaries(sourcePath,id);
  const shots=JSON.parse(await readFile(join(outputRoot,id,"shots.json"),"utf8")).shots;
  const budget=step1DiscoveryPlan(media.duration,minimumSeconds,Math.min(180,analysisChunkSeconds));
  await writeFile(join(directory,'discovery-plan.json'),JSON.stringify(budget,null,2));
  const proxies=(await createAnalysisProxies(sourcePath,media,id,Math.min(180,analysisChunkSeconds),"extra-budget-v5",6))
    .map((excerpt,index)=>({...excerpt,requestedSeconds:budget.sections[index]?.requestedSeconds||0}));
  const fingerprint=await sourceContentFingerprint(sourcePath),ai=createGeminiClient();
  // This is broad passage discovery, not contact/outcome or crop approval.
  // Use two frames per second so brief passes/chances are not skipped;
  // selected actions are independently reobserved densely before scene lock.
  const discoveryFps=Math.min(2,analysisFps);
  const batches=await mapWithConcurrency(proxies,2,async(excerpt,index)=>{
    const end=excerpt.startTime+excerpt.duration;
    const localShots=shots.filter(shot=>shot.endTime>excerpt.startTime && shot.startTime<end)
      .map(shot=>({id:shot.id||shot.shotId,start:Math.max(0,shot.startTime-excerpt.startTime),
        end:Math.min(excerpt.duration,shot.endTime-excerpt.startTime)}));
    const known=scoringCandidates.filter(scene=>scene.endTime>excerpt.startTime && scene.startTime<end)
      .map(scene=>({storyId:scene.storyId,eventType:scene.eventType,isReplay:scene.isReplay,
        start:Math.max(0,scene.startTime-excerpt.startTime),end:Math.min(excerpt.duration,scene.endTime-excerpt.startTime)}));
    const prompt=recapExtraPrompt(excerpt,localShots,known,budget)+' '+footballObservationContract();
    const key=stableSignature({version:RECAP_ACTION_INVENTORY_VERSION,fingerprint,model:process.env.GEMINI_MODEL,
      start:excerpt.startTime,duration:excerpt.duration,fps:discoveryFps,prompt});
    const cache=join(directory,`${key}.json`);let draft;
    try {draft=JSON.parse(await readFile(cache,"utf8"));} catch { /* new source/excerpt */ }
    if(!validRecapExtraDraft(draft,excerpt.duration) && discoveryFps!==analysisFps) {
      const previousKey=stableSignature({version:RECAP_ACTION_INVENTORY_VERSION,fingerprint,model:process.env.GEMINI_MODEL,
        start:excerpt.startTime,duration:excerpt.duration,fps:analysisFps,prompt});
      try {draft=JSON.parse(await readFile(join(directory,`${previousKey}.json`),"utf8"));} catch {}
    }
    if(!validRecapExtraDraft(draft,excerpt.duration)) {
      const current=await readJob(id);
      await updateJob(current,"analyzing",22,{progressDetail:`Finding clear shots, saves and big chances in source excerpt ${index+1}/${proxies.length}. Goals stay independently verified.`});
      const request={model:process.env.GEMINI_MODEL,contents:[
        footballVideoPart((await readFile(excerpt.path)).toString("base64"),discoveryFps),{text:prompt}],
        config:{responseMimeType:"application/json",responseJsonSchema:RECAP_EXTRA_SCHEMA,temperature:.05,
          thinkingConfig:{thinkingLevel:"LOW"},
          httpOptions:{timeout:geminiVideoDeadline(geminiRequestTimeoutMs,excerpt.duration)}}};
      for(let correction=0;correction<2;correction++) {
        draft=normalizeRecapExtraDraft((await generateGeminiJson(ai,request,`Gemini extra football actions excerpt ${index+1}${correction?' clock correction':''}`)).parsed);
        await writeFile(join(directory,`${key}.draft-${correction}.json`),JSON.stringify({
          fingerprint,model:process.env.GEMINI_MODEL,startTime:excerpt.startTime,duration:excerpt.duration,draft,
          problems:recapExtraDraftProblems(draft,excerpt.duration)},null,2));
        if(validRecapExtraDraft(draft,excerpt.duration)) break;
        request.contents.push({text:`The draft failed validation: ${recapExtraDraftProblems(draft,excerpt.duration).join(', ')}. Reobserve the burnt-in LOCAL clocks, not source or match clocks. Return only actual complete non-goal actions. Do not clamp or invent an end timestamp. Rejected draft: ${JSON.stringify(draft)}`});
      }
      if(!validRecapExtraDraft(draft,excerpt.duration)) throw new Error(`Additional-action draft still needs source-clock repair: ${recapExtraDraftProblems(draft,excerpt.duration).join(', ')}. Exact rejected observations and the source excerpt are saved.`);
      await writeFile(cache,JSON.stringify(draft));
    }
    return normalizeMoments(draft.moments,media.duration,excerpt.startTime)
      .map(scene=>({...scene,id:`extra-${index+1}-${scene.id}`,sourceAdditionalAction:true,
        sourceActionInventoryVersion:RECAP_ACTION_INVENTORY_VERSION}));
  });
  const extras=uniqueEvidenceCandidates(batches.flat());
  await writeFile(join(directory,"inventory.json"),JSON.stringify({version:RECAP_ACTION_INVENTORY_VERSION,
    candidateCount:extras.length,moments:extras},null,2));
  return extras;
}

async function discoverScoreAnchoredActions(sourcePath,media,id,anchors,attempt) {
  if(!anchors.length) return [];
  const directory=join(outputRoot,id,'score-action-observation');await mkdir(directory,{recursive:true});
  const fingerprint=await sourceContentFingerprint(sourcePath),ai=createGeminiClient();
  const observeAnchor=async anchor=>{
    const profile=scoreActionObservationProfile(anchor.endTime-anchor.startTime);
    const key=stableSignature({version:6,profile,fingerprint,model:process.env.GEMINI_MODEL,anchor,attempt});
    const cache=join(directory,`${key}.json`);let parsed;
    try {parsed=JSON.parse(await readFile(cache,'utf8'));} catch {}
    if (!validScoreActionDraft(parsed,anchor.endTime-anchor.startTime)) {
      for(const version of [5,4]) {
        const oldKey=stableSignature({version,profile,fingerprint,model:process.env.GEMINI_MODEL,anchor,attempt});
        try {
          const previous=JSON.parse(await readFile(join(directory,`${oldKey}.json`),'utf8'));
          if (validScoreActionDraft(previous,anchor.endTime-anchor.startTime)
            && hasCompleteLiveScoreCandidate(previous.moments,anchor,anchor.startTime)) {parsed=previous;break;}
        } catch { /* No complete live-source observation to reuse. */ }
      }
    }
    // A discovery sampling reduction must not discard paid, completed 4fps
    // observations of this exact source/window. They are still candidates,
    // and all independent source-outcome/portrait checks run afterwards.
    if(!validScoreActionDraft(parsed,anchor.endTime-anchor.startTime) && profile.fps===2) {
      const previousKey=stableSignature({version:4,profile:{...profile,fps:4},fingerprint,
        model:process.env.GEMINI_MODEL,anchor,attempt});
      try {
        const previous=JSON.parse(await readFile(join(directory,`${previousKey}.json`),'utf8'));
        if(validScoreActionDraft(previous,anchor.endTime-anchor.startTime)
          && hasCompleteLiveScoreCandidate(previous.moments,anchor,anchor.startTime)) parsed=previous;
      } catch { /* Replay-only drafts must be reobserved under the live-first policy. */ }
    }
    if(!validScoreActionDraft(parsed,anchor.endTime-anchor.startTime)) parsed=undefined;
    if(!parsed && anchor.endTime-anchor.startTime>40) {
      // Keep completed parent observations. New long searches use overlapping
      // bounded video windows, not one large multi-angle request that can wait
      // ten minutes. This does not cap the final action scene or its duration.
      const windows=scoreActionSearchWindows(anchor);
      const observed=[];
      for(const window of windows) {
        const scenes=await discoverScoreAnchoredActions(sourcePath,media,id,[window],attempt);
        observed.push(...scenes);
        // Do not buy later-window/replay observations after the selected live
        // candidate exists. Independent source verification still follows.
        if(hasCompleteLiveScoreCandidate(scenes,anchor)) break;
      }
      return observed;
    }
    if(!parsed) {
      const current=await readJob(id);await updateJob(current,'tracking',32,{
        progressDetail:`Locating complete source action for ${anchor.id} before scene lock (observation ${attempt}).`});
      const path=join(directory,`${key}.mp4`),duration=anchor.endTime-anchor.startTime;
      let ready=false;
      try {const info=await stat(path);ready=info.size>1024&&info.size<profile.maximumBytes;} catch {}
      if(!ready) await run(ffmpegPath,['-hide_banner','-loglevel','error','-y','-ss',String(anchor.startTime),'-i',sourcePath,
        '-t',String(duration),'-vf',`setpts=PTS-STARTPTS,fps=${profile.fps},scale=-2:${profile.height},${semanticReviewLabel(anchor.id)}`,
        '-an','-c:v','libx264','-preset','veryfast','-b:v',`${profile.bitrateKbps}k`,'-maxrate',`${profile.bitrateKbps}k`,
        '-bufsize',`${profile.bitrateKbps*2}k`,'-movflags','+faststart',path]);
      if((await stat(path)).size>profile.maximumBytes) throw new Error('Focused action preview exceeded its bounded upload size.');
      const prompt=[
        `Observe this ONE original football excerpt completely. Source ${anchor.startTime}-${anchor.endTime}s; duration ${duration}s. ALL returned scene times are excerpt-local, 0-${duration}. Read the LOCAL clock, not the match clock.`,
        anchor.partialSearch?'This is ONE overlapping subwindow of the same score-transition search. The score samples may be outside this subwindow. Return zero moments if the responsible incident has no complete clear view here; do not substitute another chance or force a goal. The same storyId applies across subwindows.':'',
        `Independent scorebug OCR saw ${anchor.before.homeGoals}-${anchor.before.awayGoals} near local ${(anchor.before.time-anchor.startTime).toFixed(1)}s, then ${anchor.after.homeGoals}-${anchor.after.awayGoals} near local ${(anchor.after.time-anchor.startTime).toFixed(1)}s.${anchor.status==='reversed'?` That score was later reversed near source ${anchor.reversalTime}s.`:''} These are search cues, NOT proof of a shot, scorer, team identity or ball coordinates.`,
        'The responsible LIVE goal must occur before that first changed-score sample. A later live goal cannot cause a score already shown earlier. If only a replay is present after that sample, label it as replay rather than a new live goal. Return zero moments for a different scoring incident.',
        'Find the scoring incident responsible for that transition. Select the FIRST clear COMPLETE LIVE view. Do not compare two or three repeated goal replays when the first live view already shows the action. Inspect the initiating pass/cross with player AND ball, receiving final shot/header, ball travel, goalkeeper/net and completed result. Start before the initiating touch; end after the real outcome. A genuine broadcast camera cut does not make a complete live action invalid: retain its ordered setup and finish. Only if this excerpt has no complete clear live view may ONE complete same-incident replay be selected; keep isReplay:true and explain the missing live evidence. Do not substitute an unrelated missed chance or invent a goal.',
        'A cross has TWO contacts: the initial passer release and the receiving finish. contactTime means the FINAL shot/header, flightStartTime can be the earlier cross release. Capture both players at their respective contact and do not jump directly to the goalkeeper.',
        'Return ONE complete primary action scene for this incident, not a replay backup. Optionally retain a short immediately related reaction after the visible result; no long VAR discussions, unrelated play or second/third repeated angle. This is source-scene splitting only: do not guess portrait coordinates or make the source interval shorter to fit an estimated voice script. No player or team names; identity is verified later.',
        footballObservationContract(),
        `Return JSON {moments:[...],uncertainties:[string]}. storyId is ${anchor.id}. Each moment requires startTime,endTime,eventType,storyPhase,keepDecision,actionComplete,completionReason,keyActionTimes,trackingBrief,importanceScore,confidence,ballVisible,mainPlayerVisible,isReplay,description,analysisPurpose. Allowed events goal|disallowed_goal|save|shot_on_target|shot_off_target|big_chance|celebration|var. Use source pixels for the actual outcome, not a desired score. trackingBrief times are excerpt-local, like scene boundaries.`,
        attempt>1?'Earlier observations did not yield complete verified live action. Reinspect the actual source at high detail, independently; do not repeat missing setup, an unobserved touch, an unresolved finish or out-of-bounds clock values.':''
      ].join(' ');
      parsed=(await generateGeminiJson(ai,{model:process.env.GEMINI_MODEL,contents:[footballVideoPart((await readFile(path)).toString('base64'),profile.fps),{text:prompt}],
        config:{responseMimeType:'application/json',responseJsonSchema:SCORE_ACTION_SCHEMA,thinkingConfig:{thinkingLevel:'LOW'},
          httpOptions:{timeout:geminiVideoDeadline(Math.max(360000,geminiRequestTimeoutMs),duration)}}},`Source action ${anchor.id}`,3)).parsed;
      if(!validScoreActionDraft(parsed,duration)) throw new Error(`Source action ${anchor.id} returned invalid scene bounds or confidence; not safe to lock.`);
      await writeFile(cache,JSON.stringify(parsed));
    }
    return normalizeMoments(parsed.moments,media.duration,anchor.startTime).map((scene,index)=>({...scene,
      id:`source-${anchor.id}-${Math.round(anchor.startTime*1000)}-${attempt}-${index+1}`,storyId:anchor.id,sourceScoreAnchorId:anchor.id,
      sourceScoreObservation:true,importanceScore:Math.max(90,scene.importanceScore)}));
  };
  const batches=[];
  for(const anchor of [...anchors].sort((a,b)=>a.after.time-b.after.time)) {
    // Dense highlight edits can show the next goal in the preceding search
    // window. Reuse that real source observation under its own score incident,
    // instead of sending the same overlapping pixels again. It is still only
    // a candidate; source semantics and outcome checks have not approved it.
    const existing=batches.flat().filter(scene=>scoreAnchorForScene(scene,{anchors})?.id===anchor.id);
    if(hasCompleteLiveScoreCandidate(existing,anchor)) continue;
    batches.push(await observeAnchor(anchor));
  }
  return batches.flat();
}

async function completedDurationSearchWindows(id,scope='gaps') {
  return completedRecoverySearchWindows(id,'action_duration',scope);
}
async function completedRecoverySearchWindows(id,purpose,scope='gaps') {
  const directory=join(outputRoot,id,'recovery-cache');
  const windows=[];
  for(const name of await readdir(directory).catch(()=>[])) {
    if(!name.endsWith('.json')) continue;
    try {
      const saved=JSON.parse(await readFile(join(directory,name),'utf8'));
      if([2,3,4].includes(saved.search?.version) && (saved.search.scope||'gaps')===scope && saved.search.purpose===purpose
        && saved.search.fps===8 && Array.isArray(saved.parsed?.moments)) windows.push(saved.search);
    } catch { /* Partial or older observations are not completed dense searches. */ }
  }
  return windows;
}

// A worker may stop after one paid excerpt succeeds but before its siblings
// finish. Restore those proposals BEFORE skipping completed search windows.
// This is discovery only: independent source/outcome review remains required.
async function restoreCompletedGoalCountCandidates(id,sourcePath,media,candidates) {
  const directory=join(outputRoot,id,'recovery-cache');
  const fingerprint=await sourceContentFingerprint(sourcePath),restored=[];
  for(const name of await readdir(directory).catch(()=>[])) {
    if(!name.endsWith('.json'))continue;
    try {
      const saved=JSON.parse(await readFile(join(directory,name),'utf8'));
      if(saved.search?.version!==4||saved.search.purpose!=='goal_count'||saved.search.fps!==8
        ||saved.search.sourceFingerprint!==fingerprint||saved.search.model!==geminiWorkloadModel('discovery')
        ||!Array.isArray(saved.parsed?.moments))continue;
      const drafts=normalizeMoments(saved.parsed.moments,media.duration,saved.search.startTime,
        new Set(candidates.map(scene=>scene.storyId)));
      restored.push(...drafts.filter(draft=>!candidates.some(scene=>scene.id===draft.id&&scene.semanticVerified!==undefined)));
    } catch { /* Incomplete/unrelated search caches are not source evidence. */ }
  }
  return restored;
}

async function discoverAdditionalCandidatesWithGemini(sourcePath, media, targetDuration, id, candidates, missingDuration, pass, highlightDeficiencies = [], recoveryWindows = [], expectedGoalTotal = null, purpose = 'incident_coverage', searchScope='gaps') {
  const ai = createGeminiClient();
  // Use bounded clips even for a duration shortfall. Sending the same long
  // proxy back to Gemini repeats the first-pass goal bias and overlooks brief
  // non-goal actions elsewhere in the match.
  const targeted = recoveryWindows.length > 0;
  const recoveryModel=purpose==='goal_count'?geminiWorkloadModel('discovery'):process.env.GEMINI_MODEL;
  const recoveryFps=targeted && (purpose==='action_duration'||purpose==='goal_count') ? 8 : analysisFps;
  const recoveryProxies = targeted
    ? await createRecoveryProxies(sourcePath, media, id, recoveryWindows, recoveryFps)
    : await createAnalysisProxies(sourcePath, media, id);
  const sourceInfo = await stat(sourcePath);
  const recoverySourceFingerprint = await sourceContentFingerprint(sourcePath);
  const recoveryCacheDirectory = join(outputRoot, id, "recovery-cache");
  await mkdir(recoveryCacheDirectory, { recursive: true });
  const requestedPerExcerpt = Math.max(MIN_SCENE_SECONDS * 2, Math.ceil(missingDuration * 1.5 / Math.max(1, recoveryProxies.length)));
  const recoveredBatches = await mapWithConcurrency(recoveryProxies, 2, async (excerpt, index) => {
    const currentJob = await readJob(id);
    await updateJob(currentJob, currentJob.stage, currentJob.progress, { progressDetail: `Rechecking ${targeted ? "targeted " : ""}source excerpt ${index + 1} of ${recoveryProxies.length}, recovery pass ${pass}. Existing incident tracking is retained.` });
    const excerptEnd = excerpt.startTime + excerpt.duration;
    const priorTimeline = candidates
      .filter((moment) => moment.endTime > excerpt.startTime && moment.startTime < excerptEnd)
      .map((moment) => ({
        startTime: Math.max(0, moment.startTime - excerpt.startTime),
        endTime: Math.min(excerpt.duration, moment.endTime - excerpt.startTime),
        eventType: moment.eventType,
        storyId: moment.storyId,
        storyPhase: moment.storyPhase,
        result: coverageCandidateState(moment),
        reason: moment.trackingDecision || moment.rejectReason || "first_pass",
      }));
    const prompt = [
      `This is football discovery pass ${pass}. The current minimum planning coverage is ${targetDuration} seconds, and ${missingDuration.toFixed(1)} more verified seconds are still needed. Find complete strong actions; do not stop observing once that minimum is covered.`,
      `Goal-first completeness problems still to solve: ${highlightDeficiencies.length ? highlightDeficiencies.join(", ") : "none"}.`,
      `Re-inspect excerpt ${index + 1} of ${recoveryProxies.length}, source ${excerpt.startTime.toFixed(3)}-${(excerpt.startTime + excerpt.duration).toFixed(3)}s, from beginning to end. Return timestamps RELATIVE to this ${excerpt.duration.toFixed(3)}-second excerpt.`,
      purpose==='goal_count'
        ? 'This pass resolves missing goal evidence, not duration. Return only missing or corrected goal incidents and their immediate matching reactions. Prior non-goal classifications are not conclusive for this wider source context: inspect a rebound or delayed payoff when a previous short save/chance omitted it. Return zero moments if there is no new visible goal; never relabel a miss or save as a goal.'
        : `Find at least ${requestedPerExcerpt} seconds of ADDITIONAL complete actions at their natural duration when visibly available. Return only new or corrected candidates; do not duplicate intervals already marked verified.`,
      searchScope==='source_shots'?'This is a complete measured source camera shot, not a gap between old short clips. Check its earliest meaningful pass through the resolved outcome. If an earlier proposal omitted the initiating pass, return a corrected complete action with the same story identity for independent source review, not a second copy or replay.': '',
      "Revisit rejected intervals intelligently. There is no fixed scene-length limit. Split only at a true broadcast cut, possession reset, whistle, replay boundary, or completed consequence. Never cut through an active pass, shot, save, duel, or run.",
      "For ball_not_visibly_continuous or insufficient_joint_framing, find a different source angle or nearby complete action where the ball and involved player stay visible together. For unstable_camera, choose a naturally stable broadcast passage; do not hide shaking by shortening an unfinished action.",
      purpose==='action_duration'
        ? 'All observed goals already have complete source action. Find distinct complete football gameplay: shots, saves, blocks, clearances, dangerous combinations and defended attacks. Preserve the meaningful buildup through the completed consequence. Do NOT return celebrations, full-time reactions, statistics, long VAR discussions or duplicate goal replays to fill the duration. Return zero moments when this excerpt has no new complete action.'
        : 'Find the first complete LIVE view of each missing incident, with initiating pass, final contact, ball flight and resolved result. Keep one complete source view, not mandatory second or third repeated replays. A genuine replay is eligible only when no complete live view is present; label it as replay of the same story. Optional short matching reactions cannot substitute for the action.',
      footballObservationContract(),
      "Return JSON only as {moments:[...],overlayMasks:[]}. Every moment requires startTime, endTime, eventType, storyId, storyPhase, keepDecision, actionComplete, completionReason, keyActionTimes, trackingBrief, importanceScore, hookScore, flowScore, visualClarity, excitementScore, narrativeCompleteness, description, rejectReason, confidence, ballVisible, mainPlayerVisible, isReplay, commentary, analysisPurpose, onScreenText, and focusX.",
      "Use eventType goal|disallowed_goal|offside|penalty|assist|big_chance|shot_on_target|shot_off_target|save|foul|yellow_card|red_card|free_kick|var|skill|dribble|tackle|celebration|normal_play. Mark only a fully resolved action as keep, support, or replay. Do not invent identities, scores, or outcomes.",
    ].join(" ");
    const recoveryKey = stableSignature({version:1,searchScope,model:recoveryModel,
      sourcePath,sourceFingerprint:recoverySourceFingerprint,
      start:excerpt.startTime,duration:excerpt.duration,fps:recoveryFps,prompt,priorTimeline});
    const recoveryCachePath = join(recoveryCacheDirectory, `${recoveryKey}.json`);
    let parsed;
    try {
      const saved = JSON.parse(await readFile(recoveryCachePath, "utf8"));
      if (saved.key === recoveryKey && Array.isArray(saved.parsed?.moments)) parsed = saved.parsed;
    } catch { /* Only completed matching excerpts can be restored. */ }
    if(!parsed && purpose!=='action_duration' && purpose!=='goal_count' && recoveryFps!==analysisFps) {
      const previousKey=stableSignature({version:1,model:process.env.GEMINI_MODEL,
        sourcePath,size:sourceInfo.size,modified:sourceInfo.mtimeMs,
        start:excerpt.startTime,duration:excerpt.duration,fps:analysisFps,prompt,priorTimeline});
      try {
        const saved=JSON.parse(await readFile(join(recoveryCacheDirectory,`${previousKey}.json`),'utf8'));
        if(saved.key===previousKey && Array.isArray(saved.parsed?.moments)) parsed=saved.parsed;
      } catch {}
    }
    if (!parsed) {
      const proxy = await readFile(excerpt.path);
      const generated = await generateGeminiJson(ai, {
        model: recoveryModel,
        contents: [
          footballVideoPart(proxy.toString("base64"), recoveryFps),
          { text: prompt },
          { text: JSON.stringify({ priorCandidateResults: priorTimeline }) },
        ],
        config: { responseMimeType: "application/json", temperature: 0.08,
          httpOptions: {timeout:geminiVideoDeadline(geminiRequestTimeoutMs, excerpt.duration)} },
      }, `Gemini goal-first discovery excerpt ${index + 1}`);
      parsed = generated.parsed;
      // A later provider wait or worker restart must not discard paid results
      // from earlier recovery windows and make the user repeat discovery.
      await writeFile(recoveryCachePath, JSON.stringify({key:recoveryKey,parsed}));
    }
    await writeFile(recoveryCachePath, JSON.stringify({key:recoveryKey,parsed,
      search:{version:4,purpose,scope:searchScope,fps:recoveryFps,startTime:excerpt.startTime,endTime:excerptEnd,
        sourceFingerprint:recoverySourceFingerprint,model:recoveryModel}}));
    return filterUnprovedRecoveryGoals(candidates,
      normalizeMoments(parsed.moments, media.duration, excerpt.startTime, new Set(candidates.map(moment => moment.storyId)))
        .filter(scene=>purpose!=='action_duration' || isDurationRecoveryAction(scene)),
      expectedGoalTotal);
  });
  return mergeAnalyzedMoments([...candidates, ...recoveredBatches.flat()]);
}

async function createRecoveryProxies(sourcePath, media, id, windows, fps = analysisFps) {
  const directory = join(outputRoot, id, "recovery-proxies");
  await mkdir(directory, { recursive: true });
  const bounded = boundedRecoveryWindows(windows, media.duration);
  return mapWithConcurrency(bounded, Math.min(analysisProxyConcurrency, 3), async (window) => {
    const duration = window.endTime - window.startTime;
    const path = join(directory, `recovery-${Math.round(window.startTime * 1000)}-${Math.round(window.endTime * 1000)}-${fps}fps.mp4`);
    let info;
    try { info = await stat(path); } catch { /* Generate this focused clip. */ }
    if (!info || info.size < 1024 || info.size > 15 * 1024 * 1024) {
      const args = ["-hide_banner", "-y", "-ss", window.startTime.toFixed(3), "-i", sourcePath,
        "-t", duration.toFixed(3), "-vf", `fps=${fps}:start_time=0:round=up,scale=-2:${analysisHeight}`,
        "-c:v", "libx264", "-preset", "veryfast", "-b:v", "850k", "-maxrate", "850k", "-bufsize", "1700k", "-pix_fmt", "yuv420p"];
      if (media.hasAudio) args.push("-c:a", "aac", "-b:a", "32k", "-ac", "1", "-ar", "16000");
      else args.push("-an");
      args.push("-movflags", "+faststart", path);
      await run(ffmpegPath, args);
      info = await stat(path);
    }
    if (info.size > 15 * 1024 * 1024) throw new Error("A focused Gemini recovery excerpt exceeds the inline upload limit.");
    return { path, startTime: window.startTime, duration };
  });
}

function buildAnalysisPrompt(targetDuration, excerpt, chunkNumber, chunkCount, hasVideoIntelligence = false) {
  const excerptEvidenceBudget = Math.max(MIN_SCENE_SECONDS * 2, Math.ceil(targetDuration * 1.5 / Math.max(1, chunkCount)));
  return [
    `You are the first-pass football video analyst for a professional short-form editor. Analyze every visible scene and all audio in excerpt ${chunkNumber} of ${chunkCount}.`,
    `This excerpt starts at source time ${excerpt.startTime.toFixed(3)} seconds and lasts ${excerpt.duration.toFixed(3)} seconds. Return all startTime and endTime values RELATIVE TO THIS EXCERPT, beginning at zero.`,
    `The initial coverage budget is ${targetDuration} seconds, not a limit on observation or a final edit deadline. Do not select the edit yet: return ALL strong complete goals, shots, saves and relevant actions throughout this excerpt, with at least ${excerptEvidenceBudget} seconds of non-rejected complete actions when supported. A later director chooses the natural story length after whole-video verification.`,
    "Treat confirmed goals as the highest-priority evidence, followed by shots on target, shots off target, saves, blocks, clearances, and clear big chances. Around every goal, return separate but linked candidates for live scoring action, immediate celebration, and genuine replay proof, all with the exact same storyId. A replay must start at a real broadcast cut, occupy a different non-overlapping source interval, and show a visibly different camera viewpoint; never relabel or duplicate the live action.",
    "For a goal action, contactTime is the scorer's decisive touch; primaryPlayerRole is scorer; annotationStartTime begins roughly one second before that touch. Do not use the earlier passer as the highlighted scorer. Preserve ball flight and the goalkeeper or goalmouth result before ending the action.",
    "Return every viable complete player-and-ball action in this excerpt, not only the highest-scoring highlight and not only one scene per incident.",
    footballObservationContract(),
    "Return JSON only with top-level moments and overlayMasks arrays.",
    "For moments, let duration follow the complete football action; there is no fixed per-scene duration. Start before the initiating touch, run, pass, dribble, or defensive movement; include decisive contact; and end only after the shot, save, goal, turnover, whistle, replay conclusion, or reaction resolves. Use a new scene only at a possession reset, broadcast cut, replay cut, whistle, or completed consequence. Include useful context and explicitly identify weak footage.",
    "Every moment must contain: startTime, endTime, eventType (goal|disallowed_goal|offside|penalty|assist|big_chance|shot_on_target|shot_off_target|save|foul|yellow_card|red_card|free_kick|var|skill|dribble|tackle|celebration|normal_play), storyId, storyPhase (hook|build_up|action|payoff|reaction|replay|standalone), keepDecision (keep|support|replay|reject), actionComplete boolean, completionReason, keyActionTimes as an ordered array of {time,detail}, trackingBrief, importanceScore 0-100, hookScore 0-100, flowScore 0-100, visualClarity 0-100, excitementScore 0-100, narrativeCompleteness 0-100, description, rejectReason, confidence 0-1, ballVisible, mainPlayerVisible, isReplay, commentary, analysisPurpose, onScreenText, and focusX 0-1.",
    "Prefer complete actions with a few seconds of context. Do not merge unrelated events. Do not discard replays; label them so the edit director can decide. Mark obstructed, static, duplicate, irrelevant, or unclear footage as reject.",
    "Never invent names, teams, scores, or events. Commentary must be one short evidence-based analytical sentence that adds explanation, criticism, or meaning rather than merely announcing what happens. analysisPurpose must state why this exact excerpt is needed. onScreenText must be a clean 2-to-6-word hook, never a paragraph.",
    "Before contact, require the initiating player and ball in the original composition. During flight follow the real moving ball toward the receiver or goalmouth; the original passer/shooter may leave the frame naturally. Player-only running cannot substitute for action. Preserve every distinct visible goal and disallowed goal regardless of estimated duration or portrait framing difficulty. A VAR monitor or referee shot is brief supporting decision evidence, never a replacement for its scoring action.",
    hasVideoIntelligence ? "Use the supplied shot boundaries and tracked-object coordinates to improve temporal precision and horizontal focus, while trusting the visible video over an incorrect generic object label." : "",
    "Detect persistent creator logos, channel badges, attribution watermarks, and broadcast score/header graphics (scoreline, game clock, UEFA/network header). Return each as overlayMasks entries with source-normalized x, y, width, height, and confidence. Mask only the tight persistent overlay region; never mask players, the ball, goalmouth action, or the main pitch.",
  ].filter(Boolean).join(" ");
}

function buildAnalysisRecoveryPrompt(excerpt, chunkNumber, chunkCount, targetDuration) {
  return [
    `Re-inspect football excerpt ${chunkNumber} of ${chunkCount}. The previous response contained no usable moments.`,
    `The excerpt duration is ${excerpt.duration.toFixed(3)} seconds. Return startTime and endTime as JSON numbers in seconds RELATIVE to this excerpt, from 0 through ${excerpt.duration.toFixed(3)}. Never use HH:MM:SS strings.`,
    `The initial minimum coverage budget is ${targetDuration} seconds; final length will be planned later. Return JSON only as {moments:[...],overlayMasks:[]}. If football is visible, return every distinct complete action scene at its natural duration so the whole source can supply enough verified evidence. Include weak, incomplete, obstructed, or untrackable scenes with keepDecision reject instead of returning an empty array.`,
    footballObservationContract(),
    "Every moment requires startTime, endTime, eventType, storyId, storyPhase, keepDecision, actionComplete, completionReason, keyActionTimes, trackingBrief, importanceScore, hookScore, flowScore, visualClarity, excitementScore, narrativeCompleteness, description, rejectReason, confidence, ballVisible, mainPlayerVisible, isReplay, commentary, analysisPurpose, onScreenText, and focusX. Also return tight source-normalized overlayMasks for persistent creator/channel logos, attribution watermarks, scorebugs, game clocks, or network headers; never mask the players, ball, goalmouth action, or pitch.",
    "Use eventType goal|disallowed_goal|offside|penalty|assist|big_chance|shot_on_target|shot_off_target|save|foul|yellow_card|red_card|free_kick|var|skill|dribble|tackle|celebration|normal_play. Do not invent identities, scores, or outcomes. Commentary must explain only visible evidence.",
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

async function createAnalysisProxies(sourcePath, media, id,chunkSeconds=analysisChunkSeconds,labelPrefix="",overlapSeconds=analysisChunkOverlap,proxyFps=analysisFps) {
  const directory = join(outputRoot, id, "analysis");
  await mkdir(directory, { recursive: true });
  const tasks = analysisProxyWindows(media.duration, chunkSeconds, overlapSeconds)
    .map((window, index) => ({ ...window, index }));
  return mapWithConcurrency(tasks, analysisProxyConcurrency, async ({ startTime, duration, index }) => {
    const proxyPath = join(
      directory,
      `video-proxy-${String(index + 1).padStart(3, "0")}-${Math.round(startTime * 1000)}-${Math.round(duration * 1000)}${labelPrefix?`-${labelPrefix}`:""}-fps${proxyFps}-h${analysisHeight}.mp4`,
    );
    const targetBytes = 13.5 * 1024 * 1024;
    const totalKbps = targetBytes * 8 / Math.max(1, duration) / 1000;
    const videoKbps = Math.round(clamp(totalKbps - (media.hasAudio ? 36 : 0), 140, 900));
    const args = [
      "-hide_banner", "-y", "-ss", startTime.toFixed(3), "-i", sourcePath, "-t", duration.toFixed(3),
      "-vf", `fps=${proxyFps},scale=-2:${analysisHeight}${labelPrefix?`,${semanticReviewLabel(`${labelPrefix}-${index+1}`)}`:""}`,
      "-c:v", "libx264", "-preset", "veryfast", "-b:v", `${videoKbps}k`, "-maxrate", `${videoKbps}k`, "-bufsize", `${videoKbps * 2}k`, "-pix_fmt", "yuv420p",
    ];
    if (media.hasAudio) args.push("-c:a", "aac", "-b:a", "32k", "-ac", "1", "-ar", "16000");
    else args.push("-an");
    args.push("-movflags", "+faststart", proxyPath);
    let info;
    try { info = await stat(proxyPath); } catch { /* Create a missing analysis proxy. */ }
    if (!info || info.size < 1024 || info.size > 15 * 1024 * 1024) {
      await run(ffmpegPath, args);
      info = await stat(proxyPath);
    }
    if (info.size > 15 * 1024 * 1024) throw new Error(`Gemini analysis excerpt ${index + 1} exceeds the safe inline upload limit.`);
    return { path: proxyPath, startTime, duration };
  });
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
    actionComplete: moment.actionComplete,
    completionReason: moment.completionReason,
    keyActionTimes: moment.keyActionTimes,
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
    trackingBrief: moment.trackingBrief,
    videoIntelligence: moment.videoIntelligence,
    semanticNarrationFacts: moment.semanticNarrationFacts,
  }));
}

function synthesizeMissingGoalReactions(candidates, sourceDuration) {
  const source = Array.isArray(candidates) ? candidates.map((moment) => ({ ...moment })) : [];
  const ids = new Set(source.map((moment) => String(moment.id)));
  const additions = [];
  for (const goal of verifiedLiveGoalActions(source)) {
    const hasReaction = source.some((moment) => moment.keepDecision !== "reject"
      && moment.storyId === goal.storyId
      && (moment.eventType === "celebration" || moment.storyPhase === "reaction"));
    if (hasReaction) continue;
    const id = `${goal.id}--reaction`;
    const startTime = Math.min(Number(sourceDuration), Number(goal.endTime));
    const endTime = Math.min(Number(sourceDuration), startTime + 7);
    if (ids.has(id) || endTime - startTime < 2) continue;
    const occupiedBySelectedScene = source.some((moment) => moment.id !== goal.id
      && moment.keepDecision !== "reject"
      && Math.max(0, Math.min(endTime, Number(moment.endTime)) - Math.max(startTime, Number(moment.startTime))) >= 2);
    if (occupiedBySelectedScene) continue;
    const lastCrop = Array.isArray(goal.recommendedCrop) ? goal.recommendedCrop.at(-1) : undefined;
    additions.push({
      ...goal,
      id,
      startTime,
      endTime,
      eventType: "celebration",
      storyPhase: "reaction",
      keepDecision: "support",
      selectionLocked: false,
      selectionDecision: undefined,
      selectionKeepDecision: undefined,
      fallbackPresentation: undefined,
      portraitRepairReason: undefined,
      isReplay: false,
      actionComplete: true,
      completionReason: "candidate reaction window immediately following a verified live goal",
      description: "Immediate post-goal reaction window; visual semantic verification must confirm celebration before use.",
      analysisPurpose: "same-goal emotional payoff",
      ballVisible: false,
      mainPlayerVisible: true,
      recommendedCrop: [{ time: startTime, x: clamp(Number(lastCrop?.x ?? 0.5), 0, 1), y: 0.5, confidence: 0.72 }],
      selectedForFinalVideo: false,
      trackingDecision: undefined,
      semanticVerificationVersion: undefined,
      semanticVerified: undefined,
      trackingBrief: {
        ...goal.trackingBrief,
        primaryPlayerRole: "celebration_player",
        cameraMode: "reaction",
        payoffTarget: "celebration",
        originTime: startTime,
        contactTime: startTime + Math.min(1, (endTime - startTime) / 3),
        flightStartTime: startTime,
        handoffTime: startTime,
        payoffStartTime: startTime,
        payoffEndTime: endTime,
        annotationStartTime: startTime,
        annotationEndTime: Math.min(endTime, startTime + 1.5),
        requiredSubjectsByPhase: [{ phase: "reaction", subjects: ["celebration_player"] }],
      },
    });
    ids.add(id);
  }
  return { candidates: [...source, ...additions], additions };
}

export function orphanGoalReactionStories(candidates) {
  const source = Array.isArray(candidates) ? candidates : [];
  const verifiedGoalStories = new Set(source
    .filter((moment) => moment?.semanticVerified !== false
      && moment?.keepDecision !== "reject"
      && ["goal", "disallowed_goal"].includes(String(moment?.eventType)))
    .map((moment) => String(moment?.storyId || moment?.id || "")));
  const seen = new Set();
  return source.flatMap((moment) => {
    const reaction = moment?.eventType === "celebration" || moment?.storyPhase === "reaction";
    const storyId = String(moment?.storyId || moment?.id || "");
    const semanticText = [moment?.description, moment?.completionReason, JSON.stringify(moment?.semanticNarrationFacts || {})]
      .filter(Boolean).join(" ");
    const explicitlyPostGoal = /\b(?:goal|scor(?:e|ed|ing)|equalis(?:e|ed|er)|equaliz(?:e|ed|er)|back of (?:the )?net)\b/i.test(semanticText);
    if (!reaction || moment?.semanticVerified === false || moment?.keepDecision === "reject"
      || !explicitlyPostGoal || verifiedGoalStories.has(storyId) || seen.has(storyId)) return [];
    seen.add(storyId);
    return [{ storyId, reactionId: String(moment?.id || storyId), startTime: Number(moment?.startTime || 0) }];
  });
}

export function suspiciousLateGoalReplays(candidates, minimumGapSeconds = 25) {
  const source = (Array.isArray(candidates) ? candidates : []).filter((moment) => moment?.semanticVerified !== false
    && moment?.keepDecision !== "reject" && moment?.eventType === "goal");
  const liveByStory = new Map();
  for (const moment of source) {
    if (moment?.isReplay || moment?.storyPhase === "replay") continue;
    const storyId = String(moment?.storyId || moment?.id || "");
    const existing = liveByStory.get(storyId);
    if (!existing || Number(moment.startTime) < Number(existing.startTime)) liveByStory.set(storyId, moment);
  }
  return source.flatMap((replay) => {
    if (!(replay?.isReplay || replay?.storyPhase === "replay")) return [];
    const live = liveByStory.get(String(replay?.storyId || replay?.id || ""));
    if (!live) return [];
    const gap = Number(replay.startTime) - Number(live.endTime);
    return Number.isFinite(gap) && gap > minimumGapSeconds
      ? [{ replayId: String(replay.id), replayStart: Number(replay.startTime), liveGoalId: String(live.id), gap }]
      : [];
  });
}

function mergeTrackingResults(base, partial) {
  return {
    version: Math.max(Number(base?.version || 0), Number(partial?.version || 0), 71),
    moments: { ...(base?.moments || {}), ...(partial?.moments || {}) },
    markerPaths: { ...(base?.markerPaths || {}), ...(partial?.markerPaths || {}) },
    summary: summarizeTracking({ ...(base?.moments || {}), ...(partial?.moments || {}) }),
  };
}

function trackingEvidenceQuality(scene, evidence, nativeLandscape = false) {
  if (!evidence) return Number.NEGATIVE_INFINITY;
  const assessment = nativeLandscape ? assessNativeFrameAction(scene, evidence) : assessPlannedSceneTracking(scene, evidence);
  const phase = evidence.phaseEvidence?.version === 1 ? evidence.phaseEvidence : {};
  const phaseScore = Number(phase.setup?.directJointCoverage || 0) * 20
    + Number(phase.contact?.directJointCoverage || 0) * 30
    + Math.max(Number(phase.flight?.directBallCoverage || 0), Number(phase.flight?.payoffCoverage || 0)) * 20
    + Math.max(Number(phase.payoff?.ballCoverage || 0), Number(phase.payoff?.payoffCoverage || 0)) * 20;
  const coverageScore = Number(evidence.ballDetectionCoverage || 0) * 12
    + Number(evidence.jointFitCoverage || 0) * 10
    + Number(evidence.subjectLockCoverage || 0) * 8
    + Number(evidence.goalPayoffCoverage || 0) * 12
    + Number(evidence.centralCompositionCoverage || 0) * 16;
  const motionPenalty = Number(evidence.cameraStepP95 || 0) * 20 + Number(evidence.cameraJerkP95 || 0) * 30;
  return (assessment.usable ? 1000 : 0) + phaseScore + coverageScore - motionPenalty;
}

function fullBleedRepairEvidence(scene, evidence, media) {
  // Never overwrite reviewed Gemini positions with local detector repair.
  if (evidence?.provider === "gemini-vision") return evidence;
  if (isDecisionScene(scene)) return repairDecisionFraming(scene, evidence, media);
  const duration = Math.max(0.1, Number(scene.endTime) - Number(scene.startTime));
  const sourceRatio = Number(media?.width || 16) / Math.max(1, Number(media?.height || 9));
  // A genuine full-bleed 9:16 crop. No padding, blurred fill, or smaller
  // landscape window is permitted for gameplay scenes.
  const viewWidth = Math.min(1, (outputWidth / outputHeight) / sourceRatio);
  const half = viewWidth / 2;
  const records = Array.isArray(evidence?.sourceRecords) ? evidence.sourceRecords : [];
  const semanticX = Number(scene.focusX ?? scene.recommendedCrop?.[0]?.x ?? 0.5);
  const fallback = clamp((Number.isFinite(semanticX) ? semanticX : .5) * .35 + .5 * .65, half, 1 - half);
  const goalValue = Number(scene.trackingBrief?.goalFocusX);
  const goal = Number.isFinite(goalValue) ? clamp(goalValue, half, 1 - half) : fallback;
  const flightAbsolute = Number(scene.trackingBrief?.flightStartTime);
  const flight = Number.isFinite(flightAbsolute)
    ? clamp(flightAbsolute - Number(scene.startTime), 0, duration)
    : duration * 0.52;
  const contactAbsolute = Number(scene.trackingBrief?.contactTime);
  const contact = Number.isFinite(contactAbsolute)
    ? clamp(contactAbsolute - Number(scene.startTime), 0, duration)
    : flight;
  const payoffAbsolute = Number(scene.trackingBrief?.payoffEvidence?.startTime);
  const payoffStart = Number.isFinite(payoffAbsolute)
    ? clamp(payoffAbsolute - Number(scene.startTime), contact, duration)
    : Math.min(duration, contact + .75);
  const verifiedGoalRoute = scene.eventType === "goal"
    && scene.semanticVerified === true && scene.actionComplete === true
    && Number.isFinite(goalValue);
  const median = (values) => {
    const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const contactBallX = median(records.filter((record) => record.direct_ball === true
      && Math.abs(Number(record.time) - contact) <= .32).map((record) => Number(record.ball_x)));
  const earlyFlightBallX = median(records.filter((record) => record.direct_ball === true
      && Number(record.time) >= contact + .20 && Number(record.time) <= Math.min(payoffStart, contact + 1.15))
    .map((record) => Number(record.ball_x)));
  const semanticRouteConflict = verifiedGoalRoute
    && Number.isFinite(contactBallX) && Number.isFinite(earlyFlightBallX)
    && Math.abs(earlyFlightBallX - contactBallX) >= .045
    && (earlyFlightBallX - contactBallX) * (goal - contactBallX) < 0;
  const existing = Array.isArray(evidence?.keyframes) ? evidence.keyframes : [];
  const rebuilt = records.length >= 2 && records.length === existing.length
    ? (() => {
        let carriedTarget = fallback;
        let carriedTrackId = null;
        let pendingTrackId = null;
        let pendingTrackHits = 0;
        let lastDirectBallTime = Number.NEGATIVE_INFINITY;
        let lastDirectBall = null;
        const finite = value => value !== null && value !== "" && Number.isFinite(Number(value));
        const planned = records.map((record, index) => {
          const frame = existing[index] || {};
          const phase = String(record.action_phase || frame.actionPhase || "setup");
          const ball = Number(record.ball_x);
          const ballY = Number(record.ball_y);
          const rawDirectBall = finite(record.ball_x) && finite(record.ball_y) && record.direct_ball === true;
          const players = (Array.isArray(record.players) ? record.players : []).filter(player =>
            Number(player.pitchSupport || 0) >= .08 && finite(player.x1) && finite(player.x2)
            && finite(player.y2) && Number(player.x1) < Number(player.x2));
          const nearestRawPlayer = rawDirectBall && players.length
            ? players.map(player => ({ player, distance: Math.hypot(Number(player.cx) - ball, (Number(player.y2) - ballY) * .85) }))
              .sort((a, b) => a.distance - b.distance)[0]
            : null;
          const dominantPlayer = players
            .map(player => ({ player, area: (Number(player.x2) - Number(player.x1)) * (Number(player.y2) - Number(player.y1)) }))
            .sort((a, b) => b.area - a.area)[0];
          // Close-up restarts frequently contain a large goalkeeper/carrier and
          // a weak false sports-ball hit on a crest, logo or crowd detail. Such
          // an isolated hit must not drag the portrait crop onto empty grass.
          // A weak ball remains valid when it is spatially linked to a player.
          const isolatedWeakBall = rawDirectBall
            && (phase === "setup" || phase === "contact")
            && Number(record.ball_confidence || 0) < .30
            && (!nearestRawPlayer || nearestRawPlayer.distance > .22)
            && Number(dominantPlayer?.area || 0) >= .12;
          const directBall = rawDirectBall && !isolatedWeakBall;
          if (directBall) {
            lastDirectBallTime = Number(record.time);
            lastDirectBall = [ball, ballY];
          }
          // Predicted guidance is useful only briefly after a real observation.
          // An old trajectory must never become a new player association.
          const guidedBall = finite(record.ball_x) && finite(record.ball_y)
            && record.ball_guidance === true
            && Number(record.time) - lastDirectBallTime <= .40
            && (!lastDirectBall || Math.hypot(ball - lastDirectBall[0], (ballY - lastDirectBall[1]) * .85) <= .20);
          const hasBall = (directBall || guidedBall)
            && !(semanticRouteConflict && Number(record.time) >= contact + .16);
          const linkedPlayer = directBall && players.length
            ? players.map(player => ({ player, distance: Math.hypot(Number(player.cx) - ball, (Number(player.y2) - ballY) * .85) }))
              .sort((a, b) => a.distance - b.distance)[0]
            : null;
          if (record.scene_cut === true) {
            carriedTrackId = pendingTrackId = null;
            pendingTrackHits = 0;
          }
          let player = carriedTrackId === null ? null : players.find(candidate => candidate.trackId === carriedTrackId);
          const incumbentDistance = player && hasBall
            ? Math.hypot(Number(player.cx) - ball, (Number(player.y2) - ballY) * .85)
            : 1;
          if (linkedPlayer && linkedPlayer.distance <= .16) {
            if (carriedTrackId === null) {
              carriedTrackId = linkedPlayer.player.trackId;
              player = linkedPlayer.player;
            } else if (linkedPlayer.player.trackId === carriedTrackId) {
              player = linkedPlayer.player;
              pendingTrackId = null;
              pendingTrackHits = 0;
            } else if (!player || incumbentDistance > .18
                || linkedPlayer.distance + .035 < incumbentDistance) {
              pendingTrackHits = linkedPlayer.player.trackId === pendingTrackId ? pendingTrackHits + 1 : 1;
              pendingTrackId = linkedPlayer.player.trackId;
              // During ball flight the old carrier must not keep ownership
              // after a directly observed receiver has reached the ball. A
              // three-sample wait made the portrait crop trail the pass by
              // roughly half a second and show the previous player/empty
              // grass. Direct ball proximity is the hand-off evidence here.
              const verifiedFlightHandoff = phase === "flight"
                && directBall && linkedPlayer.distance <= .13 && incumbentDistance > .18;
              if (pendingTrackHits >= 3 || !player || verifiedFlightHandoff) {
                carriedTrackId = linkedPlayer.player.trackId;
                player = linkedPlayer.player;
                pendingTrackId = null;
                pendingTrackHits = 0;
              }
            }
          }
          // A player is a camera subject only while actually linked to the
          // observed ball. Do not retain a stale person through a pass, an
          // occlusion, or a tracker-ID change: the ball owns those frames.
          const playerBallDistance = player && hasBall
            ? Math.hypot(Number(player.cx) - ball, (Number(player.y2) - ballY) * .85)
            : 1;
          if (!player || !hasBall || playerBallDistance > .18) player = null;
          const playerLeft = Number(player?.x1);
          const playerRight = Number(player?.x2);
          const hasPlayer = Boolean(player) && finite(player?.x1) && finite(player?.x2) && playerLeft < playerRight;
          const edge = Math.min(.035, viewWidth * .11);
          const pairSpan = hasBall && hasPlayer ? Math.max(ball, playerRight) - Math.min(ball, playerLeft) : 1;
          const pairFits = hasBall && hasPlayer && pairSpan <= viewWidth;
          if (record.scene_cut === true && finite(record.camera_target_x)) {
            carriedTarget = clamp(Number(record.camera_target_x), half, 1 - half);
          }
          const cameraOwner = pairFits ? "carrier"
            : hasBall ? "ball"
              : (phase === "setup" || phase === "contact") ? "hold"
                : (phase === "payoff" && (Number.isFinite(goalValue) || Array.isArray(record.payoff_box))) ? "payoff" : "hold";
          const payoff = Array.isArray(record.payoff_box) && record.payoff_box.length === 4 ? record.payoff_box : null;
          let target = carriedTarget;
          let low = half, high = 1 - half;
          // `low/high` are the editorial safe zone used to start a gentle
          // predictive pan. `hardLow/hardHigh` are only the last-resort
          // visibility limits. Keeping them separate prevents the per-frame
          // verifier from turning every small detector movement into a shake.
          let hardLow = half, hardHigh = 1 - half;
          if (phase !== "payoff" && cameraOwner === "carrier") {
            // Carrier ownership lasts through contact. Never abandon that
            // player to chase a guided/false ball before the kick completes.
            // The same joint framing is also required when a verified
            // receiver takes possession during flight.
            if (pairFits) {
              const left = Math.min(ball, playerLeft), right = Math.max(ball, playerRight);
              // Keep a real breathing margin around the complete player+ball
              // span. A narrow margin lets the ball look centered while the
              // carrier's body is clipped at the portrait edge.
              const preferredEdge = Math.min(.075, viewWidth * .24);
              let margin = pairSpan + preferredEdge * 2 <= viewWidth ? preferredEdge : 0;
              low = Math.max(half, right + margin - half);
              high = Math.min(1 - half, left - margin + half);
              if (low > high) { low = Math.max(half, right - half); high = Math.min(1 - half, left + half); }
              const hardEdge = Math.min(.012, viewWidth * .04);
              hardLow = Math.max(half, right + hardEdge - half);
              hardHigh = Math.min(1 - half, left - hardEdge + half);
              if (hardLow > hardHigh) {
                hardLow = Math.max(half, right - half);
                hardHigh = Math.min(1 - half, left + half);
              }
              // Position keyframes belong to the complete action pair. Do not
              // bias toward the ball alone: that is what previously produced
              // crops with a visible ball and only half of the active player.
              // Center the full player+ball span so both remain readable.
              target = (left + right) / 2;
              target = clamp(target, low, high);
            }
          } else if (hasBall && (phase === "payoff"
              || (phase === "flight" && Math.abs(ball - goal) <= viewWidth * .30))
              && Number(record.time) >= payoffStart && Number.isFinite(goalValue)) {
            // The football owns the camera until it reaches the verified goal
            // corridor. Never show the goalkeeper before the pass or shot.
            const left = hasBall ? Math.min(ball, goal) : goal;
            const right = hasBall ? Math.max(ball, goal) : goal;
            const edge = Math.min(.025, viewWidth * .08);
            if (right - left + edge * 2 <= viewWidth) {
              low = Math.max(half, right + edge - half);
              high = Math.min(1 - half, left - edge + half);
              hardLow = low;
              hardHigh = high;
              target = (left + right) / 2;
            } else {
              low = Math.max(half, goal + edge - half);
              high = Math.min(1 - half, goal - edge + half);
              hardLow = low;
              hardHigh = high;
              target = goal;
            }
          } else if (hasBall) {
            target = ball;
            // Keep the football in the central ~72% of the portrait crop.
            // The former 11% margin allowed it to sit at 89% of the output
            // width, so the receiver was outside the view until too late.
            // This is still a dead zone, not frame-by-frame recentering.
            const ballEdge = Math.min(.085, viewWidth * .27);
            low = Math.max(half, ball + ballEdge - half);
            high = Math.min(1 - half, ball - ballEdge + half);
            const hardBallEdge = Math.min(.012, viewWidth * .04);
            hardLow = Math.max(half, ball + hardBallEdge - half);
            hardHigh = Math.min(1 - half, ball - hardBallEdge + half);
          } else if (payoff || phase === "payoff") {
            target = payoff ? (Number(payoff[0]) + Number(payoff[2])) / 2 : goal;
            if (payoff) {
              low = Math.max(half, Number(payoff[2]) - half);
              high = Math.min(1 - half, Number(payoff[0]) + half);
              hardLow = low;
              hardHigh = high;
            }
          }
          if (verifiedGoalRoute && Number(record.time) >= Math.max(0, contact - 3.0)
              && Number(record.time) < payoffStart) {
            // Begin one deliberate goalward move before the kick, projected
            // into the current player+ball safe interval. This arrives for the
            // finish without abandoning the carrier or following detector
            // jitter frame by frame.
            const routeStart = Math.max(0, contact - 3.0);
            const progress = clamp((Number(record.time) - routeStart)
              / Math.max(.25, payoffStart - routeStart), 0, 1);
            const desired = clamp(target * (1 - progress) + goal * progress, low, high);
            const routeDeadZone = Math.min(.032, viewWidth * .10);
            low = Math.max(low, desired - routeDeadZone);
            high = Math.min(high, desired + routeDeadZone);
            target = desired;
          }
          if (low > high) [low, high] = [half, 1 - half];
          if (hardLow > hardHigh) [hardLow, hardHigh] = [half, 1 - half];
          carriedTarget = clamp(target, half, 1 - half);
          return { time: Number(record.time), cut: record.scene_cut === true,
            record, frame, phase, cameraOwner, ball, ballY, directBall, guidedBall, hasBall,
            player, playerLeft, playerRight, hasPlayer,
            pairFits, target: clamp(carriedTarget, low, high), low, high, hardLow, hardHigh };
        });
        const cameraPath = holdAndPanCamera(planned, {
          minimumCamera: half, maximumCamera: 1 - half,
          // A football pass can cross a portrait crop faster than the old
          // cinematic pan limit. Lead a sustained trajectory and arrive at the
          // receiver before the ball, while retaining a dead zone so detector
          // jitter still cannot move the camera.
          // Start earlier from the central safe-zone breach and preserve a
          // real speed ceiling. The former arrive-before-exit shortcut could
          // compress a large move into 450 ms, producing exactly the rushed,
          // shaky catch-up pan visible in portrait football edits.
          lookAhead: 2.60, persistence: .24, minimumHold: .78, postPanHold: .55,
          minimumPanDistance: .045, maximumSpeed: verifiedGoalRoute ? .24 : .14, durationScale: 1.15,
          minimumPanDuration: 1.05, maximumPanDuration: 3.60,
          // The portrait camera is an editorial path, not a visualization of
          // every detector sample. A wide central safe zone and look-ahead
          // initiate the pan. A verified goal changes ownership only after the
          // decisive touch, preventing a future goal box from pulling the crop
          // off the carrier before contact.
          arriveBeforeExit: false, constrainEachFrame: false,
          stopAtOwnershipChange: verifiedGoalRoute,
        });
        return planned.map((item, index) => {
          const { record, frame, phase, ball, ballY, directBall, guidedBall, hasBall,
            player, playerLeft, playerRight, hasPlayer, pairFits } = item;
          const previousCamera = cameraPath[index];
          const actionHandoffCut = isActionHandoffCut(planned, cameraPath, index);
          const cropLeft = previousCamera - half;
          const ballInFrame = hasBall && ball >= cropLeft && ball <= cropLeft + viewWidth;
          const playerInFrame = hasPlayer && playerLeft >= cropLeft && playerRight <= cropLeft + viewWidth;
          const payoff = Array.isArray(record.payoff_box) && record.payoff_box.length === 4 ? record.payoff_box : null;
          const payoffLeft = payoff ? Number(payoff[0]) : goal;
          const payoffRight = payoff ? Number(payoff[2]) : goal;
          const payoffRegionInFrame = Number.isFinite(payoffLeft) && Number.isFinite(payoffRight)
            && payoffLeft >= cropLeft && payoffRight <= cropLeft + viewWidth;
          const payoffWidth = Math.max(.000001, payoffRight - payoffLeft);
          const payoffOverlap = Math.max(0, Math.min(payoffRight, cropLeft + viewWidth) - Math.max(payoffLeft, cropLeft));
          const goalContextInFrame = Number.isFinite(payoffLeft) && Number.isFinite(payoffRight)
            && goal >= cropLeft + viewWidth * .07 && goal <= cropLeft + viewWidth * .93
            && (payoffRegionInFrame || payoffOverlap / payoffWidth >= .58);
          const playerCenterX = hasPlayer ? Number(player.cx) : null;
          const playerCenterY = hasPlayer ? Number(player.cy) : null;
          const playerEdgeClearance = playerInFrame
            ? Math.min(playerLeft - cropLeft, cropLeft + viewWidth - playerRight) / viewWidth
            : -1;
          return {
            ...frame,
            cameraX: Number(previousCamera.toFixed(6)), cameraY: .5,
            cameraCut: actionHandoffCut ? 1 : 0,
            cropBox: [cropLeft, 0, cropLeft + viewWidth, 1],
            directBall, ballGuidance: guidedBall,
            ballCenterX: hasBall ? (ball - cropLeft) / viewWidth * outputWidth : null,
            ballCenterY: hasBall ? ballY * outputHeight : null,
            ballConfidence: hasBall ? Number(record.ball_confidence || 0) : 0,
            playerCenterX: hasPlayer ? (playerCenterX - cropLeft) / viewWidth * outputWidth : null,
            playerCenterY: hasPlayer ? playerCenterY * outputHeight : null,
            playerTopY: hasPlayer ? Number(player.y1) * outputHeight : null,
            playerTrackId: hasPlayer ? player.trackId : null,
            ballInFrame, playerInFrame,
            jointVisible: hasBall && hasPlayer ? 1 : 0,
            jointFit: pairFits && ballInFrame && playerInFrame,
            playerEdgeClearance,
            markerVisible: (phase === "setup" || phase === "contact") && pairFits && ballInFrame && playerInFrame
              ? Number(frame.markerVisible || 0) : 0,
            payoffRegionInFrame,
            goalContextInFrame,
            actionPhase: phase,
            cameraOwner: item.cameraOwner,
          };
        });
      })()
    : null;
  // With no frame evidence, a stable neutral crop is safer than fabricating a
  // pan from semantic timestamps. Real gameplay normally takes the rebuilt
  // path above; this branch exists only for damaged/legacy evidence.
  const keyframes = (rebuilt || existing.length) ? (rebuilt || existing) : [0, duration].map((time, index) => ({
    time: Number(time.toFixed(3)), cameraX: Number(fallback.toFixed(6)), cameraY: .5,
    sceneCut: index === 0 ? 1 : 0, cameraCut: 0, actionPhase: "setup",
    ballInFrame: false, playerInFrame: false, directBall: false, ballGuidance: false, jointFit: 0,
  }));
  const ratio = (frames, predicate) => frames.length ? frames.filter(predicate).length / frames.length : 0;
  const actionFrames = keyframes.filter(frame => ["setup", "contact", "flight"].includes(frame.actionPhase));
  const setupContact = keyframes.filter(frame => ["setup", "contact"].includes(frame.actionPhase));
  const directFrames = keyframes.filter(frame => frame.directBall);
  const pairFrames = keyframes.filter(frame => frame.jointVisible);
  const cameraSteps = keyframes.slice(1).map((frame, index) => (frame.sceneCut || frame.cameraCut)
    ? Number.NaN : Math.abs(Number(frame.cameraX) - Number(keyframes[index].cameraX))).filter(Number.isFinite);
  const cameraSpeeds = keyframes.slice(1).map((frame, index) => {
    if (frame.sceneCut || frame.cameraCut) return Number.NaN;
    const dt = Number(frame.time) - Number(keyframes[index].time);
    return dt > 0 ? Math.abs(Number(frame.cameraX) - Number(keyframes[index].cameraX)) / dt : Number.NaN;
  }).filter(Number.isFinite);
  const signedVelocities = keyframes.slice(1).map((frame, index) => {
    if (frame.sceneCut || frame.cameraCut) return null;
    const dt = Number(frame.time) - Number(keyframes[index].time);
    return dt > 0 ? { time: Number(frame.time), value: (Number(frame.cameraX) - Number(keyframes[index].cameraX)) / dt } : null;
  }).filter(Boolean);
  const cameraAccelerations = signedVelocities.slice(1).map((velocity, index) => {
    const previous = signedVelocities[index];
    const dt = velocity.time - previous.time;
    return dt > 0 ? Math.abs(velocity.value - previous.value) / dt : Number.NaN;
  }).filter(Number.isFinite);
  const percentile = (values, p) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  };
  const phaseEvidence = Object.fromEntries(["setup", "contact", "flight", "payoff"].map(phase => {
    const frames = keyframes.filter(frame => frame.actionPhase === phase);
    return [phase, {
      samples: frames.length,
      ballCoverage: ratio(frames, frame => frame.ballInFrame && (frame.directBall || frame.ballGuidance)),
      directBallCoverage: ratio(frames, frame => frame.ballInFrame && frame.directBall),
      jointCoverage: ratio(frames, frame => frame.jointFit),
      directJointCoverage: ratio(frames, frame => frame.jointFit && frame.directBall),
      payoffCoverage: ratio(frames, frame => frame.payoffRegionInFrame || frame.goalContextInFrame),
    }];
  }));
  let maxDirectBallGap = 0;
  let previousDirectTime = null;
  for (const frame of keyframes) {
    if (frame.directBall) {
      if (previousDirectTime !== null) maxDirectBallGap = Math.max(maxDirectBallGap, Number(frame.time) - previousDirectTime);
      previousDirectTime = Number(frame.time);
    }
  }
  const openingCandidates = setupContact.filter(frame => Number(frame.time) <= 1.05);
  let opening = openingCandidates.slice(0, Math.min(5, openingCandidates.length));
  for (let index = 0; index <= openingCandidates.length - 5; index += 1) {
    const window = openingCandidates.slice(index, index + 5);
    if (ratio(window, frame => frame.jointFit && frame.directBall) >= .60) {
      opening = window;
      break;
    }
  }
  const finalPairCoverage = ratio(setupContact, frame => frame.jointFit && frame.directBall);
  const finalBallCoverage = ratio(actionFrames, frame => frame.ballInFrame && (frame.directBall || frame.ballGuidance));
  const repairedPayoffFrames = keyframes.filter(frame => frame.actionPhase === "payoff");
  const repairedGoalPayoffCoverage = ratio(repairedPayoffFrames,
    frame => frame.goalContextInFrame || frame.payoffRegionInFrame);
  const repairedGoalActionComplete = scene.eventType !== "goal" || (
    Number(phaseEvidence.contact.directJointCoverage || 0) >= .35
    && Number(phaseEvidence.setup.directJointCoverage || 0) >= .50
    && (!phaseEvidence.flight.samples
      || Number(phaseEvidence.flight.ballCoverage || 0) >= .35
      || Number(phaseEvidence.flight.payoffCoverage || 0) >= .75)
    && repairedGoalPayoffCoverage >= .50
  );
  return {
    ...(evidence || {}), keyframes, layoutMode: "action", fullBleedRepair: true,
    fullBleedRepairReason: "locked_scene_observed_possession_rebuild",
    openingJointVisible: ratio(opening, frame => frame.jointFit && frame.directBall) >= .60,
    directBallInFrameCoverage: ratio(keyframes, frame => frame.directBall && frame.ballInFrame),
    actionBallFramingCoverage: finalBallCoverage,
    goalPayoffCoverage: repairedGoalPayoffCoverage,
    goalOutcomeContextCoverage: repairedGoalPayoffCoverage,
    goalActionComplete: repairedGoalActionComplete,
    centralCompositionCoverage: ratio(setupContact, frame => frame.jointFit && frame.playerEdgeClearance >= .04),
    finalPairCoverage, finalBallCoverage,
    finalCropMetricsVersion: 2,
    finalCropVerified: ratio(opening, frame => frame.jointFit && frame.directBall) >= .60
      && finalBallCoverage >= .70 && finalPairCoverage >= .45
      && percentile(cameraSpeeds, .95) <= .11
      && percentile(cameraAccelerations, .95) <= .55,
    phaseEvidence: { version: 1, ...phaseEvidence },
    maxDirectBallGap,
    cameraMaxStep: cameraSteps.length ? Math.max(...cameraSteps) : 0,
    cameraStepP95: percentile(cameraSteps, .95),
    cameraSpeedP95: percentile(cameraSpeeds, .95),
    cameraAccelerationP95: percentile(cameraAccelerations, .95),
  };
}

function stabilizeTrackingForScenes(tracking, scenes, media, nativeLandscape = false) {
  if (nativeLandscape) return tracking;
  const moments = { ...(tracking?.moments || {}) };
  for (const scene of scenes) {
    const reaction = scene.eventType === "celebration" || scene.storyPhase === "reaction";
    const evidence = moments[scene.id];
    // These providers already reviewed this exact crop. A legacy projection
    // would alter the pixels after approval and invalidate the review.
    if (reaction || ["hybrid-football", "gemini-vision"].includes(evidence?.provider)
      || !evidence?.keyframes?.length) continue;
    const stabilized = fullBleedRepairEvidence(scene, evidence, media);
    stabilized.fullBleedRepairReason = "verified_minimum_motion_projection";
    moments[scene.id] = stabilized;
  }
  return { ...(tracking || {}), moments, summary: summarizeTracking(moments) };
}

function restorePossessionChainStarts(scenes) {
  return (Array.isArray(scenes) ? scenes : []).map((scene) => {
    if (scene.sourceViewSplit === true) return scene;
    const previousOffset = Number(scene.boundaryCorrection?.trackingTrimOffset || 0);
    const restoredStart = previousOffset > 0
      ? Number((Number(scene.startTime) - previousOffset).toFixed(3))
      : Number(scene.startTime);
    const priorCorrection = { ...(scene.boundaryCorrection || {}) };
    delete priorCorrection.trackingTrimOffset;
    const restored = {
      ...scene,
      startTime: restoredStart,
      ...(previousOffset > 0 ? { boundaryCorrection: {
        ...priorCorrection,
        reason: "restored_verified_possession_chain_origin",
      } } : {}),
    };
    const lockedApproval = restored.selectionLocked === true
      && restored.actionComplete !== false
      && (restored.sceneSelectionApproved === true || restored.selectionDecision === "approved");
    if (!lockedApproval) return restored;
    const approved = {
      ...restored,
      semanticVerified: true,
      semanticVerificationVersion: SEMANTIC_VERIFICATION_VERSION,
      keepDecision: restored.selectionKeepDecision || (restored.isReplay ? "replay" : "keep"),
      selectedForFinalVideo: true,
      rejectReason: undefined,
      trackingDecision: restored.trackingDecision === "semantic_mismatch"
        ? "selection_locked_portrait_repair" : restored.trackingDecision,
    };
    return { ...approved, semanticSignature: semanticSignature(approved) };
  });
}

function trimUnframeableDistributionLeadIns(scenes, tracking) {
  const moments = { ...(tracking?.moments || {}) };
  const restoredScenes = restorePossessionChainStarts(scenes);
  const adjustedScenes = restoredScenes.map((scene) => {
    // Step 1 locks the incident and source angle, not detector-empty pre-roll.
    // Boundary refinement remains inside that exact source scene and can never
    // replace it with a different incident.
    const reaction = scene.eventType === "celebration" || scene.storyPhase === "reaction";
    const evidence = moments[scene.id];
    const frames = Array.isArray(evidence?.keyframes) ? evidence.keyframes : [];
    if (reaction || ["gemini-vision", "hybrid-football"].includes(evidence?.provider) || frames.length < 8) return scene;
    const duration = Number(scene.endTime) - Number(scene.startTime);
    const pairLocked = frame => frame.directBall === true && frame.ballInFrame === true
      && frame.playerInFrame === true && Boolean(frame.jointFit);
    const sustainedRuns = (predicate, minimumDuration) => {
      const runs = [];
      let runStart = null, runEnd = null;
      for (const frame of frames) {
        const time = Number(frame.time);
        if (predicate(frame)) {
          if (runStart === null) runStart = time;
          runEnd = time;
        } else if (runStart !== null) {
          if (runEnd - runStart >= minimumDuration) runs.push({ start: runStart, end: runEnd });
          runStart = runEnd = null;
        }
      }
      if (runStart !== null && runEnd - runStart >= minimumDuration) runs.push({ start: runStart, end: runEnd });
      return runs;
    };
    const pairRuns = sustainedRuns(pairLocked, .45);
    const directBallRuns = sustainedRuns(frame => frame.directBall === true && frame.ballInFrame === true, .45);
    // Use the earliest observed football action. A later player-and-ball lock
    // must never win merely because player identity is more confident there:
    // that used to cut away the assister/previous carrier before a goal.
    const firstAction = [
      ...pairRuns.map(run => ({ ...run, mode: "player_ball" })),
      ...directBallRuns.map(run => ({ ...run, mode: "ball" })),
    ].sort((left, right) => left.start - right.start)[0];
    if (!firstAction || firstAction.start <= .75
        || firstAction.start > duration * .60 || duration - firstAction.start < 4) return scene;
    // Retain a short setup breath before the earliest locally observed ball.
    // Gemini's semantic origin can be earlier than visible action, so it is an
    // advisory bound only when local player-and-ball evidence supports it.
    const semanticOrigin = Number(scene.trackingBrief?.originTime);
    const originOffset = Number.isFinite(semanticOrigin)
      ? Math.max(0, semanticOrigin - Number(scene.startTime))
      : Number.POSITIVE_INFINITY;
    const semanticOriginSupported = frames.some((frame) => Number(frame.time) <= originOffset + .45
      && pairLocked(frame));
    const latestPossessionSafeOffset = Number.isFinite(originOffset) && semanticOriginSupported
      ? Math.max(0, originOffset - .55) : Number.POSITIVE_INFINITY;
    const proposedOffset = Math.max(0, firstAction.start - .35);
    const offset = Number(Math.min(proposedOffset, latestPossessionSafeOffset).toFixed(3));
    if (offset <= .25) return scene;
    const trimmedKeyframes = frames.filter(frame => Number(frame.time) >= offset)
      .map((frame, index) => ({ ...frame, time: Number((Number(frame.time) - offset).toFixed(3)),
        sceneCut: index === 0 ? 1 : frame.sceneCut }));
    const sourceRecords = (Array.isArray(evidence.sourceRecords) ? evidence.sourceRecords : [])
      .filter(record => Number(record.time) >= offset)
      .map((record, index) => ({ ...record, time: Number((Number(record.time) - offset).toFixed(3)),
        scene_cut: index === 0 ? true : record.scene_cut }));
    if (trimmedKeyframes.length < 4 || sourceRecords.length !== trimmedKeyframes.length) return scene;
    const startTime = Number((Number(scene.startTime) + offset).toFixed(3));
    moments[scene.id] = {
      ...evidence,
      keyframes: trimmedKeyframes,
      sourceRecords,
      sourceStartTime: startTime,
      fullBleedRepairReason: "trimmed_only_before_verified_possession_origin",
      finalCropVerified: false,
    };
    return {
      ...scene,
      startTime,
      boundaryCorrection: {
        ...(scene.boundaryCorrection || {}),
        originalStartTime: Number(scene.boundaryCorrection?.originalStartTime ?? scene.startTime),
        trackingTrimOffset: offset,
        reason: "lead_in_trim_preserving_verified_possession_chain",
      },
    };
  });
  return {
    scenes: adjustedScenes,
    tracking: { ...(tracking || {}), moments, summary: summarizeTracking(moments) },
  };
}

async function trackLockedSceneUntilVerified(sourcePath, scene, media, id, sceneIndex, sceneCount, tracking, nativeLandscape = false, repairRound = 0, options = {}) {
  if (geminiKeyframing) {
    const current=await readJob(id);
    await updateJob(current,'tracking',Math.max(34,Number(current.progress||0)),{
      activeTrackingScene:{id:scene.id,index:sceneIndex+1,total:sceneCount,status:'tracking',round:repairRound+1},
      progressDetail:`Tracking separate scene ${sceneIndex+1}/${sceneCount} in ${nativeLandscape?'16:9':'9:16'}; its own camera clock starts at zero.`,
    });
    const partial = await trackFootball(sourcePath, [{ ...scene, selectedForFinalVideo: true }], media, id,{repairRound});
    const merged = mergeTrackingResults(tracking, partial);
    return { tracking: merged, assessment: assessGeminiFraming(scene, trackingEvidenceFor(merged, scene)) };
  }
  const decisiveIncident = ["goal", "disallowed_goal"].includes(String(scene.eventType));
  const strategies = [
    // One temporal pass replaces the former 10/15/20-fps full-scene ladder.
    // The decisive window stays dense; setup remains at 5 fps so player
    // identity survives long build-ups without repeating full-resolution work.
    // Trajectory-first ROI inference supplies the small-ball detail without
    // loading and running three separate detector processes per scene.
    { sampleFps: 15, coarseSampleFps: Math.min(5, trackingCoarseSampleFps), ballImageSize: 1600, imageSize: trackingImageSize },
  ];
  if (hybridKeyframing) strategies.splice(0, strategies.length,
    { sampleFps: 12, coarseSampleFps: 6, ballImageSize: 1280, imageSize: 960 });
  if (!hybridKeyframing && (decisiveIncident || ["shot_on_target", "shot_off_target", "save", "big_chance", "assist"].includes(String(scene.eventType)))) strategies.push(
    { sampleFps: 15, coarseSampleFps: 8, ballImageSize: 1600, imageSize: 1280 },
  );
  if (nativeLandscape) {
    // The complete broadcast frame is already visible; validate phases and
    // derive optional marker positions without paying for portrait crop-path
    // precision that the 16:9 renderer never consumes.
    strategies.splice(0, strategies.length,
      { sampleFps: nativeTrackingSampleFps, coarseSampleFps: Math.min(4, nativeTrackingSampleFps), ballImageSize: nativeTrackingBallImageSize, imageSize: nativeTrackingImageSize },
    );
    if (decisiveIncident) strategies.push(
      { sampleFps: 12, coarseSampleFps: 6, ballImageSize: 1600, imageSize: 960 },
      { sampleFps: 15, coarseSampleFps: 8, ballImageSize: 1600, imageSize: 1280 },
    );
  }
  // The fast queue already ran native tracking and reviewed this exact crop.
  // Repeating that unchanged pass cannot repair its rejected camera path.
  if (options.skipNativePass && hybridKeyframing && !nativeLandscape) strategies.length=0;
  let merged = tracking;
  let lastAssessment = options.skipNativePass
    ? assessPlannedSceneTracking(scene,trackingEvidenceFor(tracking,scene))
    : { usable: false, mode: "not_tracked" };
  for (const [attemptIndex, strategy] of strategies.entries()) {
    const current = await readJob(id);
    await updateJob(current, "tracking", Math.max(34, current.progress), {
      progressDetail: `Scene ${sceneIndex + 1}/${sceneCount}: ${attemptIndex === 0 ? "verifying" : `repair ${attemptIndex}/${strategies.length - 1}`} ${scene.id} in ${nativeLandscape ? "native 16:9" : "9:16"}. Selection remains locked.`,
      activeTrackingScene: { id: scene.id, index: sceneIndex + 1, total: sceneCount, attempt: attemptIndex + 1 },
    });
    const partial = await trackFootball(sourcePath, [{ ...scene, selectedForFinalVideo: true }], media, id, strategy);
    if (isDecisionScene(scene)) {
      partial.moments[scene.id] = repairDecisionFraming(scene, partial.moments[scene.id],
        nativeLandscape ? { ...media, viewportRatio: 16 / 9 } : media);
    }
    const currentEvidence = trackingEvidenceFor(merged, scene);
    const partialEvidence = trackingEvidenceFor(partial, scene);
    if (!providerEvidenceMatches(activeKeyframeProvider, currentEvidence)
      || trackingEvidenceQuality(scene, partialEvidence, nativeLandscape) >= trackingEvidenceQuality(scene, currentEvidence, nativeLandscape)) {
      merged = mergeTrackingResults(merged, partial);
    }
    lastAssessment = nativeLandscape && !hybridKeyframing
      ? assessNativeFrameAction(scene, trackingEvidenceFor(merged, scene))
      : assessPlannedSceneTracking(scene, trackingEvidenceFor(merged, scene));
    if (lastAssessment.usable) {
      if (hybridKeyframing) return { tracking: merged, assessment: lastAssessment };
      if (nativeLandscape) return { tracking: merged, assessment: lastAssessment };
      // Passing detector evidence still contains frame-by-frame subject
      // centers. Project every gameplay scene onto the same minimum-motion
      // safe intervals so a technically valid track cannot visibly recenter.
      const evidence = trackingEvidenceFor(merged, scene);
      const stabilizedEvidence = fullBleedRepairEvidence(scene, evidence, media);
      stabilizedEvidence.fullBleedRepairReason = "verified_minimum_motion_projection";
      const moments = { ...(merged.moments || {}), [scene.id]: stabilizedEvidence };
      merged = { ...merged, moments, summary: summarizeTracking(moments) };
      return { tracking: merged, assessment: { ...lastAssessment, mode: "verified_minimum_motion" } };
    }
    // Native 16:9 does not depend on detector coordinates to keep the ball and
    // player inside a moving crop. Once one tracking pass has failed to prove
    // marker positions, two denser passes are wasteful for a semantically
    // verified complete incident. Keep its source frame and suppress overlays;
    // never manufacture ball/player positions to satisfy the tracker.
    if (nativeLandscape && canUseNativeSemanticFallback(scene)) {
      return { tracking: merged, assessment: { usable: true, mode: "native_semantic_complete_action" } };
    }
  }
  if (hybridKeyframing && !nativeLandscape) {
    // The hybrid provider cannot recover a rejected detector crop by accepting
    // another model-generated coordinate path. Keep the locked scene and its
    // native evidence for a targeted Step 2 repair or human review.
    return {tracking:merged,assessment:{...lastAssessment,
      mode:'hybrid_grounded_tracking_required',
      issues:[...new Set([...(lastAssessment.issues||[]),'grounded_player_ball_crop_unverified'])]}};
  }
  if (nativeLandscape) return { tracking: merged, assessment: lastAssessment };
  const evidence = trackingEvidenceFor(merged, scene);
  const repairedEvidence = fullBleedRepairEvidence(scene, evidence, media);
  repairedEvidence.fullBleedRepairReason = lastAssessment.mode;
  const moments = { ...(merged.moments || {}), [scene.id]: repairedEvidence };
  merged = { ...merged, moments, summary: summarizeTracking(moments) };
  const repairedAssessment = assessPlannedSceneTracking(scene, repairedEvidence);
  // A semantically verified goal can occasionally fail only the last phase
  // label after the final crop is already stable and the goalmouth/ball are
  // clearly visible. Keep that incident with a static analytical presentation
  // and suppress player markers; never use this path for weak or shaky footage.
  const guardedGoalFallback = decisiveIncident
    && scene.semanticVerified === true
    && scene.actionComplete === true
    && repairedEvidence.fullBleedRepair === true
    && repairedEvidence.finalCropVerified === true
    && Number(repairedEvidence.finalBallCoverage || 0) >= 0.70
    && Number(repairedEvidence.actionBallFramingCoverage || 0) >= 0.70
    && Number(repairedEvidence.goalPayoffCoverage || 0) >= 0.75
    && Number(repairedEvidence.cameraStepP95 || 0) <= 0.035
    && Number(repairedEvidence.cameraJerkP95 || 0) <= 0.080;
  if (guardedGoalFallback) return { tracking: merged, assessment: { usable: true, mode: "native_semantic_complete_action" } };
  // Never convert a failed track into success. The alternative-angle selector
  // may choose another already-discovered view of this incident; if none pass,
  // coverage fails with scene-level evidence instead of rendering bad footage.
  return { tracking: merged, assessment: repairedAssessment };
}

async function prepareIncidentEvidence(sourcePath, candidates, media, id, options = {}) {
  const trackingDirectory = join(outputRoot, id, "tracking");
  const trackingPath = join(trackingDirectory, "tracking.json");
  await mkdir(trackingDirectory, { recursive: true });
  const sourceJob = await readJob(id);
  const nativeLandscape = sourceJob.settings?.aspectRatio === "16:9";
  const fixedQueue = isCompleteHighlights(sourceJob.settings)
    && candidates.some(scene=>scene.selectionLocked && scene.fixedSceneQueueVersion === 1);
  if (!fixedQueue) candidates = restorePossessionChainStarts(candidates);
  let lockedScenes = candidates
    .filter(moment => moment.selectionLocked === true)
    .sort((a, b) => Number(a.startTime) - Number(b.startTime));
  if (!lockedScenes.length) throw new Error("Step 1 did not lock any verified source scenes for keyframe tracking.");
  let result = candidates.map(moment => ({ ...moment, selectedForFinalVideo: false }));
  let tracking = { version: 91, moments: {}, summary: {}, markerPaths: {} };
  try {
    const savedTracking = JSON.parse(await readFile(trackingPath, "utf8"));
    if (Number(savedTracking?.version || 0) >= 91 && savedTracking?.moments) tracking = savedTracking;
  } catch { /* A new Step 2 run starts without cached keyframes. */ }
  // Load detector models ONCE for the pending scene queue. Python maintains
  // separate source intervals, camera clocks and scene checkpoints; no footage
  // is concatenated here. Only the compact crop reviews run concurrently.
  if (hybridKeyframing && fastTracking.enabled) {
    const pending = lockedScenes.filter(scene => {
      const evidence = trackingEvidenceFor(tracking, scene);
      return !providerEvidenceMatches(activeKeyframeProvider, evidence)
        || !assessPlannedSceneTracking(scene, evidence)?.usable || evidence.finalCropVerified!==true;
    });
    const pendingIds=new Set(pending.map(scene=>scene.id));
    const current=await readJob(id);
    const cachedApproved=lockedScenes.length-pending.length;
    await updateJob(current,'tracking',Math.max(34,Number(current.progress)||34),{
      sceneTrackingStates:{...current.sceneTrackingStates,...Object.fromEntries(lockedScenes.map(scene=>
        [scene.id,pendingIds.has(scene.id)?{status:'pending',round:0,detail:'Waiting for current crop verification.'}
          :{status:'verified',round:1,detail:'Saved player-and-ball camera verification reused.'}]))},
      trackingProgress:{pass:'crop_review',completed:cachedApproved,total:lockedScenes.length,
        approved:cachedApproved,needsRepair:0},
    });
    if (pending.length) {
      // The fast detector was benchmarked without LLM rectangles. A semantic
      // guide can steer candidate association toward an invented result or a
      // spare ball, so leave pixel coordinates and ROI search to the tracker.
      const guided=pending.map(hybridDetectorScene);
      const byId=new Map(guided.map(scene=>[scene.id,scene]));
      lockedScenes=lockedScenes.map(scene=>byId.get(scene.id)||scene);
      const streamed=new Map();
      let streamedWrites=Promise.resolve();
      const reviews=createStreamingWorkQueue(fastTracking.reviewConcurrency,async({scene,evidence})=>{
        const observed=await verifyHybridScene(sourcePath,scene,media,id,evidence);
        streamed.set(scene.id,observed);
        streamedWrites=streamedWrites.then(async()=>{
          tracking=mergeTrackingResults(tracking,{version:93,moments:{[scene.id]:observed}});
          await writeFile(trackingPath,JSON.stringify(tracking));
          // Persist UI approval with the completed crop, not after the entire
          // detector batch. Later scene detection must not look like 0 verified
          // clips while earlier independent crop reviews are already saved.
          const current=await readJob(id);
          const assessment=assessPlannedSceneTracking(scene,observed);
          const states={...current.sceneTrackingStates,[scene.id]:{
            status:assessment.usable?'verified':'needs_repair',round:1,
            detail:assessment.usable?'Verified player-and-ball camera path saved.':
              assessment.issues?.join('; ')||'Tracking needs repair'}};
          const completed=lockedScenes.map(scene=>states[scene.id])
            .filter(state=>['verified','needs_repair'].includes(state?.status));
          const approved=completed.filter(state=>state.status==='verified').length;
          await updateJob(current,'tracking',Math.max(34,Number(current.progress)||34),{
            sceneTrackingStates:states,
            trackingProgress:{pass:'crop_review',completed:completed.length,total:lockedScenes.length,
              approved,needsRepair:completed.length-approved},
          });
        });
        await streamedWrites;
      });
      let native;
      try {
        native = await trackFootball(sourcePath,
          guided.map(scene => ({...scene, selectedForFinalVideo:true})), media, id,
          {nativeOnly:true, sampleFps:fastTracking.sampleFps, coarseSampleFps:fastTracking.coarseSampleFps,
            onSceneReady:(sceneId,evidence)=>{
              const scene=byId.get(sceneId);
              if(!scene||!Number.isFinite(evidence.sourceStartTime)||!Number.isFinite(evidence.sourceEndTime)
                ||!hybridEvidenceWindowMatches(scene,evidence))
                throw new Error('Native checkpoint does not match the locked review scene.');
              reviews.enqueue({scene,evidence});
            }});
      } finally {
        // A retry cannot overlap sibling model calls or overwrite their saved
        // approvals with the unreviewed aggregate returned by Python.
        await reviews.drain();
      }
      native=mergeTrackingResults(native,{version:93,moments:Object.fromEntries(streamed)});
      tracking = mergeTrackingResults(tracking, native);
      await writeFile(trackingPath, JSON.stringify(tracking));
    }
  }
  const baseline = tracking;
  let checkpointWrites = Promise.resolve();
  let checkedScenes=0,approvedScenes=0;
  const saveCompletedScene = async completed => {
    checkpointWrites = checkpointWrites.then(async () => {
      tracking = mergeTrackingResults(tracking, completed.tracking);
      await writeFile(trackingPath, JSON.stringify(tracking));
      checkedScenes+=1;
      if(completed.assessment.usable) approvedScenes+=1;
      const current=await readJob(id);
      await updateJob(current,'tracking',Math.max(Number(current.progress||34),34+Math.floor(3*checkedScenes/lockedScenes.length)),{
        sceneTrackingStates:{...current.sceneTrackingStates,[completed.scene.id]:{
          status:completed.assessment.usable?'verified':'needs_repair',
          round:current.activeTrackingScene?.round||1,
          detail:completed.assessment.usable?'Verified player-and-ball camera path saved.':completed.assessment.issues?.join('; ')||'Tracking needs repair'}},
        activeTrackingScene:{id:completed.scene.id,index:completed.sceneIndex+1,total:lockedScenes.length,
          status:completed.assessment.usable?'verified':'needs_repair'},
        trackingProgress:{pass:options.provisional?'portrait_preflight':hybridKeyframing&&fastTracking.enabled?'crop_review':'gemini',completed:checkedScenes,total:lockedScenes.length,approved:approvedScenes,
          needsRepair:checkedScenes-approvedScenes},
        progressDetail:`Checked ${checkedScenes}/${lockedScenes.length} selected scenes: ${approvedScenes} crops verified${checkedScenes>approvedScenes?`, ${checkedScenes-approvedScenes} saved for repair`:''}. Completed keyframes are saved.`,
      });
    });
    await checkpointWrites;
    return completed;
  };
  const completedScenes = await mapWithConcurrency(
    lockedScenes,
    hybridKeyframing && fastTracking.enabled ? fastTracking.reviewConcurrency : fixedQueue ? 1 : trackingSceneConcurrency,
    async (scene, sceneIndex) => {
      if (!fixedQueue) scene=reviewedLeadInScene(scene,baseline.moments?.[scene.id]);
      const savedEvidence = trackingEvidenceFor(baseline, scene);
      const cachedAssessment = nativeLandscape
        ? assessNativeFrameAction(scene, savedEvidence)
        : assessPlannedSceneTracking(scene, savedEvidence);
      const sceneTracking = {
        version: 91,
        moments: savedEvidence ? { [scene.id]: savedEvidence } : {},
        summary: savedEvidence ? summarizeTracking({ [scene.id]: savedEvidence }) : {},
        markerPaths: baseline.markerPaths || {},
      };
      const splitCacheMatches=!scene.sourceSceneAsset || !geminiKeyframing
        || (savedEvidence?.splitSceneFileName===scene.sourceSceneAsset.fileName
          && savedEvidence?.portraitSceneAsset?.verifiedCamera===true);
      if (cachedAssessment.usable && splitCacheMatches && providerEvidenceMatches(activeKeyframeProvider, savedEvidence)
        && (!hybridKeyframing || savedEvidence.finalCropVerified===true)) {
        return saveCompletedScene({ scene, sceneIndex, tracking: sceneTracking, assessment: cachedAssessment });
      }
      // Reserve promotion in this SAME run adds new scenes; it is not a new
      // repair strategy for unchanged scenes already rejected by visual QA.
      // A later explicit retry still has no skip set and can repair them.
      if(options.skipVisualRejectedIds?.has(scene.id) && scene.trackingRepairError) {
        return saveCompletedScene({scene,sceneIndex,tracking:sceneTracking,assessment:{usable:false,
          mode:'gemini_visual_repair_unverified',issues:[scene.trackingRepairError]}});
      }
      let completed;
      try {
        if (hybridKeyframing && fastTracking.enabled) {
          const observed = await verifyHybridScene(sourcePath, scene, media, id, savedEvidence);
          completed = {tracking:{...sceneTracking,moments:{[scene.id]:observed}},
            assessment:assessPlannedSceneTracking(scene,observed)};
          if(!completed.assessment.usable) {
            completed=await trackLockedSceneUntilVerified(sourcePath,scene,media,id,sceneIndex,
              lockedScenes.length,completed.tracking,nativeLandscape,0,{skipNativePass:true});
          }
        } else completed = await trackLockedSceneUntilVerified(sourcePath,scene,media,id,sceneIndex,
          lockedScenes.length,sceneTracking,nativeLandscape,0);
      } catch(error) {
        if(!(error instanceof FramingVerificationError)) throw error;
        if(fixedQueue) throw error;
        // A scene-level visual rejection must not cancel unstarted siblings,
        // including a later goal. Keep this scene locked and unapproved, save
        // the exact reason, and finish the independent queue before coverage.
        completed={tracking:sceneTracking,assessment:{usable:false,mode:'gemini_visual_repair_unverified',
          issues:[error.message]}};
        scene={...scene,trackingRepairError:error.message};
      }
      // Persist each completed scene before a sibling repair can fail. Retry
      // must retain its verified keyframes, not repeat the entire locked queue.
      if (!fixedQueue) scene=reviewedLeadInScene(scene,completed.tracking?.moments?.[scene.id]);
      return saveCompletedScene({ scene, sceneIndex, ...completed });
    },
  );
  for (const completed of completedScenes) {
    const { scene, sceneIndex } = completed;
    tracking = mergeTrackingResults(tracking, completed.tracking);
    const approved = {
      ...preserveLockedSceneSelection([scene])[0],
      ...(()=>{
        const evidence=trackingEvidenceFor(tracking,scene),eventType=reviewedFramingEvent(scene,evidence);
        if(!completed.assessment.usable || !eventType || eventType===scene.eventType) return {};
        const narration=reviewedFramingNarration(scene,evidence);
        return {eventType,sourceEventTypeBeforeCropReview:scene.eventType,
          eventCorrectionEvidence:'independently_verified_actual_crop_outcome',
          description:narration?.description||scene.description,
          semanticNarrationFacts:narration?.facts||scene.semanticNarrationFacts};
      })(),
      ...(completed.assessment.usable && reviewedHybridPhaseBrief(scene,trackingEvidenceFor(tracking,scene))
        ? {trackingBrief:reviewedHybridPhaseBrief(scene,trackingEvidenceFor(tracking,scene))}:{}),
      ...(completed.assessment.mode === "planned_reaction" ? { storyPhase: "reaction", role: "reaction" } : {}),
      ...(completed.assessment.mode === "native_semantic_complete_action"
        ? { nativeFullFrameEvidence: true, playerHighlight: false, tacticalDrawing: "none" } : {}),
      selectedForFinalVideo: false,
      trackingDecision: completed.assessment.mode,
      trackingPassed: completed.assessment.usable === true,
      trackingRepairError: completed.assessment.usable ? undefined : scene.trackingRepairError,
      ...(isDecisionScene(scene) ? { playerHighlight: false, tacticalDrawing: "none" } : {}),
      portraitRepairReason: undefined,
      fallbackPresentation: undefined,
    };
    result = result.map(moment => moment.id === scene.id ? approved : moment);
    tracking.summary = summarizeTracking(tracking.moments);
    await writeFile(trackingPath, JSON.stringify(tracking));
    const current = await readJob(id);
    await updateJob(current, "tracking", Math.max(34, current.progress), {
      moments: options.provisional ? result.map(scene=>({...scene,selectionLocked:false})) : result,
      observedMoments: options.provisional ? result.map(scene=>({...scene,selectionLocked:false})) : result,
      trackingSummary: tracking.summary,
      progressDetail: completed.assessment.usable
        ? `Scene ${sceneIndex + 1}/${lockedScenes.length} passed ${nativeLandscape ? "native-frame action" : "9:16 keyframe"} verification. Its keyframes are saved in the fixed scene queue.`
        : `Scene ${sceneIndex + 1}/${lockedScenes.length} still needs camera repair (${completed.assessment.mode}). Its source selection is unchanged.`,
      activeTrackingScene: { id: scene.id, index: sceneIndex + 1, total: lockedScenes.length,
        status: completed.assessment.usable ? "passed" : "failed", reason: completed.assessment.mode },
    });
  }
  const boundaryAdjusted = fixedQueue ? { scenes: result, tracking } : trimUnframeableDistributionLeadIns(result, tracking);
  tracking = stabilizeTrackingForScenes(boundaryAdjusted.tracking, boundaryAdjusted.scenes, media, nativeLandscape);
  const verifiedScenes = boundaryAdjusted.scenes.map((scene) => {
    if (scene.selectionLocked !== true) return scene;
    const assessment = nativeLandscape
      ? assessNativeFrameAction(scene, trackingEvidenceFor(tracking, scene))
      : assessPlannedSceneTracking(scene, trackingEvidenceFor(tracking, scene));
    return { ...scene, trackingPassed: assessment.usable === true, trackingDecision: assessment.mode };
  });
  return { candidates: verifiedScenes, tracking };
}
async function verifyCandidateSemanticsWithGemini(sourcePath, candidates, id, onlyIds = null) {
  candidates = invalidateOlderGoalOutcomes(candidates);
  // Stored semantic reviews contain absolute source times. Re-normalize their
  // complete brief before the eligibility early return so newer geometry rules
  // apply without discarding or repeating a valid cloud review.
  candidates = candidates.map(moment => moment.semanticVerified === true && moment.trackingBrief
    ? { ...moment, trackingBrief: normalizeTrackingBrief(
      moment.trackingBrief, {eventType:moment.eventType}, moment.startTime, moment.endTime,
    ) } : moment);
  candidates = candidates.map(moment => {
    const normalized = normalizeDecisionOnlyScene(moment);
    return normalized === moment ? moment : { ...normalized, semanticSignature: semanticSignature(normalized) };
  });
  const sourceJob = await readJob(id);
  const sourceMedia = sourceJob.media;
  const targetRatio = outputDimensions(sourceJob.settings).width / outputDimensions(sourceJob.settings).height;
  const portraitWidth = Math.min(1, Number(sourceMedia?.height || 720) * targetRatio / Number(sourceMedia?.width || 1280));
  const tooWide = moment => {
    // Step 1 verifies original action, not a portrait composition. A broad
    // source result rectangle is not a reason to repeat semantic discovery.
    if (moment.sourceScoreObservation) return false;
    const box = moment.trackingBrief?.payoffEvidence?.targetBox;
    return Array.isArray(box) && box[2] - box[0] > portraitWidth;
  };
  const forcedDecisionReview = candidates.filter(moment =>
    moment.eventType === "disallowed_goal"
    && moment.semanticVerified === false
    && moment.semanticDecisionContextVersion !== 1
  );
  // A verifier upgrade must be able to re-open scenes rejected by an older
  // semantic version. selectDirectorCandidates intentionally excludes rejects,
  // which previously made poisoned/incomplete cache decisions permanent.
  const staleSemanticReview = candidates.filter(moment =>
    needsSemanticReview(moment, process.env.GEMINI_MODEL)
    && moment.selectionLocked !== true
    && Boolean(moment.ballVisible || playerOnlyAllowed(moment))
  );
  const reviewPool = [...new Map([
    ...selectDirectorCandidates(candidates),
    ...staleSemanticReview,
    ...forcedDecisionReview,
  ].map(moment => [moment.id, moment])).values()];
  const eligible = reviewPool.filter(framingEligible)
    .filter(moment => !moment.sourceAngleDeferred && !moment.sourceSupportDeferred)
    .filter(moment => needsSemanticReview(moment, process.env.GEMINI_MODEL)
      || forcedDecisionReview.some(candidate => candidate.id === moment.id)
      || (tooWide(moment) && moment.semanticGeometryVersion !== 1))
    .filter(moment => !onlyIds || onlyIds.includes(moment.id));
  if (eligible.length === 0) return { candidates, rejectedCount: 0 };
  // Large concatenated evidence reels repeatedly exceed the provider timeout.
  // Validate compact, cacheable batches while preserving the complete candidate
  // pool for same-incident context and merge every result back by stable id.
  if (!onlyIds) {
    const batches = semanticReviewBatches(eligible);
    if (batches.length > 1) {
      let completedBatches = 0;
      const reviews = await mapWithConcurrency(batches, 2, async (ids, batchIndex) => {
        const current = await readJob(id);
        await updateJob(current, "tracking", Math.max(32, current.progress), {
          progressDetail: `Validating source scenes in compact batch ${batchIndex + 1}/${batches.length}; ${completedBatches} complete. Completed batches stay cached.`,
        });
        const result = await verifyCandidateSemanticsWithGemini(sourcePath, candidates, id, ids);
        completedBatches += 1;
        const latest = await readJob(id);
        await updateJob(latest, "tracking", Math.max(32, latest.progress), {
          progressDetail: `Validated ${completedBatches}/${batches.length} source-scene batches. Completed batches stay cached.`,
        });
        return { ...result, ids };
      });
      // Each independent batch returns the complete pool for context. Merge
      // only its own IDs, so an unchanged sibling snapshot cannot undo a
      // concurrently completed correction.
      const byId = new Map(reviews.flatMap(review => review.candidates
        .filter(moment => review.ids.includes(moment.id)).map(moment => [moment.id, moment])));
      const reviewedCandidates = candidates.map(moment => byId.get(moment.id) || moment);
      const rejectedCount = reviews.reduce((total, review) => total + review.rejectedCount, 0);
      return { candidates: reconcileVerifiedGoalDecisions(reviewedCandidates).map(moment =>
        ({ ...moment, semanticSignature: semanticSignature(moment) })), rejectedCount };
    }
  }
  // Review all eligible incidents in one labeled evidence reel to avoid quota-heavy per-incident calls.
  const sourceInfo = await stat(sourcePath);
  const sourceFingerprint=await sourceContentFingerprint(sourcePath);
  const sourceObservationSignature=stableSignature({sourcePath,sourceFingerprint,model:process.env.GEMINI_MODEL});
  const reviewKey = stableSignature({ sourcePath, sourceFingerprint,
    model: process.env.GEMINI_MODEL, prompt: FOOTBALL_EDITOR_SKILL_VERSION, geometry: 1, incidentContext: 7,
    semanticVersion: SEMANTIC_VERIFICATION_VERSION,
    ...(eligible.some(moment=>moment.eventType==='celebration')?{reactionContract:1}:{}),
    candidates: eligible.map(semanticSignature) });
  const reviewDir = join(outputRoot, id, "semantic-cache");
  await mkdir(reviewDir, { recursive: true });
  const reviewPath = join(reviewDir, `${reviewKey}.json`);
  try {
    const cached = JSON.parse(await readFile(reviewPath, "utf8"));
    const byId = new Map(cached.candidates.map(moment => [moment.id, moment]));
    let rawReviews = new Map();
    try {
      const envelope = JSON.parse(await readFile(join(reviewDir, `${reviewKey}.response.json`), "utf8"));
      if (invalidSemanticTimingIds(JSON.parse(envelope.responseText),envelope.clipManifest || []).length)
        throw new Error("Cached semantic timing needs isolated source observation.");
      rawReviews = new Map(JSON.parse(envelope.responseText).candidates.map(review => [String(review.id),
        correctSemanticReelClock(review, envelope.clipManifest?.find(clip => clip.id === String(review.id)))]));
    } catch (error) {
      if (error.message === "Cached semantic timing needs isolated source observation.") throw error;
      /* New cache entries carry the explicit observed-action flag. */
    }
    return { candidates: candidates.map(moment => {
      if (!byId.has(moment.id)) return moment;
      // The review key already includes the model. Older cache envelopes may
      // lack this provenance field; restore it from that exact matching key.
      const merged = mergeSemanticReview(moment, { ...byId.get(moment.id), semanticModel: process.env.GEMINI_MODEL });
      if (unsupportedNormalPlay(rawReviews.get(String(moment.id))) || merged.semanticObservedGameplay === false && merged.eventType === "normal_play") {
        return { ...merged, semanticVerified: false, keepDecision: "reject", selectedForFinalVideo: false,
          trackingDecision: "semantic_mismatch", rejectReason: "The source review supplies no observed player-and-ball gameplay." };
      }
      const rawReview = rawReviews.get(String(moment.id));
      const normalized = normalizeDecisionOnlyScene({ ...merged, trackingBrief: rawReview?.timingCorrection
        ? normalizeReviewedTrackingBrief(rawReview, merged, merged.eventType,merged.verifiedSourceActionWindow?.reviewSourceStartTime??merged.startTime)
        : normalizeTrackingBrief(merged.trackingBrief, {eventType:merged.eventType}, merged.startTime, merged.endTime) });
      return { ...normalized, semanticSignature: semanticSignature(normalized) };
    }), rejectedCount: cached.rejectedCount };
  } catch { /* Missing review: inspect actual footage, never guess. */ }
  const proxyPath = join(reviewDir, `${reviewKey}.mp4`);
  const reviewWindow = moment => semanticReviewWindow(moment, candidates, Number(sourceMedia?.duration || moment.endTime + 22));
  const reviewWindows = eligible.map(reviewWindow);
  const reviewWindowById = new Map(eligible.map((moment, index) => [String(moment.id), reviewWindows[index]]));
  const reviewClipManifest = semanticClipManifest(eligible, reviewWindows);
  const filters = eligible.map((moment, index) => {
    const window = reviewWindows[index];
    return `[${index}:v]trim=start=0:end=${(Number(window.end) - Number(window.start)).toFixed(3)},setpts=PTS-STARTPTS,fps=8,scale=-2:720,${semanticReviewLabel(moment.id)},format=yuv420p[semantic${index}]`;
  });
  filters.push(`${eligible.map((_, index) => `[semantic${index}]`).join("")}concat=n=${eligible.length}:v=1:a=0[semanticout]`);
  const totalDuration = reviewWindows.reduce((total, window) => total + Number(window.end) - Number(window.start), 0);
  const videoKbps = Math.round(clamp(12 * 1024 * 1024 * 8 / Math.max(1, totalDuration) / 1000, 300, 1800));
  await run(ffmpegPath, [
    "-hide_banner", "-y", ...semanticReviewInputArgs(sourcePath, reviewWindows),
    "-filter_complex_threads", "2",
    "-filter_complex", filters.join(";"),
    "-map", "[semanticout]", "-an", "-c:v", "libx264", "-threads", "2", "-preset", "veryfast",
    "-b:v", `${videoKbps}k`, "-maxrate", `${videoKbps}k`, "-bufsize", `${videoKbps * 2}k`,
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", proxyPath,
  ]);
  const proxy = await readFile(proxyPath);
  const endWitnesses=[];
  const endWitnessesById=new Map();
  for(const [index,moment] of eligible.entries()) {
    if(['celebration','var','offside'].includes(moment.eventType)) continue;
    const window=reviewWindows[index];
    const sceneWitnesses=[];
    for(const sourceTime of sourceCompletionDetailTimes({start:Math.max(window.start,moment.startTime),
      end:Math.min(window.end,moment.endTime)})) {
      const imagePath=join(reviewDir,`${reviewKey}-end-${index}-${sourceTime}.jpg`);
      await run(ffmpegPath,['-hide_banner','-loglevel','error','-y','-ss',String(sourceTime),'-i',sourcePath,
        '-an','-frames:v','1','-q:v','2',imagePath]);
      sceneWitnesses.push({text:`ORIGINAL native source evidence at the proposed candidate endpoint for exact scene ID ${moment.id}; scene LOCAL time ${(sourceTime-window.start).toFixed(4)} seconds. Inspect this endpoint in the context of its complete labeled clip. The proposed endpoint is not assumed complete. This is not a cropped frame or evidence from a different play.`},
        {inlineData:{mimeType:'image/jpeg',data:(await readFile(imagePath)).toString('base64')},
          mediaResolution:{level:'MEDIA_RESOLUTION_HIGH'}});
    }
    endWitnesses.push(...sceneWitnesses);
    endWitnessesById.set(String(moment.id),sceneWitnesses);
  }
  const prompt = [
    "Act as an independent football evidence observer. Watch every labeled candidate clip completely. No claimed event or description has been supplied: determine the actual action and outcome from the pixels, without assuming a goal.",
    "Return JSON only with candidates array. Return exactly one item for every supplied id with id, semanticMatch boolean, correctedEventType, correctedDescription, isReplay boolean, actionComplete boolean, narrationFacts array, and reason. Mark isReplay true for a visibly repeated action/alternate-angle replay, not a new live goal. A camera cut alone does not mean replay.",
    `The exact required ids are: ${eligible.map((moment) => moment.id).join(", ")}. Omitting an id is an invalid incomplete response. The supplied clipManifest gives each labeled clip's boundaries inside the concatenated review reel.`,
    "Use the visible LOCAL clock printed beside each scene ID for EVERY returned action timestamp. It resets to zero for each scene. The video player's combined reel clock and the match scoreboard clock are not the requested clock.",
    "semanticMatch is true only when a complete useful action or genuine reaction/decision is visible. Classify what happened independently. A save must visibly show the shot, ball travel, goalkeeper contact, and outcome. A goal must visibly show setup, scorer and ball before contact, decisive touch, ball travel, and goalmouth payoff. Midfield build-up alone is not a save or goal. A missed shot remains useful footage and must be classified honestly.",
    "Follow the REAL MOVING MATCH BALL from the kicking foot through the result. Spare balls sitting behind or beside the net, advertising, white clothes and static objects are not the match ball. Set goal only when that real ball crosses the line inside the goal. A shot over/wide does not become a goal because a stationary spare ball is visible near the net.",
    "A celebration or reaction supports emotion and urgency only. It never proves the scoring action, the technique of a finish, a save, or the tactical cause of a goal.",
    `These IDs are proposed REACTION SUPPORT clips, not claimed scoring actions: ${eligible.filter(moment=>moment.eventType==='celebration').map(moment=>moment.id).join(', ') || 'none'}. For these clips, a plainly visible brief player celebration is itself a complete reaction: use correctedEventType:celebration, semanticMatch:true and actionComplete:true only when that reaction is actually visible. Do not require a ball, setup, kick, flight or goal to be repeated inside a reaction clip. Use sourceActionWindow:null, outcomeReview:null and payoffEvidence:null, with only visible reaction facts. Reject a different restart, unrelated action or footage that is not a reaction. This reaction rule takes precedence over the gameplay grammar below.`,
    "For a goal, save, shot or big chance, also return outcomeReview:{goalScored:boolean,goalDecision:allowed|disallowed|unclear|not_applicable,eventType:goal|save|shot_on_target|shot_off_target|big_chance|uncertain,description:string,narrationFacts:string[],uncertainties:string[]}. Observe the physical outcome in this SAME neutral review, separately from its phase geometry. goalDecision describes whether a physical finish counts, not whether it crossed the line. Use unclear if the official decision is not shown; never invent disallowance. For non-scoring chances use not_applicable. Include uncertainties when the moving ball's result cannot be resolved. For other actions, reactions, or rejected/incomplete footage, return outcomeReview:null. This saved observation avoids a second identical outcome request only when its evidence and result are complete and consistent.",
    "Set trackingBrief.originTime to the first meaningful visible player-and-ball setup, not automatically clip-local zero or the beginning of the broadcast shot. Exclude waiting before a corner/free-kick taker enters the action, while retaining the preparation, initiating kick/pass, decisive receiving touch and completed result. All these times remain relative to that labeled clip, not the combined reel.",
    "For each complete gameplay action also return sourceActionWindow:{startTime,endTime,setupVisible,contactVisible,payoffVisible,cleanSourceBoundaries,reason}. This is the EXACT useful source interval to split BEFORE tracking. Use the labeled clip LOCAL clock. Start where the directly involved initiating player and moving ball are BOTH visible before contact. Exclude a preceding unrelated goalkeeper/reaction, dead waiting, and any source dissolve from a different play; never start mid-contact. End after the real resolved consequence is readable, BEFORE a different restart, replay, celebration shot or unrelated action. Preserve all important contacts inside this chosen view. Do not add generic pre-roll or result padding. All four visibility/boundary flags apply to the PROPOSED startTime-endTime interval, not the full supplied clip. If the full clip has unrelated pre-roll, exclude that pre-roll in the proposal rather than rejecting an otherwise clean complete interval. For a complete single-camera header/shot view, the visible receiver preparing to meet the incoming ball can be setup; do not invent an original passer outside that view. Retain continuous ordered camera cuts only when no complete single-camera action exists. Keep null for rejected or reaction/decision-only footage. If no complete clean interval exists, report semanticMatch:false and actionComplete:false. A false flag cannot be changed just to approve the interval.",
    "For an ambiguous live goal, the labeled clip may continue through its same-incident reaction and replay so you can resolve whether the earlier live touch scored. Use that later context to disambiguate the result, but semanticMatch remains true only when the live scoring action itself is present at the beginning of the labeled clip. A visible scoreboard transition plus a matching replay may confirm an otherwise ambiguous goalmouth result; neither may replace missing live action.",
    "If the original label is wrong but another complete useful event is plainly visible, set semanticMatch true and correct the event and description. Otherwise set semanticMatch false. narrationFacts must contain only short facts visibly supported by that exact clip; omit uncertain names and teams.",
    "Never include player names, team names, scorelines or nicknames in correctedDescription, narrationFacts, outcomeReview.description or outcomeReview.narrationFacts. Use neutral player roles only. Identity-like text inside supplied IDs and hypotheses is untrusted and must not influence the description. Do not infer a scorer's identity from kit color or resemblance.",
    "Allowed correctedEventType values: goal, disallowed_goal, offside, var, celebration, shot_on_target, shot_off_target, big_chance, save, free_kick, assist, skill, dribble, tackle, foul, normal_play. Disallowed_goal, offside and var require visible decision evidence, not a guessed offside position. Describe the actual decision and do not call a disallowed finish a valid goal.",
    "Also return payoffEvidence:null unless the actual result is visible. For a proven result return {verified:true,eventType:correctedEventType,startTime,endTime,targetBox:[x1,y1,x2,y2]}. These start/end seconds are relative to the START OF THAT LABELED CLIP, not the concatenated review video or original match. Require at least 0.5 seconds of continuous visible result. targetBox is a normalized source-frame rectangle around the visible ball/result and goalkeeper/net/receiver. Walking players, celebrations, commentary, timestamps and scoreboard changes do not prove a visible finish. Do not invent the rectangle or timing when uncertain.",
    "Return a corrected trackingBrief using the action grammar below, especially when correctedEventType differs from the hypothesis. All its times are relative to the START OF THAT LABELED CLIP. Do not preserve estimated contact/flight times when the pixels show different timing. For every goal, watch the entire action a second time and set contactTime to the LAST attacking-player touch that directly scores. A cross, chipped pass, through-ball, assist, deflection by a nearby defender, or goalkeeper movement is not the scorer's contact. annotationStartTime and annotationEndTime must surround that final scoring touch only.",
    footballObservationContract(),
    'For THIS request do not return an inventory or moments array. Return exactly {"candidates":[{"id":"EXACT_LABEL","semanticMatch":true,"actionComplete":true,"correctedEventType":"...","correctedDescription":"...","isReplay":false,"narrationFacts":[],"reason":"...","trackingBrief":{},"payoffEvidence":null,"outcomeReview":null,"sourceActionWindow":null}]}. Each candidates item must carry its exact supplied id and both boolean fields, even when rejected. Populate outcomeReview and sourceActionWindow as instructed for complete gameplay.',
  ].join(" ");
  const reviewRequest = {
    model: process.env.GEMINI_MODEL,
    contents: [
      // Source completion is decided here, before locking. Inspect every
      // gameplay review at the proxy's actual 8 fps, not every other frame.
      footballVideoPart(proxy.toString("base64"), eligible.some(scene=>!['celebration','var','offside'].includes(scene.eventType)) ? 8 : 4),
      { text: prompt },
      { text: JSON.stringify({ clipManifest: reviewClipManifest }) },
      ...endWitnesses,
      {text:'Completion audit: inspect the source-native endpoint images AND the full matching labeled clip. Identify the LAST included attacking touch, not an earlier shot/control. A ball approaching a receiver is NOT completed receiver control; a broadcast dissolve/cut with the ball still travelling is NOT a payoff. A cut-back across the area is NOT a missed shot merely because it passes outside a post. If the final contact is an unresolved pass or a new shot, set actionComplete:false unless you can propose an earlier independently complete useful action interval BEFORE that new release, with its actual ball/result visible. Never invent an anticipated receiving touch, goalkeeper save, wide shot, or consequence to satisfy duration. Describe the final touch and its directly observed consequence explicitly in sourceActionWindow.reason. Review this separately from event classification.'},
    ],
    config: { responseMimeType: "application/json", responseJsonSchema: semanticReviewSchema(eligible.map(moment => String(moment.id))),
      thinkingConfig: { thinkingLevel: "HIGH" }, temperature: 0.03, maxOutputTokens: 16384 },
  };
  const reviewClient = createGeminiClient();
  let semanticJson;
  try {
    // A completed neutral observation may precede a still-pending geometry
    // check. Keep that provider work across restarts instead of requesting it
    // again; completeness validation below still applies.
    const saved = JSON.parse(await readFile(join(reviewDir, `${reviewKey}.response.json`), "utf8"));
    const parsed = JSON.parse(saved.responseText);
    if (Array.isArray(parsed.candidates) && Array.isArray(saved.expectedIds)
      && saved.expectedIds.length === eligible.length
      && eligible.every(moment => saved.expectedIds.includes(String(moment.id)))) {
      semanticJson = { response: { text: saved.responseText }, parsed };
    }
  } catch { /* No completed observation for these exact windows. */ }
  if (!semanticJson) semanticJson = await generateGeminiJson(reviewClient, reviewRequest, "Gemini semantic verification", 3);
  let response = semanticJson.response;
  let parsed = semanticJson.parsed;
  const expectedReviewIds = eligible.map((moment) => String(moment.id));
  const incompleteReviewIds = value => [...new Set([...missingSemanticReviewIds(expectedReviewIds, value),
    ...invalidSemanticTimingIds(value,reviewClipManifest),...conflictingSourceActionWindowIds(value)])];
  const saveSemanticResponse = async () => writeFile(join(reviewDir, `${reviewKey}.response.json`), JSON.stringify({
    expectedIds: expectedReviewIds, clipManifest: reviewClipManifest,
    responseText: JSON.stringify(parsed),
  }, null, 2));
  // Save partial provider work too: an omitted sibling is not a reason to
  // discard valid observations or repeat the entire reel after a restart.
  await saveSemanticResponse();
  for (let correctionAttempt = 1; correctionAttempt <= 3; correctionAttempt += 1) {
    const missingIds = incompleteReviewIds(parsed);
    if (!missingIds.length) break;
    const current = await readJob(id);
    await updateJob(current, current.stage, current.progress, {
      progressDetail: `Completing ${missingIds.length} missing scene review(s); valid reviews are saved (attempt ${correctionAttempt}/3).`,
    });
    for (const missingId of missingIds) {
      const window=reviewWindowById.get(missingId);
      const isolatedPath=join(reviewDir,`${reviewKey}.${missingId.replace(/[^a-z0-9_-]/gi,'-')}.isolated.mp4`);
      await run(ffmpegPath,["-hide_banner","-loglevel","error","-y","-ss",String(window.start),"-i",sourcePath,
        "-t",String(window.end-window.start),"-vf",`setpts=PTS-STARTPTS,fps=8,scale=-2:720,${semanticReviewLabel(missingId)}`,
        "-an","-c:v","libx264","-preset","veryfast","-crf","18",isolatedPath]);
      semanticJson = await generateGeminiJson(reviewClient, {
        ...reviewRequest,
        contents: [footballVideoPart((await readFile(isolatedPath)).toString('base64'),8),{text:prompt},
          ...(endWitnessesById.get(missingId)||[]),reviewRequest.contents.at(-1),
          { text: `This is ONE isolated original source scene, ID ${JSON.stringify(missingId)}, duration ${(window.end-window.start).toFixed(3)} seconds. No other scene is supplied. Return {"candidates":[one review]} for this ID only. Read the visible LOCAL clock: EVERY timestamp must be between 0 and ${(window.end-window.start).toFixed(3)}. Do not use the match clock or original-source time. Inspect the true outcome and full action; never infer a goal or copy an earlier hypothesis. Reobserve the exact clean sourceActionWindow: its flags refer to that PROPOSED interval, not the full clip. Correct its boundaries when unrelated lead-in/tail can be excluded; never toggle false visibility flags without pixel evidence, hide a contact or invent a result. If no complete clean interval exists, report semanticMatch:false and actionComplete:false rather than inventing timings.` }],
        config: { ...reviewRequest.config, responseJsonSchema: semanticReviewSchema([missingId]), thinkingConfig: { thinkingLevel: "HIGH" } },
      }, `Gemini semantic missing scene ${missingId}`, 3);
      response = semanticJson.response;
      parsed = mergeMissingSemanticReview(parsed, semanticJson.parsed, missingId);
      await saveSemanticResponse();
    }
  }
  // A contradictory boundary assessment is a Step-1 scene rejection after
  // bounded reobservation, not a reason to stop every other valid incident.
  // Preserve the raw negative flags; the mapping below rejects that interval.
  const stillIncomplete = [...new Set([...missingSemanticReviewIds(expectedReviewIds,parsed),
    ...invalidSemanticTimingIds(parsed,reviewClipManifest)])];
  if (stillIncomplete.length) {
    throw new Error(`Gemini semantic validation remained incomplete for ${stillIncomplete.join(", ")}; saved candidates were not falsely rejected. Retry will reuse the inventory and request only the missing review batch.`);
  }
  await writeFile(join(reviewDir, `${reviewKey}.response.json`), JSON.stringify({
    expectedIds: expectedReviewIds,
    clipManifest: reviewClipManifest,
    responseText: JSON.stringify(parsed),
  }, null, 2));
  const oversized = (parsed.candidates || []).filter(item => {
    const box = (item.payoffEvidence || item.trackingBrief?.payoffEvidence)?.targetBox;
    return Array.isArray(box) && box[2] - box[0] > portraitWidth;
  });
  // Gemini keyframing verifies actual subjects per frame and the rendered
  // portrait crop. A broad semantic context box is not its camera command;
  // repeating this coarse geometry request cannot improve that camera proof.
  if (oversized.length && !geminiKeyframing && !hybridKeyframing) {
    semanticJson = await generateGeminiJson(reviewClient, { ...reviewRequest,
      contents: [...reviewRequest.contents, { text: `Recheck the result geometry before returning the complete JSON. A full-screen portrait crop spans ${portraitWidth.toFixed(4)} of this source width. Your proposed result regions for ${oversized.map(item => item.id).join(", ")} are wider than that. Inspect the exact result again: select a short interval and a focused rectangle around the visible ball crossing, save contact, or receiving touch, including the relevant goalkeeper where possible. Do not box the entire net or pitch. Never shrink the rectangle away from the actual subjects just to satisfy this width. If the required evidence cannot fit together or its position is uncertain, return payoffEvidence:null. Preserve all candidates and all required fields.` }] }, "Gemini semantic geometry correction", 3);
    response = semanticJson.response;
    parsed = semanticJson.parsed;
  }
  const reviews = new Map((Array.isArray(parsed.candidates) ? parsed.candidates : []).map((item) => [String(item.id),
    correctSemanticReelClock(item, reviewClipManifest.find(clip => clip.id === String(item.id)))]));
  const allowedEvents = new Set(["goal", "disallowed_goal", "offside", "var", "celebration", "shot_on_target", "shot_off_target", "big_chance", "save", "free_kick", "assist", "skill", "dribble", "tackle", "foul", "normal_play"]);
  let rejectedCount = 0;
  const verified = candidates.map((moment) => {
    if (!eligible.some((item) => item.id === moment.id)) return moment;
    const review = reviews.get(String(moment.id));
    const correctedEventType = allowedEvents.has(String(review?.correctedEventType)) ? String(review.correctedEventType) : moment.eventType;
    const reviewedWindow=reviewWindowById.get(String(moment.id))||{start:moment.startTime,end:moment.endTime};
    const reviewedBoundary=applyReviewedSourceActionWindow(expandMomentToReviewedAction(
      moment,review,correctedEventType,reviewedWindow.end),review,reviewedWindow);
    if (!review || review.semanticMatch !== true || review.actionComplete !== true || !reviewedBoundary
      || syntheticReactionMismatch(moment, review) || unsupportedNormalPlay(review)) {
      rejectedCount += 1;
      return {
        ...moment,
        keepDecision: "reject",
      selectedForFinalVideo: false,
        trackingDecision: "semantic_mismatch",
        semanticVerificationVersion: SEMANTIC_VERIFICATION_VERSION,
        semanticModel: process.env.GEMINI_MODEL,
        ...(moment.eventType==='celebration'?{semanticReactionContractVersion:1}:{}),
        semanticDecisionContextVersion: moment.eventType === "disallowed_goal" ? 1 : moment.semanticDecisionContextVersion,
        semanticVerified: false,
        rejectReason: !reviewedBoundary
          ? "Step 1 could not verify a clean complete source interval; choose an already observed complete view before locking."
          : unsupportedNormalPlay(review)
          ? "The normal-play review supplies no observed player-and-ball action; stoppage/staff footage is not gameplay."
          : syntheticReactionMismatch(moment, review)
          ? "The proposed post-goal support window contains a different action, not the same incident's reaction."
          : String(review?.reason || "Gemini could not verify a complete event from the labeled clip.").slice(0, 240),
      };
    }
    const narrationFacts = Array.isArray(review.narrationFacts)
      ? review.narrationFacts.map((fact) => String(fact).trim().slice(0, 160)).filter(Boolean).slice(0, 6)
      : [];
    return {
      ...reviewedBoundary,
      eventType: correctedEventType,
      isReplay: typeof review.isReplay === "boolean" ? review.isReplay : moment.isReplay,
      storyPhase: correctedEventType === "celebration" ? "reaction" : review.isReplay === true ? "replay" : moment.storyPhase === "reaction" ? (moment.isReplay ? "replay" : "action") : moment.storyPhase,
      role: correctedEventType === "celebration" ? "reaction" : moment.role === "reaction" ? "evidence" : moment.role,
      description: String(review.correctedDescription || moment.description || "").slice(0, 420),
      actionComplete: true,
      semanticVerificationVersion: SEMANTIC_VERIFICATION_VERSION,
      semanticModel: process.env.GEMINI_MODEL,
      ...(moment.eventType==='celebration'?{semanticReactionContractVersion:1}:{}),
      semanticDecisionContextVersion: moment.eventType === "disallowed_goal" ? 1 : moment.semanticDecisionContextVersion,
      keepDecision: moment.trackingDecision === "semantic_mismatch" ? "keep" : moment.keepDecision,
      trackingDecision: moment.trackingDecision === "semantic_mismatch" ? "not_tracked" : moment.trackingDecision,
      trackingBrief: normalizeReviewedTrackingBrief(review, reviewedBoundary, correctedEventType,reviewedWindow.start),
      semanticVerified: true,
      semanticNarrationFacts: narrationFacts,
      semanticObservedGameplay: Boolean(review.trackingBrief?.requiredSubjectsByPhase?.some(phase => phase.subjects?.includes("ball"))),
      sourceOutcomeObservation: review.outcomeReview ? {version:SOURCE_OUTCOME_OBSERVATION_VERSION,
        sourceSignature:sourceObservationSignature,start:reviewedBoundary.startTime,end:reviewedBoundary.endTime,
        review:review.outcomeReview} : undefined,
      rejectReason: undefined,
    };
  });
  const signed = verified.map(normalizeDecisionOnlyScene).map(moment => eligible.some(item => item.id === moment.id)
    ? { ...moment, semanticSignature: semanticSignature(moment), semanticGeometryVersion: 1 } : moment);
  const result = { candidates: signed, rejectedCount };
  await writeFile(reviewPath, JSON.stringify({ candidates: signed.filter(moment => eligible.some(item => item.id === moment.id)), rejectedCount }));
  return result;
}

async function verifyIndependentGoalOutcomes(sourcePath, candidates, id) {
  const directory = join(outputRoot, id, "goal-outcome-cache");
  await mkdir(directory, { recursive: true });
  const info = await stat(sourcePath);
  const sourceFingerprint=await sourceContentFingerprint(sourcePath);
  const sourceObservationSignature=stableSignature({sourcePath,sourceFingerprint,model:process.env.GEMINI_MODEL});
  const ai = createGeminiClient();
  const media = (await readJob(id)).media;
  let outcomeScoreLedger = null;
  try { outcomeScoreLedger = JSON.parse(await readFile(join(outputRoot, id, 'source-score-ledger.json'), 'utf8')); } catch {}
  const result = await mapWithConcurrency(candidates, 2, async moment => {
    if (moment.sourceAngleDeferred || moment.sourceSupportDeferred || !needsGoalOutcomeObservation(moment)) {
      return moment;
    }
    const observationSignature=stableSignature({sourcePath,sourceFingerprint,
      model:process.env.GEMINI_MODEL,start:moment.startTime,end:moment.endTime});
    const decisionWindows = sameIncidentDecisionWindows(moment, candidates);
    const alternativeWindows=sameIncidentOutcomeWindows(moment,candidates);
    const scoreContext = stableLiveScoreContext(moment, outcomeScoreLedger,{minimumAfterGap:3})
      || scoreAnchorForScene(moment, outcomeScoreLedger);
    const acceptedKey=stableSignature({version:GOAL_OUTCOME_VERSION,observationSignature,scoreContext,decisionWindows,alternativeWindows});
    if(moment.goalOutcomeCrosscheck?.version===GOAL_OUTCOME_VERSION
      && moment.goalOutcomeCrosscheck.verified===true
      && moment.goalOutcomeCrosscheck.observationSignature===observationSignature
      && moment.goalOutcomeCrosscheck.evidenceContextSignature===acceptedKey
      && !outcomeEvidenceConflict(moment.goalOutcomeCrosscheck.review,scoreContext,moment)) return moment;
    const detail = goalOutcomeDetail(moment, media);
    const key = stableSignature({ version: GOAL_OUTCOME_VERSION, promptVersion: OUTCOME_OBSERVATION_PROMPT_VERSION, detail, decisionWindows, alternativeWindows, scoreContext, mediaResolution: "HIGH_WITH_SOURCE_DETAIL", sourceFingerprint,
      model: process.env.GEMINI_MODEL, start: moment.startTime, end: moment.endTime });
    const cachePath = join(directory, `${key}.json`);
    // Persist the accepted observation independently of a mutable phase brief.
    // A worker restart may happen before the whole candidate batch is saved.
    const acceptedPath=join(directory,`accepted-${acceptedKey}.json`);
    let review;
    try {
      const saved=JSON.parse(await readFile(acceptedPath,'utf8'));
      if(saved.key===acceptedKey && reusableCompletedOutcome(saved.review)) review=saved.review;
    } catch { /* Only exact-source, positive completed observations are reusable. */ }
    if(!review) {
      const observed=reusableSourceOutcome(moment,sourceObservationSignature);
      if(observed) {
        review={...observed,reusedSourceObservation:true};
        await writeFile(cachePath,JSON.stringify(review));
      }
    }
    if(!review) try { review = JSON.parse(await readFile(cachePath, "utf8")); } catch {}
    if(!review) try {
      const previousKey=stableSignature({version:GOAL_OUTCOME_VERSION,detail,decisionWindows,scoreContext,
        mediaResolution:'HIGH_WITH_SOURCE_DETAIL',sourceSize:info.size,modified:info.mtimeMs,
        model:process.env.GEMINI_MODEL,start:moment.startTime,end:moment.endTime});
      const observed=JSON.parse(await readFile(join(directory,`${previousKey}.json`),'utf8'));
      // The scoped prompt repairs disputed reviews, not already accepted
      // observations of the exact same source, phase images and score context.
      if(reusableCompletedOutcome(observed)) review=observed;
    } catch { /* Never carry an uncertain old conclusion into the new review. */ }
    if (!review && scoreContext?.status === 'provisional') {
      // Version 6 used the same dense native images and source clip. The v7
      // score context repairs contradictory/negative conclusions; it does not
      // invalidate a positive crossing already concordant with this ledger.
      const denseKey = stableSignature({version:6,detail,decisionWindows,mediaResolution:'HIGH_WITH_SOURCE_DETAIL',
        sourceSize:info.size,modified:info.mtimeMs,model:process.env.GEMINI_MODEL,start:moment.startTime,end:moment.endTime});
      try {
        const observed = JSON.parse(await readFile(join(directory,`${denseKey}.json`),'utf8'));
        if (reusableDenseGoalOutcome(observed,scoreContext)) {
          review={...observed,reusedDenseObservation:{version:6,key:denseKey}};
          await writeFile(cachePath,JSON.stringify(review));
        }
      } catch { /* No exact matching positive dense observation. */ }
    }
    if (!review) {
      const current = await readJob(id);
      await updateJob(current, "tracking", Math.max(32, current.progress), {
        progressDetail: `Checking the independent high-resolution outcome of ${moment.id} before scene lock.`,
      });
      const video = join(directory, `${key}.mp4`);
      await run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(moment.startTime),
        "-i", sourcePath, "-t", String(moment.endTime - moment.startTime), "-vf", "fps=12,scale=1280:-2",
        "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", video]);
      const detailDirectory = join(directory, `${key}.tmp`);
      await mkdir(detailDirectory, { recursive: true });
      const cropFilter = detail.crop
        ? `,crop=${detail.crop.width}:${detail.crop.height}:${detail.crop.x}:${detail.crop.y}` : "";
      await run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(detail.start),
        "-i", sourcePath, "-t", String(detail.end - detail.start),
        "-vf", `fps=${detail.fps}:start_time=0${cropFilter}`, "-q:v", "2", join(detailDirectory, "detail-%04d.jpg")]);
      const detailParts = [];
      if (scoreContext) {
        detailParts.push({text: `Independent native scoreboard observations for this source incident: ${JSON.stringify(scoreContext)}. These observations locate the incident and distinguish a later reversal; they do not supply ball coordinates, prove a particular scorer, or prove the physical crossing by themselves.`});
        for (const [label, time] of [['before',scoreContext.before.time],['after',scoreContext.after.time],['reversal',scoreContext.reversalTime]]) {
          if (!Number.isFinite(time)) continue;
          const imagePath = join(detailDirectory, `score-${label}.jpg`);
          await run(ffmpegPath, ['-hide_banner','-loglevel','error','-y','-ss',String(time),'-i',sourcePath,
            '-vf','crop=iw:ih/4:0:0','-frames:v','1','-q:v','2',imagePath]);
          detailParts.push({text:`Independent scoreboard context ${label} at original source ${time}s. Read the visible score; do not infer a foul or offside reason from a reversal.`},
            {inlineData:{mimeType:'image/jpeg',data:(await readFile(imagePath)).toString('base64')},mediaResolution:{level:'MEDIA_RESOLUTION_HIGH'}});
        }
      }
      const images = (await readdir(detailDirectory)).filter(name => /^detail-\d+\.jpg$/.test(name)).sort();
      // Twelve phase/context stills retain dense contact and result evidence
      // while avoiding a 40k-token retry for a single disputed action.
      for (const index of goalOutcomeDetailIndexes(moment,detail,images.length,12)) detailParts.push(
        { text: `Original source detail at scene-local ${(detail.start - moment.startTime + index / detail.fps).toFixed(3)}s. Region ${JSON.stringify(detail.crop)}; this is observation context, not an asserted outcome.` },
        { inlineData: { mimeType: "image/jpeg", data: (await readFile(join(detailDirectory, images[index]))).toString("base64") },
          mediaResolution: { level: "MEDIA_RESOLUTION_HIGH" } });
      for (const decision of decisionWindows) {
        const decisionDirectory = join(detailDirectory, `decision-${String(decision.id).replace(/[^a-z0-9_-]/gi, '-')}`);
        await mkdir(decisionDirectory, { recursive: true });
        const fps = Math.min(2, 8 / Math.max(.1, decision.end - decision.start));
        await run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(decision.start),
          "-i", sourcePath, "-t", String(decision.end - decision.start), "-vf", `fps=${fps}:start_time=0`,
          "-q:v", "2", join(decisionDirectory, "decision-%04d.jpg")]);
        const decisionImages = (await readdir(decisionDirectory)).filter(name => /^decision-\d+\.jpg$/.test(name)).sort();
        for (let index = 0; index < decisionImages.length; index++) detailParts.push(
          { text: `Separate same-incident decision context ${decision.id}, original source ${(decision.start + index / fps).toFixed(3)}s. Observe the actual referee verdict; this image does not assert that the goal was allowed or disallowed.` },
          { inlineData: { mimeType: "image/jpeg", data: (await readFile(join(decisionDirectory, decisionImages[index]))).toString("base64") }, mediaResolution: { level: "MEDIA_RESOLUTION_HIGH" } });
      }
      const generated = await generateGeminiJson(ai, { model: process.env.GEMINI_MODEL,
        contents: [footballVideoPart((await readFile(video)).toString("base64"), 8), ...detailParts,
          {text: 'Separate physical finishing evidence from whether the finish counts. A broadcast angle need not expose the exact goal-line plane: continuous ball trajectory into the goal, ball/net response and concordant independently supplied context may jointly resolve a crossing. Score context alone or celebration alone is insufficient. When pixels contradict the score context, describe that conflict explicitly in uncertainties instead of confidently inventing a save, crossbar rebound, scorer or disallowance reason. For a header, inspect the actual contacting head and kit in the native sequence; do not invent a defending-player touch. A later score reversal is decision context, not evidence that the ball missed the net.'},
          { text: "Return the supplied one-scene outcome JSON schema. " + singleActionObservationContract() }],
        config: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 16384,
          thinkingConfig: { thinkingLevel: "LOW" },
          responseJsonSchema: { type: "object", required: ["goalScored", "goalDecision", "eventType", "description", "narrationFacts", "uncertainties"],
            properties: { goalScored: { type: "boolean" }, eventType: { type: "string", enum: ["goal", "save", "shot_on_target", "shot_off_target", "big_chance", "uncertain"] },
              goalDecision: { type: "string", enum: ["allowed", "disallowed", "unclear", "not_applicable"], description: "Only use disallowed when the supplied same-incident referee decision evidence visibly rules the goal out. Merely visiting a VAR monitor is not a verdict. Distinguish the physical ball crossing from whether that goal counts; explain the observed verdict in narrationFacts. Without decision evidence use unclear, not a guessed verdict." },
              description: { type: "string" }, narrationFacts: { type: "array", items: { type: "string" } },
              uncertainties: { type: "array", items: { type: "string" } } } } } }, `Independent goal outcome ${moment.id}`, 3);
      review = generated.parsed;
      await writeFile(cachePath, JSON.stringify(review));
    }
    if (outcomeEvidenceConflict(review,scoreContext,moment)) {
      const correctionPath=join(directory,`${key}-incident-conflict-v2.json`);
      let correction;
      try { correction=JSON.parse(await readFile(correctionPath,'utf8')); } catch {}
      if (!correction) {
        const current=await readJob(id);
        await updateJob(current,'tracking',Math.max(32,current.progress),{
          progressDetail:`Resolving conflicting outcome evidence for ${moment.id} with its original action and matching angles; discovery is retained.`});
        const video=join(directory,`${key}.mp4`);
        try { await stat(video); } catch {
          await run(ffmpegPath,['-hide_banner','-loglevel','error','-y','-ss',String(moment.startTime),'-i',sourcePath,
            '-t',String(moment.endTime-moment.startTime),'-vf','fps=12,scale=1280:-2','-an','-c:v','libx264','-preset','veryfast','-crf','18',video]);
        }
        const correctionDirectory=join(directory,`${key}.conflict`);
        await mkdir(correctionDirectory,{recursive:true});
        const times=outcomeConflictSampleTimes(moment);
        const parts=[{text:`PRIMARY action ${moment.id}, original source ${moment.startTime}-${moment.endTime}s. Resolve THIS action, not a different event in the supporting angles.`},footballVideoPart((await readFile(video)).toString('base64'),8)];
        for (const [index,time] of times.entries()) {
          const path=join(correctionDirectory,`full-${index}.jpg`);
          await run(ffmpegPath,['-hide_banner','-loglevel','error','-y','-ss',String(time),'-i',sourcePath,'-frames:v','1','-q:v','2',path]);
          parts.push({text:`Uncropped original source at scene-local ${(time-moment.startTime).toFixed(3)}s.`},
            {inlineData:{mimeType:'image/jpeg',data:(await readFile(path)).toString('base64')},mediaResolution:{level:'MEDIA_RESOLUTION_HIGH'}});
        }
        for(const [index,angle] of alternativeWindows.entries()) {
          const path=join(correctionDirectory,`angle-${index}.mp4`);
          await run(ffmpegPath,['-hide_banner','-loglevel','error','-y','-ss',String(angle.start),'-i',sourcePath,
            '-t',String(angle.end-angle.start),'-vf','fps=8,scale=1280:-2','-an','-c:v','libx264','-preset','veryfast','-crf','18',path]);
          parts.push({text:`Supporting angle ${angle.id}, source ${angle.start}-${angle.end}s, provisional replay label ${angle.isReplay}. Verify whether it depicts the SAME player movement, touches and outcome as the PRIMARY action. A different chance is not corroboration. These pixels are context only, never primary-scene keyframe coordinates.`},
            footballVideoPart((await readFile(path)).toString('base64'),6));
        }
        if(scoreContext) for(const [label,time] of [['before',scoreContext.before?.time],['after',scoreContext.after?.time],['reversal',scoreContext.reversalTime]]) {
          if(!Number.isFinite(time)) continue;
          const path=join(correctionDirectory,`score-${label}.jpg`);
          await run(ffmpegPath,['-hide_banner','-loglevel','error','-y','-ss',String(time),'-i',sourcePath,
            '-vf','crop=iw:ih/4:0:0','-frames:v','1','-q:v','2',path]);
          parts.push({text:`Native scoreboard ${label} at original source ${time}s. Context, NOT proof of physical crossing or a disallowance reason.`},
            {inlineData:{mimeType:'image/jpeg',data:(await readFile(path)).toString('base64')},mediaResolution:{level:'MEDIA_RESOLUTION_HIGH'}});
        }
        parts.push({text:`Resolve ONE primary action. Previous outcome draft ${JSON.stringify(review)}, separate neutral source observation ${JSON.stringify({eventType:moment.eventType,facts:moment.semanticNarrationFacts})}, independent live score context ${JSON.stringify(scoreContext)}. These drafts may be wrong; do not copy either. Reobserve the uncropped ORIGINAL pixels and compare only genuinely matching supporting angles. Independently identify the carrier's kit, final touch, moving ball, goalkeeper interaction and final ball location. Do not demand a front-on view of the goal-line plane when continuous trajectory into the goal, a matching replay and a net response resolve the result. An unchanged score does not invent a save/disallowance; an increased score does not turn a different missed shot into a goal. If the keeper retains the moving ball that is not net entry. State unresolved conflicts in uncertainties. ${singleActionObservationContract()}`});
        correction=(await generateGeminiJson(ai,{model:process.env.GEMINI_MODEL,contents:parts,
          config:{responseMimeType:'application/json',temperature:0,maxOutputTokens:16384,
            thinkingConfig:{thinkingLevel:'HIGH'},responseJsonSchema:outcomeObservationSchema()}},`Conflicting source outcome ${moment.id}`,3)).parsed;
        await writeFile(correctionPath,JSON.stringify(correction));
      }
      review=outcomeScoreConflict(correction,scoreContext,moment)
        ? {...correction,uncertainties:[...(correction.uncertainties||[]),'Physical outcome still conflicts with independent source score evidence; this incident is unresolved.']}
        : correction;
    }
    if(reusableCompletedOutcome(review)) await writeFile(acceptedPath,JSON.stringify({key:acceptedKey,review}));
    if (review.goalScored === true && review.eventType === "goal" && !review.uncertainties?.length) {
      const eventType = moment.eventType === "disallowed_goal" || review.goalDecision === "disallowed" ? "disallowed_goal" : "goal";
      // Outcome-only observation is not a geometry provider. Legacy cached
      // reviews may contain coordinates measured in magnified detail images.
      // Keep the independent full-source phase observation instead.
      const observedBrief = normalizeReviewedTrackingBrief({}, moment, eventType);
      return { ...moment, eventType, description: review.description, semanticNarrationFacts: review.narrationFacts,
        trackingBrief: { ...observedBrief, payoffTarget: "goal_mouth",
          ...(observedBrief?.payoffEvidence ? { payoffEvidence: {
            ...observedBrief.payoffEvidence, eventType } } : {}) },
        goalOutcomeCrosscheck: { version: GOAL_OUTCOME_VERSION, observationSignature, evidenceContextSignature:acceptedKey, verified: true, review } };
    } else if (review.goalScored === false && ["save", "shot_on_target", "shot_off_target", "big_chance"].includes(review.eventType)
      && !review.uncertainties?.length) {
      const corrected = { ...moment, eventType: review.eventType,
        description: review.description, semanticNarrationFacts: review.narrationFacts,
        goalOutcomeCrosscheck: { version: GOAL_OUTCOME_VERSION, observationSignature, evidenceContextSignature:acceptedKey, verified: true, corrected: true, review } };
      corrected.trackingBrief = normalizeReviewedTrackingBrief({}, corrected, review.eventType);
      return { ...corrected, semanticSignature: semanticSignature(corrected) };
    } else {
      return { ...moment, semanticVerified: false, keepDecision: "reject",
        rejectReason: "The independent original-scene review cannot verify the claimed goal outcome.",
        goalOutcomeCrosscheck: { version: GOAL_OUTCOME_VERSION, verified: false, review } };
    }
  });
  return reconcileVerifiedGoalDecisions(result).map(moment => ({ ...moment, semanticSignature: semanticSignature(moment) }));
}

async function prepareCompletedVisualNarration(job, selected, media, overlayMasks, tracking, matchContext, manifest) {
  const directory = join(outputRoot, job.id, 'visual-master');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'edited.mp4');
  const savedPath = join(directory, 'manifest.json');
  const info = await stat(job.sourceKey);
  const signature = stableSignature({ version: 2, source: job.sourceKey, bytes: info.size, mtime: info.mtimeMs,
    moments: selected.map(({ commentary, beatId, ...visual }) => visual), settings: job.settings,
    overlayMasks, tracking, matchContext });
  const profile = NARRATION_VIDEO_PROFILE;
  const proxy = join(directory, `narration-review-${signature.slice(0,16)}-v${profile.version}.mp4`);
  let completed;
  try {
    const saved = JSON.parse(await readFile(savedPath, 'utf8'));
    if (saved.signature === signature && (await stat(path)).size > 0
      && Math.abs((await probe(path)).duration - saved.manifest.selectedDuration) < .05) completed = saved;
  } catch { /* Render only if the exact finished visual checkpoint is absent. */ }
  if (!completed) {
    const result = await renderVideoV2(job.sourceKey, path, selected,
      { ...job.settings, commentary: false, originalAudio: 'muted', narrationSubtitles: false,
        sourceSceneDirectory: join(outputRoot,job.id,'source-scenes') },
      media, new Map(), overlayMasks, tracking, null, matchContext);
    const measured = await probe(path);
    const renderedManifest = renderedNarrationManifest(manifest, result, measured.duration);
    completed = { signature, path, result, media: measured,
      manifest: { ...renderedManifest, completedVideoSignature: signature } };
    await writeFile(savedPath, JSON.stringify(completed, null, 2));
  }
  // Narration sees the ENTIRE finished edit once, at its real output clock.
  // Precise contact/ball facts come from the unchanged HIGH-detail crop checks.
  // A profile change rebuilds only this proxy, never the approved visual master.
  let reusableProxy = false;
  try {
    const size = (await stat(proxy)).size;
    reusableProxy = size > 1024 && size <= 15 * 1024 * 1024
      && Math.abs((await probe(proxy)).duration - completed.manifest.selectedDuration) < 1 / profile.fps + .05;
  } catch { /* Only the small narration proxy is missing. */ }
  if (!reusableProxy) {
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path,
      '-vf', `scale=720:-2:flags=lanczos,fps=${profile.fps}`, '-an', '-c:v', 'libx264',
      '-preset', 'veryfast', '-crf', '26', '-movflags', '+faststart', proxy]);
  }
  if ((await stat(proxy)).size > 15 * 1024 * 1024) throw new Error('The completed narration review video exceeds the safe inline size.');
  return { ...completed, videoPart: footballVideoPart((await readFile(proxy)).toString('base64'), profile.fps, profile.resolution) };
}

async function makeCompletedTimelineSpeech(initialContent, manifest, id, matchContext, candidates) {
  const directory = join(outputRoot, id, 'speech', 'timed');
  await mkdir(directory, { recursive: true });
  let content = initialContent;
  const voiceSignature = [process.env.TTS_MODEL, process.env.TTS_LANGUAGE, process.env.TTS_VOICE, 'rendered-windows-v1'].join(':');
  const checkpointSignature = stableSignature({initialContent,visual:manifest.completedVideoSignature,voiceSignature});
  try {
    const saved=JSON.parse(await readFile(join(directory,'corrected-content.json'),'utf8'));
    if(saved.signature===checkpointSignature) content=saved.content;
  } catch { /* No corrected section checkpoint exists for this exact edit. */ }
  content=normalizeRecapResultEnding(content,matchContext);
  const takes = await recordTimedNarration(content, manifest, {
    record: async section => {
      const key = stableSignature({ id:section.id,narration: section.narration, duration: section.duration, voiceSignature });
      const path = join(directory, `${key}.wav`);
      let duration = 0;
      try { duration = await probeAudioDuration(path); } catch { /* Only this missing take needs recording. */ }
      if (!duration) {
        const rawPath = join(directory, `${key}.raw.wav`);
        await synthesizeGoogleCloudSpeech(section.narration, rawPath, { targetDuration: section.duration,
          onRetry: async detail => {
            await updateJob(await readJob(id), 'generating_commentary', 64, {
              progressDetail: `Google voice is busy; automatically retrying only section ${section.id}. Completed pictures and recordings are saved.`,
              voiceCapacityWait: { active: true, attempt: detail.attempt, reason:detail.reason, retryAt: new Date(Date.now()+detail.delayMs).toISOString() } });
          } });
        // Remove only leading/trailing silence, never internal speech or words.
        await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', rawPath,
          '-af', 'silenceremove=start_periods=1:start_duration=0.04:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_duration=0.04:start_threshold=-50dB,areverse',
          '-c:a', 'pcm_s16le', '-ar', '24000', '-ac', '1', path]);
        duration = await probeAudioDuration(path);
      }
      await writeFile(join(directory, `${key}.json`), JSON.stringify({ ...section, path, duration, voiceSignature }));
      return { path, duration };
    },
    onProgress: async ({section,pass,measuredDuration}) => {
      await updateJob(await readJob(id), 'generating_commentary', 64, {
        voiceCapacityWait: { active: false }, progressDetail:
          `Recorded section ${section.id}: ${measuredDuration.toFixed(1)}s for a ${section.duration.toFixed(1)}s visual window${measuredDuration>section.duration-.04 ? '; needs shorter wording' : '; fits at normal speed'}${pass ? '; only this section was shortened' : ''}. Video remains unchanged.` });
    },
    rewrite: async overlong => {
      await updateJob(await readJob(id), 'writing_content', 64, { progressDetail:
        `Shortening only ${overlong.length} overlong voice section(s). No whole-video review or complete-script rewrite.` });
      const ids = overlong.flatMap(section => section.ids);
      const schema = { type: 'object', required: ids, properties: Object.fromEntries(ids.map(sceneId => [sceneId, {type:'string'}])) };
      const generated = await generateGeminiJson(createGeminiClient(), {
        model: geminiWorkloadModel('script'), contents: [{text:
          'Shorten ONLY the requested recap sections to their measured spoken word budgets. Preserve the observed football cause, outcome, verified name bindings and interest. Basic English, no filler, production language, new events or changed scene order. Never say a selected chance seals or secures a draw or match result; state the verified final result separately. Return an object of exact scene IDs to narration strings. For linked reaction support, continue the same goal explanation, not celebration gestures.'},
          {text:JSON.stringify({overlong, approvedScript:content.contentBeats, reviewedVisualTimeline:manifest, matchContext})}],
        config:{responseMimeType:'application/json',responseJsonSchema:schema,temperature:.1,maxOutputTokens:8192,
          ...(/^gemini-3/.test(geminiWorkloadModel('script'))?{thinkingConfig:{thinkingLevel:'LOW'}}:{})}
      }, 'Shorten only overlong narration sections', 3);
      const beats = content.contentBeats.map(beat => ids.includes(beat.evidenceNeed)
        ? {...beat,narration:generated.parsed[beat.evidenceNeed]} : beat);
      if (beats.some(beat => typeof beat.narration !== 'string' || !beat.narration.trim())) throw new Error('A local narration correction omitted its scene words.');
      const updated = normalizeRecapResultEnding({...content,...normalizeContentPlan({...content,contentBeats:beats},manifest.selectedDuration)},matchContext);
      const problems = [...contentPlanProblems(updated,manifest.selectedDuration,candidates.length,
        verifiedLiveGoalActions(candidates).length,'requested',true,matchContext),
        ...contentEvidenceBindingProblems(updated.contentBeats,candidates),
        ...outcomeNarrationProblems(updated.contentBeats,manifest),
        ...recapTimelineProblems(updated.contentBeats,manifest),
        ...identityBindingProblems(updated.contentBeats,candidates,matchContext),
        ...obviousIdentityProblems(updated.contentScript,verifiedIdentityNames(matchContext))]
        .filter(problem=>!/^script_too_(?:short|long):/.test(problem));
      if(problems.length) throw new Error(`The local narration correction changed verified facts: ${problems.join(', ')}.`);
      content = updated;
      await writeFile(join(directory,'corrected-content.json'),JSON.stringify({signature:checkpointSignature,content},null,2));
      return Object.fromEntries(overlong.map(section => [section.id, section.ids.map(sceneId=>content.contentBeats.find(beat=>beat.evidenceNeed===sceneId).narration).join(' ')]));
    },
  });
  const output = join(directory, 'narration-master.wav');
  const filters = takes.map((take,index) => `[${index}:a]aresample=24000,apad,atrim=duration=${(take.endTime-take.startTime).toFixed(6)},adelay=${Math.round(take.startTime*1000)}:all=1[section${index}]`);
  filters.push(`${takes.map((_,index)=>`[section${index}]`).join('')}amix=inputs=${takes.length}:duration=longest:normalize=0,apad,atrim=duration=${manifest.selectedDuration.toFixed(6)}[voice]`);
  await run(ffmpegPath,['-hide_banner','-loglevel','error','-y',...takes.flatMap(take=>['-i',take.path]),
    '-filter_complex',filters.join(';'),'-map','[voice]','-c:a','pcm_s16le','-ar','24000','-ac','1',output]);
  const files = new Map([['__narration__',output]]);
  files.narrationDuration = await probeAudioDuration(output);
  files.narrationScript = content.contentScript;
  files.timedSections = takes;
  files.durations = new Map();
  files.preserveNaturalSpeed = true;
  await writeFile(join(directory,'master-manifest.json'),JSON.stringify({version:1,voiceSignature,
    visualSignature:manifest.completedVideoSignature,narration:content.contentScript, content,
    filename:'narration-master.wav',duration:files.narrationDuration,takes},null,2));
  return {files,content};
}

async function finishCompletedVisualNarration(completed, output, moments, settings, files) {
  const cues = (files.timedSections || []).flatMap(section => {
    const moment = moments.find(moment=>moment.id===section.id);
    return narrationSubtitleCues({...moment,commentary:section.narration},section.duration)
      .map(cue=>({...cue,start:cue.start+section.startTime,end:cue.end+section.startTime}));
  });
  const {width,height} = outputDimensions(settings);
  const subtitles = join(dirname(output),'timed-narration.ass');
  if(settings.captions) await writeFile(subtitles,captionAss(cues,Math.round(height*.79),width,height));
  const premix = join(dirname(output),'narrated-visual-master.mp4');
  await run(ffmpegPath,['-hide_banner','-loglevel','error','-y','-i',completed.path,'-i',files.get('__narration__'),
    '-filter_complex',`[0:a][1:a]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.96[a]`,
    '-map','0:v:0','-map','[a]',
    ...(settings.captions?['-vf',`ass=filename='${escapeFilterPath(subtitles)}'`,'-c:v','libx264','-preset','fast','-crf','18']:['-c:v','copy']),
    '-c:a','aac','-b:a','192k','-t',String(completed.manifest.selectedDuration),'-movflags','+faststart',premix]);
  const loudness = await normalizeFinishedAudio(premix,output);
  return {...completed.result,loudness,synchronization:files.timedSections.map(section=>({
    momentId:section.id,sceneIds:section.ids,narration:section.narration,visualStart:section.startTime,
    visualDuration:section.endTime-section.startTime,speechDuration:section.duration,normalVoiceSpeed:true}))};
}

async function writeAnalysisContentWithGemini(candidates, media, settings, verifiedEvidenceDuration, editableDuration, evidenceSlotCount, verifiedGoalActionCount, matchContext = null, visualReviewManifest = null,narrationTiming=null, jobId=null, completedVideoPart=null) {
  const model=geminiWorkloadModel('script');
  if (!candidates.length) {
    throw new Error("Narration is waiting for verified action scenes. Repair the locked player-and-ball tracks before writing; reaction-only footage cannot support a recap script.");
  }
  const ai = createGeminiClient();
  const allowedSceneIds = candidates.map(candidate => String(candidate.id));
  const lockedNarration = visualReviewManifest ? lockedNarrationContract(candidates, visualReviewManifest) : null;
  if (lockedNarration) settings = { ...settings, durationMode: 'requested', targetDuration: lockedNarration.selectedDuration };
  const responseJsonSchema = lockedNarration ? lockedNarrationResponseSchema(lockedNarration) : {
    type: "object",
    required: ["title", "editorialThesis", "storyQuestion", "storyAnswer", "contentBeats"],
    properties: {
      title: { type: "string" }, editorialThesis: { type: "string" }, contentAngle: { type: "string" },
      storyQuestion: { type: "string" }, storyAnswer: { type: "string" },
      contentBeats: { type: "array", items: { type: "object", required: ["beatId", "role", "narration", "evidenceNeed", "captionText"], properties: {
        beatId: { type: "string" }, role: { type: "string" }, narration: { type: "string" },
        evidenceNeed: { type: "string", enum: allowedSceneIds }, captionText: { type: "string" },
      } } },
    },
  };
  if(completedVideoPart) for(const scene of Object.values(responseJsonSchema.properties.sceneNarration.properties)) {
    if(!scene.required.includes('observedAction')) scene.required.push('observedAction');
    scene.properties.observedAction={type:'string',description:'What is actually visible in this completed-video window, without guessed names or unseen outcomes.'};
  }
  const identityBindings = bindVerifiedIdentitiesToIncidents(matchContext, candidates);
  const prompt = buildContentWritingPrompt({
    durationMode: settings.durationMode,
    sourceDuration: media.duration,
    targetDuration: settings.targetDuration,
    minimumDuration: minimumPlannedDuration(settings),
    verifiedEvidenceDuration,
    editableEvidenceDuration: editableDuration,
    evidenceSlotCount,
    verifiedGoalActionCount,
    completeHighlights: isCompleteHighlights(settings),
    matchContext,
    identityBindings,
    recapBrief: settings.recapBrief || "",
    visualReviewManifest,
    narrationTiming,
    lockedNarration,
    compactSceneManifest: Boolean(completedVideoPart),
  });
  const bindingByStory = new Map(identityBindings.map((binding) => [binding.storyId, binding]));
  const timeline = compactPlanningCandidates(candidates).map((candidate) => ({
    ...candidate,
    ...(() => {
      const reviewed=visualReviewManifest?.moments?.find(moment=>moment.candidateId===String(candidate.id));
      if(!reviewed?.cropObservations?.length) return {};
      return {description:reviewed.visualClaim,completionReason:reviewed.visualClaim,
        semanticNarrationFacts:reviewed.cropObservations.map(observation=>observation.description),
        keyActionTimes:reviewed.cropObservations.map(observation=>({time:observation.sourceTime,detail:observation.description})),
        analysisPurpose:"Explain only the observed pass, contact and finish; do not invent a save, rebound, dummy or player identity.",
        videoIntelligence:undefined};
    })(),
    verifiedIdentity: bindingByStory.get(String(candidate.storyId || candidate.id)),
  }));
  const writingEvidence = completedVideoPart
    ? { reviewedVisualTimeline: compactNarrationEvidence(visualReviewManifest, lockedNarration, identityBindings) }
    : { completeObservationTimeline: timeline, reviewedVisualTimeline: visualReviewManifest };
  const visualWritingContract="Approved crop observations, when present, supersede older source-discovery notes. Write basic everyday English, using short clear sentences: avoid terms such as clinical execution, exploits, dictate, fine margins, resolute, incisive or attacking persistence. For a verified match, name the fixture simply in the opening beat and finish the last beat with the verified final result. Do not begin with an abstract tactical question. Keep an energetic, understandable chronological recap. Never add a save, rebound, dummy, mistake or technique not explicitly visible in those observations. Obey outcomeNarrationPolicy: when reviewers disagree on the physical mechanism, use only its confirmedFacts; do not claim a save, post, crossbar, block, corner or score at that chance. The match's final score is not evidence of the score when an earlier chance happened. Never invent a current score because scenes have been reordered.";
  const draftContent = raw => {
    try {
      const content = normalizeContentPlan(lockedNarration ? projectLockedNarration(raw, lockedNarration) : raw, settings.targetDuration);
      return { content: { ...content, ...(lockedNarration ? { lockedNarrationContractVersion: lockedNarration.version } : {}),
        ...(completedVideoPart ? {completedVideoObservations:Object.entries(raw.sceneNarration||{}).map(([candidateId,scene])=>({candidateId,observedAction:scene.observedAction}))} : {}) }, problems: [] };
    } catch (error) {
      return { content: normalizeContentPlan({}, settings.targetDuration), problems: [error.message] };
    }
  };
  const validateContent = content => [
    ...contentPlanProblems(content, settings.targetDuration, evidenceSlotCount, verifiedGoalActionCount, settings.durationMode, isCompleteHighlights(settings), matchContext,narrationTiming),
    ...contentEvidenceBindingProblems(content.contentBeats, candidates),
    ...outcomeNarrationProblems(content.contentBeats,visualReviewManifest),
    ...recapTimelineProblems(content.contentBeats,visualReviewManifest),
    ...obviousIdentityProblems(content.contentScript, verifiedIdentityNames(matchContext)),
    ...identityBindingProblems(content.contentBeats, candidates, matchContext),
    ...(completedVideoPart && (content.completedVideoObservations?.length !== candidates.length
      || content.completedVideoObservations.some(scene=>typeof scene.observedAction!=='string'||!scene.observedAction.trim()))
      ? ['completed_video_observations_missing'] : []),
    ...(lockedNarration && (content.lockedNarrationContractVersion !== lockedNarration.version
      || content.contentBeats.length !== lockedNarration.slots.length
      || content.contentBeats.some((beat,index)=>beat.evidenceNeed !== lockedNarration.slots[index]?.candidateId))
      ? ['locked_narration_must_cover_every_reviewed_scene'] : []),
  ].filter(problem => !visualReviewManifest?.completedVideoRendered || !/^script_too_(?:short|long):/.test(problem));
  const scriptKey = jobId && lockedNarration ? stableSignature({ version: 1, model,
    contract: lockedNarration, timeline, visualReviewManifest, settings, matchContext, narrationTiming }) : null;
  const scriptDirectory = jobId ? join(outputRoot, jobId, 'narration') : null;
  const scriptPath = scriptKey ? join(scriptDirectory, `${scriptKey}.json`) : null;
  if (scriptPath) {
    await mkdir(scriptDirectory, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(scriptPath, 'utf8'));
      if (saved.approved === true && validateContent(saved.content).length === 0) return saved.content;
    } catch { /* The exact approved script is not available yet. */ }
    if(completedVideoPart) try {
      const saved = JSON.parse(await readFile(join(scriptDirectory,`${scriptKey}.draft.json`),'utf8'));
      const draft=draftContent(saved.raw);
      if(!draft.problems.length && !validateContent(draft.content).length) {
        const approved={...draft.content,verifiedIdentityBindings:identityBindings,
          completedVideoReviewed:true,narrationProductionVersion:1};
        await writeFile(scriptPath,JSON.stringify({approved:true,content:approved},null,2));
        return approved;
      }
    } catch { /* A genuinely invalid draft still needs a new script, not approval. */ }
  }
  let generated = await generateGeminiJson(ai, {
    model,
    contents: [{ text: prompt }, {text:visualWritingContract},
      ...(completedVideoPart ? [{ text: 'Watch this ENTIRE completed muted edit once, in playback order, before writing. Its output timestamps are the narration clock, not source timestamps. For each scene record observedAction from this video before composing its narration. If the actual video and older text notes disagree about a save, post, block or miss, describe only the confirmed non-goal chance rather than asserting the disputed mechanism. Player names remain restricted to verified incident bindings. Establish the verified fixture immediately, build interest with specific visible causes and turning points, then conclude with the verified result. Use basic English. Do not introduce unseen events or narrate production instructions.' }, completedVideoPart,
        ] : []),
      { text: JSON.stringify(writingEvidence) }],
    config: { responseMimeType: "application/json", responseJsonSchema, temperature: 0.16,
      maxOutputTokens:16384,...(/^gemini-3/.test(model)?{thinkingConfig:{thinkingLevel:'LOW'}}:{}) },
  }, "Gemini recap script", 3);
  let parsed = draftContent(generated.parsed);
  let content = parsed.content;
  let problems = [...parsed.problems, ...validateContent(content)];
  for (let correctionAttempt = 1; problems.length && correctionAttempt <= (completedVideoPart ? 1 : 3); correctionAttempt += 1) {
    if (scriptKey) await writeFile(join(scriptDirectory, `${scriptKey}.draft.json`), JSON.stringify({
      approved: false, correctionAttempt, problems, raw: generated.parsed }, null, 2));
    const { minimumWords, maximumWords } = narrationWordBudget(settings.targetDuration, settings.durationMode, isCompleteHighlights(settings),narrationTiming);
    generated = await generateGeminiJson(ai, {
      model,
      contents: [
        { text: prompt },
        {text:visualWritingContract},
        { text: [
          `Correction attempt ${correctionAttempt} of 3. Rewrite the content completely and correct every validation failure: ${problems.join(", ")}.`,
          completedVideoPart ? 'Keep each narration inside its rendered scene window. Do not expand wording to satisfy an estimated global word count.'
            : `The narration contentScript must contain ${minimumWords}-${maximumWords} words after normalization; count the words before returning it.`,
          "Expand with concrete, visible tactical explanation inside the same evidence beats, never filler, invented action, or a different candidateId.",
          "Preserve every verified scorer, team, and incident binding exactly. Return the required JSON only.",
        ].join(" ") },
        { text: JSON.stringify({ ...writingEvidence, rejectedDraft: content }) },
      ],
      config: { responseMimeType: "application/json", responseJsonSchema, temperature: 0.1,
        maxOutputTokens:16384,...(/^gemini-3/.test(model)?{thinkingConfig:{thinkingLevel:'LOW'}}:{}) },
    }, `Gemini recap script correction ${correctionAttempt}`, 3);
    parsed = draftContent(generated.parsed);
    content = parsed.content;
    problems = [...parsed.problems, ...validateContent(content)];
  }
  if (problems.length) throw new Error("Gemini content draft failed validation: " + problems.join(", "));
  const approved = { ...content, verifiedIdentityBindings: identityBindings,
    ...(completedVideoPart ? { completedVideoReviewed: true, narrationProductionVersion: 1 } : {}) };
  if (scriptPath) await writeFile(scriptPath, JSON.stringify({ approved: true, content: approved }, null, 2));
  return approved;
}

async function alignContentToVideoWithGemini(content, candidates, settings, verifiedEvidenceDuration, editableDuration) {
  const ai = createGeminiClient();
  const prompt = buildEvidenceAlignmentPrompt({
    durationMode: settings.durationMode,
    targetDuration: settings.targetDuration,
    minimumDuration: minimumPlannedDuration(settings),
    intensity: settings.intensity,
    verifiedEvidenceDuration,
    editableEvidenceDuration: editableDuration,
    expectedBeatCount: content.contentBeats.length,
  })
    + " " + footballAlignmentContract();
  const timeline = compactPlanningCandidates(candidates);
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const sequenceProblemsFor = (segments) => {
    const scenes = (Array.isArray(segments) ? segments : []).flatMap((segment, index) => {
      const candidate = candidateById.get(String(segment.candidateId));
      return candidate ? [{ ...candidate, selectedForFinalVideo: true, editOrder: index }] : [];
    });
    return [...highlightSequenceProblems(scenes, { availableMoments: candidates, requireAvailableCompanionsOnly: isCompleteHighlights(settings) }),
      ...incidentCoverage(candidates, scenes).missing.map(i=>`missing_required_incident:${i.id}`)];
  };
  const beatMap = new Map(content.contentBeats.map((beat) => [beat.beatId, beat]));
  const requestAlignment = async (correction = "") => {
    const generated = await generateGeminiJson(ai, {
      model: process.env.GEMINI_MODEL,
      contents: [
        { text: prompt + (correction ? " " + correction : "") },
        { text: JSON.stringify({ approvedContent: content, completeObservationTimeline: timeline }) },
      ],
      config: { responseMimeType: "application/json", temperature: 0.08 },
    }, "Gemini evidence alignment", 3);
    const parsed = generated.parsed;
    const seenCandidateIds = new Set();
    let parsedSegments = (Array.isArray(parsed.segments) ? parsed.segments : []).filter((segment) => {
      const candidateId = String(segment?.candidateId || "");
      if (!candidateById.has(candidateId) || seenCandidateIds.has(candidateId)) return false;
      seenCandidateIds.add(candidateId);
      return true;
    });
    const includedNarratableCount = parsedSegments.filter((segment) => narratableEvidence(candidateById.get(String(segment.candidateId)))).length;
    const missingNarratableCount = Math.max(0, content.contentBeats.length - includedNarratableCount);
    const verifiedAdditions = selectDirectorCandidates(candidates)
      .filter((candidate) => narratableEvidence(candidate) && !seenCandidateIds.has(String(candidate.id)))
      .sort((left, right) => Number(left.startTime) - Number(right.startTime))
      .slice(0, missingNarratableCount)
      .map((candidate) => ({
        candidateId: candidate.id, beatId: "", startTime: candidate.startTime, endTime: candidate.endTime,
        role: "evidence", analysisPurpose: "Additional verified action supporting the approved chronological recap.",
        transformationReason: "Complete the approved narration with unique locally verified footage.",
        transitionIn: "cut", transitionDuration: 0.08, effect: candidate.isReplay ? "replay_treatment" : "none",
        freezeAtPhase: "none", freezeDuration: 0, playbackRate: 1, playerHighlight: false, tacticalDrawing: "none",
        onScreenText: "THE KEY MOMENT", eventCallout: "none", colorGrade: candidate.isReplay ? "replay_blue" : "clean", soundEffect: "none",
      }));
    parsedSegments = [...parsedSegments, ...verifiedAdditions]
      .sort((left, right) => Number(candidateById.get(String(left.candidateId))?.startTime || 0) - Number(candidateById.get(String(right.candidateId))?.startTime || 0))
      .map((segment, editOrder) => ({ ...segment, editOrder }));
    const assignments = new Map();
    const seenBeats = new Set();
    parsedSegments.forEach((segment, index) => {
      const beat = beatMap.get(String(segment.beatId));
      const candidate = candidateById.get(String(segment.candidateId));
      const reaction = candidate && (candidate.eventType === "celebration" || candidate.storyPhase === "reaction");
      if (beat && !reaction && !seenBeats.has(beat.beatId)) {
        assignments.set(index, beat);
        seenBeats.add(beat.beatId);
      }
    });
    const missingBeats = content.contentBeats.filter((beat) => !seenBeats.has(beat.beatId));
    const unusedActionIndexes = parsedSegments.flatMap((segment, index) => {
      const candidate = candidateById.get(String(segment.candidateId));
      const reaction = candidate && (candidate.eventType === "celebration" || candidate.storyPhase === "reaction");
      return !reaction && !assignments.has(index) ? [index] : [];
    });
    missingBeats.slice(0, unusedActionIndexes.length).forEach((beat, index) => assignments.set(unusedActionIndexes[index], beat));
    const segments = parsedSegments.map((segment, index) => {
      const beat = assignments.get(index);
      return {
        ...segment,
        beatId: beat?.beatId || "",
        commentary: beat?.narration || "",
        onScreenText: beat?.captionText || "NEXT BIG CHANCE",
        analysisPurpose: segment.analysisPurpose || beat?.evidenceNeed,
      };
    });
    return { rationale: String(parsed.rationale || "Content-led evidence alignment"), segments };
  };
    const alignmentMinimum = isCompleteHighlights(settings) ? Number(settings.durationMin ?? COMPLETE_RECAP_MINIMUM_SECONDS) : minimumPlannedDuration(settings);
  let alignment = await requestAlignment();
  if (settings.durationMode !== "auto") alignment = { ...alignment, segments: fitSegmentPlaybackToDuration(alignment.segments, settings.targetDuration) };
  let duration = plannedSegmentDuration(alignment.segments);
  const coveredBeats = new Set(alignment.segments.map((segment) => segment.beatId)).size;
  let sequenceProblems = sequenceProblemsFor(alignment.segments);
  if (duration < alignmentMinimum
    || duration > planningCeiling(settings) + 3
    || coveredBeats < content.contentBeats.length
    || sequenceProblems.length) {
    alignment = await requestAlignment(
      "The previous alignment was incomplete. Cover every beat exactly once with narration, add supporting evidence clips when needed, and make the visual timeline at least "
      + (settings.durationMode === "auto" ? alignmentMinimum + " seconds, ending naturally after the complete story; do not pad to the estimated duration" : settings.targetDuration + " seconds without exceeding " + (settings.targetDuration + 3) + " seconds") + ". Correct these goal-sequence failures: "
      + (sequenceProblems.length ? sequenceProblems.join(", ") : "none")
      + ". A live goal must be followed immediately by its same-story celebration and/or replay, and its reaction must appear before another incident.",
    );
    if (settings.durationMode !== "auto") alignment = { ...alignment, segments: fitSegmentPlaybackToDuration(alignment.segments, settings.targetDuration) };
    duration = plannedSegmentDuration(alignment.segments);
    sequenceProblems = sequenceProblemsFor(alignment.segments);
  }
  const finalCoveredBeats = new Set(alignment.segments.filter((segment) => segment.commentary).map((segment) => segment.beatId)).size;
  if (duration < alignmentMinimum
    || duration > planningCeiling(settings) + 3
    || finalCoveredBeats < content.contentBeats.length
    || sequenceProblems.length) {
    throw new Error(`Gemini evidence alignment failed validation: ${duration.toFixed(1)} seconds (minimum ${alignmentMinimum.toFixed(1)}), ${finalCoveredBeats}/${content.contentBeats.length} narration beats covered${sequenceProblems.length ? `; ${sequenceProblems.join(", ")}` : "."}`);
  }
  return { ...content, rationale: alignment.rationale, plannedDuration: duration, segments: alignment.segments };
}
async function alignContentReliably(content, candidates, settings, verifiedEvidenceDuration, editableDuration) {
  if (isCompleteHighlights(settings)) {
    const aligned = buildDeterministicEditPlan(candidates, settings, content);
    return {
      ...aligned,
      rationale: "Deterministic chronological alignment of the approved Gemini recap script to unique, locally verified football evidence.",
    };
  }
  if (!geminiEnabled) return buildDeterministicEditPlan(candidates, settings, content);
  try {
    return await alignContentToVideoWithGemini(content, candidates, settings, verifiedEvidenceDuration, editableDuration);
  } catch (error) {
    const fallback = buildDeterministicEditPlan(candidates, settings, content);
    return { ...fallback, rationale: "Deterministic evidence-safe fallback after invalid Gemini alignment: " + sanitizeProviderError(String(error?.message || error)) };
  }
}

function classifyGeminiError(error, model) {
  const raw = String(error?.message || error);
  if (/api key|unauthenticated|permission_denied|401|403/i.test(raw)) return new Error("Gemini authentication failed. Verify the Agent Platform API key and project access.");
  if (/model|not found|unsupported|404/i.test(raw)) return new Error(`Gemini model ${model} is unavailable for this Agent Platform key. No fallback model was selected.`);
  if (/quota|resource_exhausted|429|rate limit/i.test(raw)) return new Error("Gemini video request quota is temporarily exhausted. The configured account, billing, and text-generation connection are valid; wait for the quota window to reset or raise the Vertex AI quota.");
  if (/billing/i.test(raw)) return new Error("Gemini billing prevented video analysis. Verify the billing account linked to the Google Cloud project.");
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

function normalizeMoments(items, duration, offset = 0, knownStoryIds = new Set()) {
  const eventTypes = new Set(["goal", "disallowed_goal", "offside", "penalty", "assist", "big_chance", "shot_on_target", "shot_off_target", "save", "foul", "yellow_card", "red_card", "free_kick", "var", "skill", "dribble", "tackle", "celebration", "normal_play"]);
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
    const requestedKeepDecision = ["keep", "support", "replay", "reject"].includes(item.keepDecision) ? item.keepDecision : "keep";
    const storyPhase = ["hook", "build_up", "action", "payoff", "reaction", "replay", "standalone"].includes(item.storyPhase) ? item.storyPhase : "standalone";



    const minimumCompleteDuration = MIN_SCENE_SECONDS;
    const maximumCompleteDuration = MAX_SCENE_SECONDS;
    const actionDuration = endTime - startTime;
    const actionComplete = item.actionComplete === true
      && actionDuration >= minimumCompleteDuration
      && actionDuration <= maximumCompleteDuration;
    const keepDecision = requestedKeepDecision !== "reject" && !actionComplete ? "reject" : requestedKeepDecision;
    const storyKey = String(item.storyId || `scene-${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
    return [{
      id: `candidate-${Math.round(offset * 1000)}-${index + 1}`, startTime, endTime,
      eventType: eventTypes.has(item.eventType) ? item.eventType : "normal_play",
      storyId: knownStoryIds.has(item.storyId) ? item.storyId : `story-${Math.round(offset)}-${storyKey}`, storyPhase, keepDecision,
      actionComplete,
      completionReason: String(item.completionReason || (actionComplete ? "Visible action reaches a natural result." : "Action is incomplete or too short.")).slice(0, 220),
      keyActionTimes: (Array.isArray(item.keyActionTimes) ? item.keyActionTimes : []).flatMap((keyAction) => {
        const relativeTime = Number(keyAction?.time);
        if (!Number.isFinite(relativeTime)) return [];
        return [{
          time: clamp(offset + relativeTime, startTime, endTime),
          detail: String(keyAction?.detail || "Action detail").slice(0, 140),
        }];
      }).slice(0, 12),
      importanceScore: editorialScore, sourceImportanceScore: importance,
      hookScore, flowScore, visualClarity, excitementScore, narrativeCompleteness,
      description: String(item.description || "Observed football passage").slice(0, 240),
      rejectReason: String(item.rejectReason || "").slice(0, 200) || undefined,
      confidence: clamp(Number(item.confidence), 0, 1), ballVisible: Boolean(item.ballVisible), mainPlayerVisible: Boolean(item.mainPlayerVisible),
      isReplay: Boolean(item.isReplay) || storyPhase === "replay" || keepDecision === "replay",
      trackingBrief: normalizeTrackingBrief(item.trackingBrief, item, startTime, endTime, offset),
      recommendedCrop: [{ time: startTime, x: focusX, y: 0.5, confidence: clamp(Number(item.confidence), 0, 1) }],
      broadcastShotId: String(item.broadcastShotId || "") || undefined,
      broadcastShotIds: (Array.isArray(item.broadcastShotIds) ? item.broadcastShotIds : []).map(String),
      selectedForFinalVideo: false,
      commentary: String(item.commentary || "").slice(0, 220) || undefined,
      analysisPurpose: String(item.analysisPurpose || "").slice(0, 180) || undefined,
      onScreenText: cleanOverlayText(item.onScreenText, 6),
    }];
  });
  return normalized.sort((a, b) => a.startTime - b.startTime);
}

function normalizeInventoryCandidateMetadata(candidates) {
  return (Array.isArray(candidates) ? candidates : []).map((moment) => {
    if (!moment.broadcastShotId) return moment;
    const sourceImportanceScore = scoreField(moment.sourceImportanceScore, 45);
    const hookScore = scoreField(moment.hookScore, sourceImportanceScore);
    const flowScore = scoreField(moment.flowScore, sourceImportanceScore);
    const visualClarity = scoreField(moment.visualClarity, sourceImportanceScore);
    const excitementScore = scoreField(moment.excitementScore, sourceImportanceScore);
    const narrativeCompleteness = scoreField(moment.narrativeCompleteness, sourceImportanceScore);
    const importanceScore = Math.round(sourceImportanceScore * 0.34 + hookScore * 0.14 + flowScore * 0.12
      + visualClarity * 0.14 + excitementScore * 0.12 + narrativeCompleteness * 0.14);
    const duration = Number(moment.endTime) - Number(moment.startTime);
    const decisive = ["goal", "disallowed_goal", "shot_on_target", "shot_off_target", "save", "big_chance"].includes(moment.eventType);
    const durationComplete = decisive && duration >= 4 && duration <= MAX_SCENE_SECONDS;
    const visiblyResolved = !/incomplete|unresolved|unclear|cuts? before/i.test(String(moment.completionReason || ""));
    const restoreCompleteness = moment.actionComplete !== true && moment.semanticVerified !== false && durationComplete
      && visiblyResolved && moment.ballVisible === true && moment.mainPlayerVisible === true;
    return {
      ...moment,
      sourceImportanceScore, hookScore, flowScore, visualClarity, excitementScore, narrativeCompleteness, importanceScore,
      actionComplete: restoreCompleteness ? true : moment.actionComplete,
      keepDecision: restoreCompleteness ? (moment.isReplay || moment.storyPhase === "replay" ? "replay" : "keep") : moment.keepDecision,
      trackingDecision: restoreCompleteness && !moment.semanticVerified ? undefined : moment.trackingDecision,
      rejectReason: restoreCompleteness && !moment.semanticVerified ? undefined : moment.rejectReason,
    };
  });
}
function scoreField(value, fallback) {
  return normalizeEditorialScore(value, fallback);
}

function mergeAnalyzedMoments(items) {
  const unique = [...items]
    // A newly discovered correction must replace an overlapping interval that
    // pixel verification rejected, even if the stale guess scored higher.
    .sort((a, b) => Number(b.semanticVerified === true) - Number(a.semanticVerified === true)
      || Number(a.semanticVerified === false) - Number(b.semanticVerified === false)
      || b.importanceScore - a.importanceScore || b.confidence - a.confidence)
    .filter((item, index, ranked) => !ranked.slice(0, index).some((existing) => (
      temporalOverlap(item, existing) >= 0.82
      && item.eventType === existing.eventType
      && item.storyPhase === existing.storyPhase
    )))
    .sort((a, b) => a.startTime - b.startTime);
  const owners=new Map();
  for(const item of [...unique].sort((a,b)=>Number(b.semanticVerified===true)-Number(a.semanticVerified===true))) {
    if(item.id && !owners.has(String(item.id))) owners.set(String(item.id),item);
  }
  const usedIds=new Set(owners.keys());
  return unique.map((item) => {
    const extra=items.find(other=>other.sourceAdditionalAction===true
      && other.eventType===item.eventType && other.storyPhase===item.storyPhase
      && temporalOverlap(other,item)>=.82);
    let id=String(item.id || 'scene');
    if(owners.get(id)!==item) {
      const base=`${id}-${Math.round(item.startTime*1000)}-${Math.round(item.endTime*1000)}-${item.eventType}`;
      id=base;let suffix=2;
      while(usedIds.has(id)) id=`${base}-${suffix++}`;
      usedIds.add(id);
    }
    return {...item,...(extra ? {sourceAdditionalAction:true,
      sourceActionInventoryVersion:extra.sourceActionInventoryVersion} : {}),id};
  });
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

async function createLocalYouTubeImport(request, response) {
  const body = await readJsonBody(request, 32 * 1024);
  if (body.rightsConfirmed !== true) return json(response, 400, { error: "Confirm that you own or are authorized to use this video." });
  const normalized = normalizeAuthorizedYouTubeUrl(body.url);
  const id = randomUUID();
  const now = new Date().toISOString();
  const job = {
    id, stage: "importing", progress: 1, progressDetail: "YouTube import queued in the local background worker.",
    sourceKind: "youtube", sourceName: `YouTube ${normalized.videoId}.mp4`, sourceVideoId: normalized.videoId,
    sourcePageUrl: normalized.url, importUrl: normalized.url, readyToAnalyze: false,
    settings: parseSettings(String(body.editSettings || "")), moments: [], warnings: [], createdAt: now, updatedAt: now,
  };
  await saveJob(job);
  await jobQueue.submit(id, () => true, () => importLocalYouTubeSource(id));
  return json(response, 202, publicJob(job));
}

async function retryLocalYouTubeImport(response, id) {
  let job;
  try { job = await readJob(id); } catch { return json(response, 404, { error: "Import job not found." }); }
  if (job.sourceKind !== "youtube" || !job.importUrl || job.importedAt || job.stage !== "failed") return json(response, 409, { error: "This YouTube import cannot be retried." });
  if (jobQueue.has(id)) return json(response, 409, { error: "This import is already running." });
  const restarted = { ...job, stage: "importing", progress: 1, readyToAnalyze: false, progressDetail: "Retrying the saved video import." };
  delete restarted.error;
  await saveJob(restarted);
  await jobQueue.submit(id, () => true, () => importLocalYouTubeSource(id));
  return json(response, 202, publicJob(restarted));
}

async function importLocalYouTubeSource(id) {
  let job = await readJob(id);
  const directory = join(uploadRoot, id);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  let progressWrite = Promise.resolve();
  let lastProgress = -10;
  try {
    const onProgress = percent => {
      const rounded = Math.floor(percent / 5) * 5;
      if (rounded <= lastProgress) return;
      lastProgress = rounded;
      progressWrite = progressWrite.then(async () => {
        const current = await readJob(id);
        await saveJob({ ...current, stage: "importing", progress: Math.max(1, Math.min(99, rounded)), progressDetail: `Downloading the authorized video source: ${Math.round(percent)}%.` });
      });
    };
    const imported = await downloadAuthorizedYouTubeSource({
      url: job.importUrl,
      destinationDirectory: directory,
      ytDlpPath: resolveExecutable(process.env.YTDLP_PATH || "yt-dlp"),
      ffmpegPath,
      onProgress,
    });
    await progressWrite;
    const media = await probe(imported.sourcePath);
    assertSourceDuration(media.duration);
    job = await readJob(id);
    const { sourcePath, ...sourceMetadata } = imported;
    await saveJob({ ...job, ...sourceMetadata, media, sourceKey: sourcePath, stage: "uploaded", progress: 5, readyToAnalyze: true, progressDetail: "Download complete and verified. Choose edit settings, then click Analyze & edit.", importedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  } catch (error) {
    await progressWrite.catch(() => {});
    job = await readJob(id).catch(() => job);
    await saveJob({ ...job, stage: "failed", readyToAnalyze: false, error: { code: "SOURCE_IMPORT_FAILED", message: error instanceof Error ? error.message : String(error), retryable: true }, updatedAt: new Date().toISOString() });
  }
}

async function startLocalImportedJob(request, response, id) {
  if (jobQueue.has(id)) return json(response, 409, { error: "This source is already queued or processing." });
  let job;
  try { job = await readJob(id); } catch { return json(response, 404, { error: "Source not found." }); }
  if (job.stage !== "uploaded" || !job.readyToAnalyze || !job.sourceKey) return json(response, 409, { error: "Finish downloading and verifying the source before analysis." });
  try {assertSourceDuration(job.media?.duration);}
  catch(error){return json(response,422,{error:error.message,code:'SOURCE_VALIDATION'});}
  const body = await readJsonBody(request, 64 * 1024).catch(() => ({}));
  const next = { ...job, settings: body.editSettings ? parseSettings(String(body.editSettings)) : job.settings, readyToAnalyze: false, progressDetail: "Source selected. Waiting for the editing worker.", updatedAt: new Date().toISOString() };
  await saveJob(next);
  await jobQueue.submit(id, () => true, () => processJob(id));
  return json(response, 202, publicJob(next));
}

function buildLockedVisualOutline(candidates, settings, matchContext) {
  const fixedSelection=candidates.some(moment=>moment.selectionLocked && moment.fixedSceneQueueVersion===1);
  const ordered = analysisFirstIncidentOrder((Array.isArray(candidates) ? candidates : [])
    .filter((moment) => moment.selectionLocked === true && (fixedSelection || narratableEvidence(moment))));
  const identityBindings = bindVerifiedIdentitiesToIncidents(matchContext, ordered);
  const identityByStory = new Map(identityBindings.map((binding) => [String(binding.storyId), binding]));
  const beats = ordered.map((moment, index) => {
    const identity = identityByStory.get(String(moment.storyId || moment.id));
    const subject = identity?.scorer || identity?.team || "The attacking side";
    const visibleFact = (Array.isArray(moment.semanticNarrationFacts) && moment.semanticNarrationFacts[0])
      || moment.description
      || "The move reaches its visible outcome.";
    return {
      beatId: `visual-${index + 1}`,
      role: index === 0 ? "hook" : index === ordered.length - 1 ? "conclusion" : "analysis",
      narration: `${subject}: ${visibleFact}`,
      evidenceNeed: String(moment.id),
      captionText: moment.onScreenText || eventHeadline(moment),
    };
  });
  const home = matchContext?.status === "verified" ? matchContext.homeTeam : "Football";
  const away = matchContext?.status === "verified" ? matchContext.awayTeam : "Match";
  const outline = normalizeContentPlan({
    title: `${home} vs ${away} visual timeline`,
    editorialThesis: "Lock the verified football actions before narration is authored.",
    contentAngle: "A scene-bound visual outline used only for deterministic editing.",
    storyQuestion: "Which verified actions form the complete match recap?",
    storyAnswer: "The locked scenes preserve every verified incident and its visible outcome.",
    contentBeats: beats,
  }, settings.targetDuration);
  return { ...outline, verifiedIdentityBindings: identityBindings, visualOutline: true };
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

function applyNarrationToLockedVisualTimeline(moments, contentPlan) {
  const beats = Array.isArray(contentPlan?.contentBeats) ? contentPlan.contentBeats : [];
  const identityByStory = new Map((Array.isArray(contentPlan?.verifiedIdentityBindings)
    ? contentPlan.verifiedIdentityBindings : [])
    .map((binding) => [String(binding?.storyId || ""), binding]));
  const allMoments = Array.isArray(moments) ? moments : [];
  const selected = allMoments
    .filter((moment) => moment.selectedForFinalVideo)
    .sort((left, right) => Number(left.editOrder) - Number(right.editOrder));
  const selectedById = new Map(selected.map((moment) => [String(moment.id), moment]));
  const assignment = new Map();
  const assignedBeats = new Set();

  // New exact evidence bindings are authoritative on retries. Old beatId
  // fields belong to an earlier script and cannot move new narration onto a
  // different incident.
  for (const [evidenceId, beat] of assignContentBeatsToMoments(beats, selected)) {
    if (!selectedById.has(evidenceId) || assignedBeats.has(beat)) continue;
    assignment.set(evidenceId, beat);
    assignedBeats.add(beat);
  }

  // Gemini writes every recap beat against a locked scene id. Bind that exact
  // evidence first—even when it is a celebration/reaction—so narration and
  // Missing evidence is handled by rewriting the script against the locked
  // timeline before voice recording, never by moving a claim to another shot.
  return allMoments.map((moment) => {
    if (!moment.selectedForFinalVideo) return moment;
    const beat = assignment.get(String(moment.id));
    const verifiedIdentity = identityByStory.get(String(moment.storyId || moment.id));
    if (!beat) return { ...moment, verifiedIdentity, beatId: undefined, commentary: undefined };
    return {
      ...moment,
      verifiedIdentity,
      beatId: beat.beatId || moment.beatId,
      role: beat.role || moment.role,
      commentary: String(beat.narration || "").trim() || undefined,
      analysisPurpose: String(beat.evidenceNeed || moment.analysisPurpose || "").trim() || undefined,
      onScreenText: cleanOverlayText(beat.captionText || moment.onScreenText || eventHeadline(moment), 4),
    };
  });
}
function buildDeterministicEditPlan(candidates, settings, contentPlan) {
  const complete = isCompleteHighlights(settings);
  const fixedSelection = complete && candidates.some(moment=>moment.selectionLocked && moment.fixedSceneQueueVersion===1);
  const ranked = (fixedSelection ? candidates : limitIncidentActionViews(candidates))
    .filter((moment) => complete
      ? moment.selectionLocked === true
      : moment.keepDecision !== "reject" && moment.confidence >= 0.4 && framingEligible(moment))
    .sort((a, b) => Number(b.importanceScore || 0) - Number(a.importanceScore || 0));
  const hook = [...ranked].sort((a, b) => Number(b.hookScore || 0) - Number(a.hookScore || 0))[0];
  const ordered = complete ? analysisFirstIncidentOrder(ranked) : [
    ...(hook ? [hook] : []),
    ...ranked.filter((moment) => moment.id !== hook?.id).sort((a, b) => a.startTime - b.startTime),
  ];
  let total = 0;
  const selected = [];
  const beatAssignments = assignContentBeatsToMoments(contentPlan.contentBeats, ordered);
  for (const moment of ordered) {
    if (!complete && total >= settings.targetDuration) break;
    const effect = deterministicEffect(moment, settings.intensity);
    const sourceLength = moment.endTime - moment.startTime;
    const requestedPlaybackRate = effect === "slow_motion" ? 0.84 : effect === "speed_up" ? 1.12 : 1;
    const playbackRate = fixedSelection ? 1 : clamp(Math.max(requestedPlaybackRate, sourceLength / MAX_SCENE_SECONDS), 0.72, 1.18);
    const minimumOutputLength = minimumSceneSeconds(moment);
    const desiredOutput = sourceLength / playbackRate;
    if (!fixedSelection && desiredOutput < minimumOutputLength) continue;
    if (!fixedSelection && total + desiredOutput > (complete ? planningCeiling(settings) : settings.targetDuration + 3)) continue;
    const reaction = moment.eventType === "celebration" || moment.storyPhase === "reaction";
    const beat = beatAssignments.get(String(moment.id)) || null;
    selected.push({
      candidateId: moment.id,
      beatId: beat?.beatId || "support-" + (selected.length + 1),
      startTime: moment.startTime,
      endTime: moment.endTime,
      editOrder: selected.length,
      role: beat?.role || moment.storyPhase || "evidence",
      transitionIn: selected.length === 0 ? "cut" : moment.isReplay ? "flash" : "cut",
      transitionDuration: selected.length === 0 ? 0.04 : moment.isReplay ? 0.12 : 0.06,
      effect,
      playbackRate,
      playerHighlight: moment.playerHighlight !== false && moment.mainPlayerVisible && (moment.ballVisible || playerOnlyAllowed(moment)),
      commentary: beat?.narration || "",
      analysisPurpose: beat?.evidenceNeed || moment.analysisPurpose || "Support the approved football analysis with visible evidence.",
      transformationReason: "Use original tactical narration, full-screen reframing, and evidence-linked treatment to explain this content beat.",
      freezeAtPhase: "none",
      freezeDuration: 0,
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
      const rate = clamp(Number(moment.playbackRate || 1), 0.72, COMPLETE_HIGHLIGHT_MAX_PLAYBACK_RATE);
      const transition = index === 0 ? 0 : clamp(Number(moment.transitionDuration || 0.04), 0.04, 0.36);
      const freeze = moment.effect === "freeze_analysis" ? clamp(Number(moment.freezeDuration || 0.65), 0.4, 1) : 0;
      return total + (moment.endTime - moment.startTime) / rate + freeze - transition;
    }, 0);
}
function fitSelectedTimelineToCeiling(moments, targetDuration, maximumOverrun = 3) {
  const source = (Array.isArray(moments) ? moments : []).map((moment) => ({ ...moment }));
  const ceiling = Number(targetDuration) + Number(maximumOverrun);
  if (!Number.isFinite(ceiling) || selectedTimelineDuration(source) <= ceiling) return source;
  const withMultiplier = (multiplier) => source.map((moment) => moment.selectedForFinalVideo ? {
    ...moment,
    playbackRate: clamp(
      Number(moment.playbackRate || 1) * multiplier,
      0.72,
      moment.completeActionCompressed ? COMPLETE_HIGHLIGHT_MAX_PLAYBACK_RATE : 1.18,
    ),
  } : moment);
  let low = 1;
  let high = 2;
  let fitted = withMultiplier(high);
  if (selectedTimelineDuration(fitted) > ceiling) return fitted;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const middle = (low + high) / 2;
    const candidate = withMultiplier(middle);
    if (selectedTimelineDuration(candidate) > ceiling) low = middle;
    else { high = middle; fitted = candidate; }
  }
  return fitted;
}
function deterministicEffect(moment, intensity) {
  if (intensity === "natural") return moment.isReplay ? "replay_treatment" : "none";
  if (moment.isReplay) return "replay_treatment";
  if (["goal", "save", "shot_on_target", "shot_off_target", "big_chance"].includes(moment.eventType)) return "slow_motion";
  if (["skill", "dribble", "assist"].includes(moment.eventType)) return "punch_zoom";
  return intensity === "high_energy" ? "speed_up" : "none";
}

function sourceSelectionCapacity(candidates) {
  return renderableEvidenceCapacity(uniqueEvidenceCandidates((Array.isArray(candidates)?candidates:[])
    .filter(moment=>hasInitialSceneEvidence(moment,{requireSemanticVerification:true,minimumSeconds:MIN_SCENE_SECONDS}))
    .map(trimToVerifiedActionOrigin)), .08, { maximumReactionSeconds: 7 });
}

function chooseInitialScenesForLock(candidates, settings, {requireSemanticVerification=true,sourceDuration=0,sectionPlan,allowCoverageShortfall=false}={}) {
  const verifiedReplayEvents = new Set(["goal", "disallowed_goal", "save", "shot_on_target", "shot_off_target", "big_chance"]);
  const source = uniqueEvidenceCandidates((Array.isArray(candidates) ? candidates : [])
    .filter(moment => !moment.sourceAngleDeferred && !moment.sourceSupportDeferred)
    .filter(moment => hasInitialSceneEvidence(moment,{requireSemanticVerification,minimumSeconds:MIN_SCENE_SECONDS}))
    .filter(moment => !(moment.isReplay || moment.storyPhase === "replay") || verifiedReplayEvents.has(moment.eventType)));
  const minimum = minimumPlannedDuration(settings);
  const compressedCapacity = moment => {
    const sourceLength = Math.max(0, Number(moment.endTime) - Number(moment.startTime));
    const reaction = moment.eventType === "celebration" || moment.storyPhase === "reaction";
    // Step 1 is the source split/lock stage. A reviewed celebration is real
    // source evidence and may run longer than the three-second presentation
    // cap used by the final renderer. Capping it here made otherwise valid
    // 60-second scene pools report 53–59 seconds and triggered needless
    // Gemini recovery before tracking even started.
    if (reaction) return Math.min(7, sourceLength);
    return Math.min(MAX_SCENE_SECONDS,sourceLength) / completeActionPlaybackRate(sourceLength, 0);
  };
  const desired = Math.max(minimum, Math.min(Number(settings?.targetDuration || minimum), planningCeiling(settings)));
  const reserveSeconds = Math.max(30, desired * 0.50);
  const target = Math.min(
    source.reduce((sum, moment) => sum + compressedCapacity(moment), 0),
    desired + reserveSeconds,
  );
  const decisiveEvents = new Set(["goal", "disallowed_goal", "offside", "var"]);
  const scoredStories = [...new Set(source.filter(moment => decisiveEvents.has(moment.eventType))
    .map(moment => String(moment.storyId || moment.id)))];
  const requiredStories = new Set(scoredStories);
  const selected = new Set();
  const capacitySelected = new Set();
  for (const storyId of requiredStories) {
    const story = source.filter(moment => String(moment.storyId || moment.id) === String(storyId));
    const actionAngles = story.filter(moment => ["goal", "disallowed_goal"].includes(moment.eventType))
      .sort((a, b) => incidentViewQualityScore(b) - incidentViewQualityScore(a)
        || Number(a.startTime) - Number(b.startTime));
    // Lock the preverified primary plus its same-incident reserve. Portrait
    // tracking may prefer either, but only one can count toward duration.
    const anchoredAngles=actionAngles.filter(moment=>moment.sourceAngleSelected||moment.sourceAngleReserved);
    const sourceChosen = anchoredAngles.filter(moment=>moment.sourceAngleSelected);
    const firstLive = actionAngles.filter(moment=>!moment.isReplay && moment.storyPhase!=='replay')
      .sort((a,b)=>Number(a.startTime)-Number(b.startTime));
    const probeAngles=(sourceChosen.length?sourceChosen:firstLive.length?firstLive:actionAngles).slice(0,1);
    for (const moment of probeAngles) selected.add(moment.id);
    if (probeAngles[0]) capacitySelected.add(probeAngles[0].id);
    const support = story.filter(moment => !["goal", "disallowed_goal"].includes(moment.eventType))
      .sort((a, b) => Number(b.importanceScore || 0) - Number(a.importanceScore || 0))[0];
    if (support) {
      selected.add(support.id);
      capacitySelected.add(support.id);
    }
  }
  for (const moment of source.filter(moment => decisiveEvents.has(moment.eventType)
    && !["goal", "disallowed_goal"].includes(moment.eventType))) {
    selected.add(moment.id);
    capacitySelected.add(moment.id);
  }
  const seconds = () => {
    const chosen=uniqueEvidenceCandidates(source.filter(moment=>capacitySelected.has(moment.id)));
    return Math.max(0,chosen.reduce((total,moment)=>total+compressedCapacity(moment),0)-Math.max(0,chosen.length-1)*.08);
  };
  const ranked = source.filter(moment => !selected.has(moment.id))
    .sort((a, b) => {
      const priority = moment => ({ save: 5, shot_on_target: 5, big_chance: 4, shot_off_target: 2 }[moment.eventType] || 1);
      return priority(b) - priority(a)
        || Number(b.importanceScore || 0) - Number(a.importanceScore || 0)
        || Number(b.narrativeCompleteness || 0) - Number(a.narrativeCompleteness || 0)
        || (Number(a.endTime) - Number(a.startTime)) - (Number(b.endTime) - Number(b.startTime))
        || Number(a.startTime) - Number(b.startTime);
    });
  if(sourceDuration>0) {
    const balanced=selectSectionSceneIds([...source.filter(scene=>selected.has(scene.id)),...ranked],selected,
      sectionPlan||step1DiscoveryPlan(sourceDuration,desired),compressedCapacity);
    for(const id of balanced) {selected.add(id);capacitySelected.add(id);}
  }
  for (const moment of ranked) {
    if (seconds() >= target) continue;
    selected.add(moment.id);
    capacitySelected.add(moment.id);
  }
  const selectedSeconds = seconds();
  if (selectedSeconds < minimum && !allowCoverageShortfall) {
    throw new Step1CoverageError(selectedSeconds, minimum);
  }
  return (Array.isArray(candidates) ? candidates : []).map(moment => {
    const sameStoryAngles = source.filter(candidate =>
      String(candidate.storyId || candidate.id) === String(moment.storyId || moment.id)
      && ["goal", "disallowed_goal"].includes(candidate.eventType))
      .sort((a, b) => incidentViewQualityScore(b) - incidentViewQualityScore(a)
        || Number(a.startTime) - Number(b.startTime));
    const angleRank = sameStoryAngles.findIndex(candidate => candidate.id === moment.id);
    return {
      ...moment,
      ...(angleRank >= 0 ? { incidentAngleCandidate: true, incidentAngleRank: angleRank + 1 } : {}),
      sceneSelectionApproved: selected.has(moment.id),
      selectionDecision: selected.has(moment.id) ? "approved_in_step_1" : "removed_during_scene_selection",
    };
  });
}

function promoteRemainingScenesForLock(candidates) {
  return (Array.isArray(candidates) ? candidates : []).map((moment) => {
    const promotable = moment.selectionLocked !== true
      && hasInitialSceneEvidence(moment,{requireSemanticVerification:true,minimumSeconds:MIN_SCENE_SECONDS});
    if (!promotable) return moment;
    return {
      ...moment,
      sceneSelectionApproved: true,
      selectionLocked: true,
      selectionDecision: "promoted_from_step_1_reserve",
      selectionKeepDecision: moment.isReplay || moment.storyPhase === "replay" ? "replay" : "keep",
      keepDecision: moment.isReplay || moment.storyPhase === "replay" ? "replay" : "keep",
      selectedForFinalVideo: false,
    };
  });
}
function lockInitialSceneSelection(candidates, { requireSemanticVerification = false, fixedSelection = false } = {}) {
  return (Array.isArray(candidates) ? candidates : []).map((moment) => {
    const approved = moment.sceneSelectionApproved === true
      && hasInitialSceneEvidence(moment,{requireSemanticVerification,minimumSeconds:MIN_SCENE_SECONDS});
    if (!approved) return { ...moment, selectionLocked: false, selectionDecision: "removed_during_scene_selection" };
    const selectionKeepDecision = moment.isReplay || moment.storyPhase === "replay" ? "replay" : "keep";
    return {
      ...moment,
      ...(fixedSelection ? { fixedSceneQueueVersion: 1, sourceAngleSelectionPolicy: LIVE_FIRST_SELECTION_POLICY,
        sourceAngleReserved: false, chosenIncidentAngle: ['goal','disallowed_goal'].includes(moment.eventType) } : {}),
      selectionLocked: true,
      selectionDecision: "approved",
      selectionKeepDecision,
      keepDecision: selectionKeepDecision,
      selectedForFinalVideo: false,
    };
  });
}

function preserveLockedSceneSelection(candidates) {
  return (Array.isArray(candidates) ? candidates : []).map((moment) => {
    if (moment.selectionLocked !== true) return moment;
    const semanticReviewReason = moment.semanticVerified === false
      ? String(moment.rejectReason || "Semantic review was uncertain.").slice(0, 240)
      : moment.semanticReviewReason;
    return {
      ...moment,
      keepDecision: moment.selectionKeepDecision || (moment.isReplay || moment.storyPhase === "replay" ? "replay" : "keep"),
      selectedForFinalVideo: false,
      trackingDecision: moment.trackingDecision === "semantic_mismatch"
        ? "selection_locked_semantic_advisory"
        : moment.trackingDecision,
      rejectReason: undefined,
      semanticReviewReason,
    };
  });
}

function retainLockedSceneForPortrait(moment, reason, selectedForFinalVideo = false, evidence = null) {
  const repairReason = String(reason || "tracking_unavailable");
  const hasTrackedCamera = Array.isArray(evidence?.keyframes) && evidence.keyframes.length > 1;
  const reactionOnly = playerOnlyAllowed(moment);
  return {
    ...moment,
    keepDecision: moment.selectionKeepDecision || (moment.isReplay || moment.storyPhase === "replay" ? "replay" : "keep"),
    selectedForFinalVideo: Boolean(selectedForFinalVideo),
    trackingDecision: "selection_locked_portrait_repair",
    portraitRepairReason: repairReason,
    rejectReason: undefined,
    playerHighlight: reactionOnly ? false : moment.playerHighlight,
    tacticalDrawing: "none",
    effect: moment.isReplay || moment.storyPhase === "replay" ? "replay_treatment" : "none",
    fallbackPresentation: {
      mode: hasTrackedCamera ? "conservative_tracked_portrait" : "stable_vertical_crop",
      reason: repairReason,
      markerSuppressed: true,
      dynamicCameraSuppressed: !hasTrackedCamera,
    },
  };
}
function playerOnlyAllowed(moment) {
  return playerOnlyEvidenceAllowed(moment);
}

function narratableEvidence(moment) {
  return framingEligible(moment) && moment.eventType !== "celebration" && moment.storyPhase !== "reaction";
}

function verifiedLiveGoalActions(moments) {
  return (Array.isArray(moments) ? moments : []).filter((moment) => moment.eventType === "goal"
    && moment.semanticVerified === true
    && ((!moment.isReplay && moment.storyPhase !== "replay") || verifiedPrimaryReplayGoal(moment))
    && moment.actionComplete !== false
    && moment.keepDecision !== "reject"
    && !["analysis_rejected", "not_tracked", "rejected_after_plan"].includes(moment.trackingDecision));
}

function minimumSceneSeconds() {
  return MIN_SCENE_SECONDS;
}

function framingEligible(moment) {
  if (isDecisionScene(moment)) return moment.semanticVerified === true
    && moment.trackingPassed === true && moment.keepDecision !== "reject";
  if (playerOnlyAllowed(moment)) return true;
  if (moment?.trackingPassed === false) return false;
  if (moment?.selectionLocked === true && moment.semanticVerified === true && moment.keepDecision !== 'reject') {
    return moment.trackingPassed === true
      && Boolean(moment.ballVisible) && Boolean(moment.mainPlayerVisible);
  }
  if (moment?.selectionLocked === true) return moment.semanticVerified === true
    && moment.keepDecision !== "reject"
    && moment.trackingDecision !== "selection_locked_portrait_repair"
    && Boolean(moment.ballVisible) && Boolean(moment.mainPlayerVisible);
  return Boolean(moment.ballVisible) && Boolean(moment.mainPlayerVisible);
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
    goal: "⚽ WHAT A FINISH",
    penalty: "🎯 THE DECISIVE MOMENT",
    assist: "🟢 PERFECTLY WEIGHTED PASS",
    big_chance: "🔥 SO CLOSE",
    shot_off_target: "↗ JUST WIDE",
    shot_on_target: "🎯 WHAT A SHOT",
    save: "🧤 GREAT SAVE",
    foul: "⚠ CLEAR FOUL",
    yellow_card: "🟨 YELLOW CARD",
    red_card: "🟥 RED CARD",
    free_kick: "🎯 SET PIECE DANGER",
    var: "🔎 DECISION UNDER REVIEW",
    skill: "✨ AMAZING CONTROL",
    dribble: "💨 DEFENDER BEATEN",
    tackle: "🛡 PERFECTLY TIMED",
    celebration: "🙌 PURE EMOTION",
    normal_play: "👀 WATCH THE MOVEMENT",
  };
  return headlines[moment.eventType] || "KEY MOMENT";
}

function calloutForEvent(moment) {
  if (moment.eventType === "goal") return "goal";
  if (["yellow_card", "red_card"].includes(moment.eventType)) return "card";
  if (moment.eventType === "foul") return "foul";
  if (moment.eventType === "save") return "save";
  if (["shot_on_target", "shot_off_target"].includes(moment.eventType)) return "shot";
  if (moment.eventType === "big_chance") return "close";
  if (moment.eventType === "assist") return "pass";
  if (["skill", "dribble"].includes(moment.eventType)) return "amazing";
  if (moment.eventType === "celebration") return "celebration";
  return "none";
}

function soundForEvent(moment) {
  if (moment.eventType === "goal") return "goal";
  if (["foul", "yellow_card", "red_card"].includes(moment.eventType)) return "whistle";
  if (["shot_on_target", "shot_off_target", "save", "tackle"].includes(moment.eventType)) return "impact";
  if (["skill", "dribble", "celebration"].includes(moment.eventType)) return "sparkle";
  if (["assist", "free_kick"].includes(moment.eventType)) return "whoosh";
  return "none";
}

function gradeForScene(moment) {
  if (moment.isReplay || moment.storyPhase === "replay") return "replay_blue";
  if (moment.eventType === "goal") return "goal_gold";
  if (moment.eventType === "celebration" || moment.storyPhase === "reaction" || moment.role === "reaction") return "warm";
  if (["setup", "build_up", "analysis"].includes(String(moment.role)) || moment.storyPhase === "build_up") return "cool";
  if (["action", "evidence", "proof", "turn"].includes(String(moment.role))) return "dramatic";
  if (["consequence", "payoff", "conclusion"].includes(String(moment.role)) || moment.storyPhase === "payoff") return "warm";
  return moment.storyPhase === "hook" ? "dramatic" : "clean";
}

function applyEditPlan(candidates, plan, targetDuration, settings = {}) {
  const fixedSelection = isCompleteHighlights(settings)
    && candidates.some(moment=>moment.selectionLocked && moment.fixedSceneQueueVersion===1);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const used = new Set();
  const planned = [...(Array.isArray(plan?.segments) ? plan.segments : [])]
    .sort((a, b) => Number(a.editOrder) - Number(b.editOrder));

  const edits = [];
  let outputDuration = 0;
  for (const directive of planned) {
    const candidate = byId.get(String(directive.candidateId));
    const renderable = candidate && (framingEligible(candidate)
      || (settings.aspectRatio === "16:9" && canRenderLockedNativeAction(candidate)));
    if (!renderable || used.has(candidate.id)) continue;

    const reaction = candidate.eventType === "celebration" || candidate.storyPhase === "reaction";
    const candidateSourceLength = reaction && !fixedSelection ? Math.min(3, candidate.endTime - candidate.startTime) : candidate.endTime - candidate.startTime;
    const playbackRate = reaction || fixedSelection ? 1 : clamp(
      Math.max(Number(directive.playbackRate || 1), candidateSourceLength / MAX_SCENE_SECONDS),
      0.72,
      1.18,
    );
    const minimumOutputLength = minimumSceneSeconds(candidate);
    if (!fixedSelection && candidateSourceLength / playbackRate < minimumOutputLength) continue;
    const startTime = candidate.startTime;
    const endTime = reaction && !fixedSelection ? Math.min(candidate.endTime, startTime + 3) : candidate.endTime;
    const goalAction = candidate.eventType === "goal" && candidate.storyPhase !== "replay" && !candidate.isReplay;
    const replay = candidate.isReplay || candidate.storyPhase === "replay";
    const shot = ["shot_on_target", "shot_off_target", "big_chance"].includes(candidate.eventType);
    const save = candidate.eventType === "save";
    const requestedEffect = ["none", "punch_zoom", "slow_motion", "speed_up", "replay_treatment", "freeze_analysis"].includes(directive.effect) ? directive.effect : "none";
    const effect = reaction
        ? "none"
        : replay && requestedEffect === "none"
          ? "replay_treatment"
          : requestedEffect;
    const freezeDuration = effect === "freeze_analysis" ? clamp(Number(directive.freezeDuration || 0.65), 0.4, 1) : 0;
    const effectiveLength = candidateSourceLength / playbackRate + freezeDuration;
    const maximumAllowed = targetDuration + 3 - outputDuration;
    if (!fixedSelection && effectiveLength > maximumAllowed) continue;
    if (!fixedSelection && effectiveLength + 0.001 < minimumOutputLength) continue;
    const transitionIn = ["cut", "crossfade", "crosszoom", "whip", "flash"].includes(directive.transitionIn) ? directive.transitionIn : "cut";
    const requestedCallout = normalizeChoice(directive.eventCallout, ["none", "amazing", "goal", "shot", "save", "foul", "card", "close", "pass", "celebration"], "none");
    const eventCallout = reaction ? "none" : requestedCallout;
    const colorGrade = gradeForScene({ ...candidate, role: directive.role });
    const requestedSound = normalizeChoice(directive.soundEffect, ["none", "whoosh", "impact", "goal", "whistle", "sparkle"], "none");
    const soundEffect = !reaction && requestedSound !== "none"
      ? goalAction ? "goal" : shot || save ? "impact" : requestedSound
      : "none";
    edits.push({
      ...candidate,
      startTime,
      endTime,
      selectedForFinalVideo: true,
      editOrder: edits.length,
      role: String(directive.role || candidate.storyPhase || "evidence"),
      beatId: reaction ? undefined : String(directive.beatId || "") || undefined,
      transitionIn,
      transitionDuration: clamp(Number(directive.transitionDuration || 0.04), 0.04, 0.36),
      effect,
      tacticalDrawing: !reaction && ["ball", "run", "pass", "map"].includes(directive.tacticalDrawing) ? directive.tacticalDrawing : "none",
      freezeAtPhase: effect === "freeze_analysis"
        ? directive.tacticalDrawing === "pass" ? "origin" : goalAction ? "contact" : normalizeChoice(directive.freezeAtPhase, ["contact", "payoff"], "contact")
        : "none",
      freezeDuration,
      playbackRate,
      playerHighlight: !reaction && Boolean(directive.playerHighlight)
        && candidate.mainPlayerVisible
        && (candidate.ballVisible || playerOnlyAllowed(candidate)),
      commentary: reaction ? undefined : String(directive.commentary || "").slice(0, 360) || undefined,
      analysisPurpose: String(directive.analysisPurpose || candidate.analysisPurpose || "").slice(0, 220) || undefined,
      transformationReason: String(
        directive.transformationReason
        || "Original analysis, full-screen reframing, and evidence-linked treatment explain this football point.",
      ).slice(0, 260),
      onScreenText: cleanOverlayText(directive.onScreenText || candidate.onScreenText || eventHeadline(candidate), 4),
      eventCallout,
      colorGrade,
      soundEffect,
    });
    used.add(candidate.id);
    outputDuration += effectiveLength;
    if (!fixedSelection && outputDuration >= targetDuration - 0.5) break;
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
  // selectionLocked is the Step-1 editorial contract. A later tracking or
  // render retry may repair presentation fields, but it must not inherit a
  // transient deselection and silently drop an already approved football scene.
  restored = restored.map((moment) => moment.selectionLocked === true
    ? { ...moment, selectedForFinalVideo: true }
    : moment);
  const chronologicalOrder = new Map(restored
    .filter((moment) => moment.selectedForFinalVideo)
    .sort((left, right) => Number(left.startTime) - Number(right.startTime))
    .map((moment, index) => [String(moment.id), index]));
  return restored.map((moment) => chronologicalOrder.has(String(moment.id))
    ? { ...moment, editOrder: chronologicalOrder.get(String(moment.id)) }
    : moment);
}
function normalizeBeatText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function buildTrackingPool(moments, backupLimit = 14) {
  const planned = moments.filter((moment) => moment.selectedForFinalVideo);
  const plannedIds = new Set(planned.map((moment) => moment.id));
  const candidates = moments
    .filter((moment) => !plannedIds.has(moment.id) && moment.keepDecision !== "reject" && moment.confidence >= 0.4 && framingEligible(moment) && (moment.endTime - moment.startTime) / clamp(Number(moment.playbackRate || 1), 0.72, 1.18) >= minimumSceneSeconds(moment));
  const backups = rankSemanticBackups(planned, candidates)
    .slice(0, backupLimit)
    .map((item) => item.moment);
  const trackedIds = new Set([...plannedIds, ...backups.map((moment) => moment.id)]);
  return moments.map((moment) => ({ ...moment, selectedForFinalVideo: trackedIds.has(moment.id) }));
}

function trackingEvidenceFor(tracking, moment) {
  return matchingTrackingEvidence(tracking, moment);
}

function repairPlanWithTrackedBackups(plannedMoments, assessedMoments, tracking, targetDuration, intensity, settings = {}) {
  const approvedById = new Map(assessedMoments.filter((moment) => moment.selectedForFinalVideo).map((moment) => [moment.id, moment]));
  const rejectedPlanned = plannedMoments
    .filter((moment) => moment.selectedForFinalVideo && !approvedById.has(moment.id))
    .sort((a, b) => Number(a.editOrder) - Number(b.editOrder));
  const backups = plannedMoments
    .filter((moment) => !moment.selectedForFinalVideo && trackingEvidenceFor(tracking, moment))
    .map((moment) => ({ moment, assessment: settings.aspectRatio === "16:9"
      ? assessNativeFrameAction(moment, trackingEvidenceFor(tracking, moment))
      : assessPlannedSceneTracking(moment, trackingEvidenceFor(tracking, moment)) }))
    .filter((item) => item.assessment.usable
      || (settings.aspectRatio === "16:9" && canRenderLockedNativeAction(item.moment)))
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
    const desiredSourceLength = Math.min(MAX_SCENE_SECONDS * playbackRate, Math.max(minimumSceneSeconds(backup) * playbackRate, rejected.endTime - rejected.startTime));
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

function availableVerifiedEvidenceDuration(candidates) {
  let gameplayDuration = 0;
  let reactionDuration = 0;
  for (const moment of candidates.filter((item) => framingEligible(item)
    && item.keepDecision !== "reject"
    && !["analysis_rejected", "not_tracked", "selection_locked_portrait_repair"].includes(item.trackingDecision))) {
    const duration = Math.min(MAX_SCENE_SECONDS, (moment.endTime - moment.startTime) / clamp(Number(moment.playbackRate || 1), 0.72, 1.18));
    if (playerOnlyAllowed(moment)) reactionDuration += duration;
    else gameplayDuration += duration;
  }
  return gameplayDuration + Math.min(18, reactionDuration);
}
function applyTrackingQuality(moments, tracking, settings = {}) {
  const approved = new Map();
  for (const moment of moments.filter((item) => item.selectedForFinalVideo)) {
    const exactEvidence = trackingEvidenceFor(tracking, moment);
    const rawLockedEvidence = moment.selectionLocked === true ? tracking?.moments?.[String(moment.id)] : undefined;
    const rawContainsScene = rawLockedEvidence
      && Math.abs(Number(rawLockedEvidence.sourceStartTime) - Number(moment.startTime)) <= 0.041
      && Number(rawLockedEvidence.sourceEndTime) + 0.041 >= Number(moment.endTime);
    // Alignment may trim only the end of a Step-1 locked scene. Reuse its
    // already verified full-bleed path when the cached source interval contains
    // the trimmed scene; exact-end matching must not turn that into no evidence.
    const evidence = exactEvidence || (rawContainsScene ? rawLockedEvidence : undefined);
    const assessment = settings.aspectRatio === "16:9"
      ? assessNativeFrameAction(moment, evidence)
      : assessPlannedSceneTracking(moment, evidence);
    if (assessment.usable) approved.set(moment.id, { ...moment, trackingDecision: assessment.mode, trackingPassed: true });
    else if (settings.aspectRatio === "16:9" && canRenderLockedNativeAction(moment)) {
      // The original full frame already contains the verified action. Keep the
      // immutable Step-1 scene, but never draw a guessed ring or tactical line.
      approved.set(moment.id, {
        ...moment,
        playerHighlight: false,
        tacticalDrawing: "none",
        trackingDecision: "native_locked_action_annotation_suppressed",
        trackingPassed: true,
      });
    }
    else if (safeStaticFallbackEligible(moment) && playerOnlyAllowed(moment)) {
      approved.set(moment.id, downgradeToSafeStatic(moment, assessment.mode, true));
    }
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
    .filter((item) => item.selectedForFinalVideo && (item.endTime - item.startTime) / clamp(Number(item.playbackRate || 1), 0.72, 1.18) >= minimumSceneSeconds(item))
    .sort((a, b) => Number(a.editOrder ?? Number.MAX_SAFE_INTEGER) - Number(b.editOrder ?? Number.MAX_SAFE_INTEGER) || a.startTime - b.startTime)
    .filter((moment) => {
      const length = (moment.endTime - moment.startTime) / clamp(Number(moment.playbackRate || 1), 0.72, 1.18);
      if (total + length > targetDuration + 3) return false;
      total += length;
      return true;
    });
}

async function trackFootball(sourcePath, moments, media, id, options = {}) {
  if (geminiKeyframing) {
    if (!geminiEnabled) throw new Error("Gemini vision is required for keyframe tracking.");
    // The same cloud source gets a new mtime after download/restore. Key
    // verified scene caches by actual bytes, not ephemeral filesystem time.
    const sourceFingerprint = await sourceContentFingerprint(sourcePath);
    const job = await readJob(id);
    const dimensions = outputDimensions(job.settings);
    const ai = createGeminiClient();
    const evidence = {};
    for (const scene of moments.filter(moment => moment.selectedForFinalVideo !== false)) {
      const split=splitSceneInput(scene,join(outputRoot,id,'source-scenes'));
      const inputScene=split?sceneWithLocalClock(scene):scene;
      const observed = await trackSceneWithGemini({ sourcePath:split?.path||sourcePath,
        sourceFingerprint:split?await sourceContentFingerprint(split.path):sourceFingerprint,scene:inputScene, media,
        repairRound:Number(options.repairRound||0),
        ratio: dimensions.width / dimensions.height, directory: join(outputRoot, id, "tracking", "gemini"),
        ffmpeg: ffmpegPath, run, model: process.env.GEMINI_KEYFRAME_MODEL || process.env.GEMINI_MODEL,
        generate: async (request, label) => (await generateGeminiJson(ai, request, label)).parsed,
        report: async progressDetail => {
          const current = await readJob(id);
          const progress=current.trackingProgress;
          await updateJob(current, "tracking", Math.max(34, current.progress), { progressDetail:
            progress?.pass==='gemini'?`${progress.approved}/${progress.total} crops verified. ${progressDetail}`:progressDetail });
        } });
      evidence[scene.id]=split?{...observed,sourceStartTime:scene.startTime,sourceEndTime:scene.endTime,
        splitSceneAssetVersion:1,splitSceneFileName:scene.sourceSceneAsset.fileName}:observed;
      if(split) evidence[scene.id].portraitSceneAsset=await savePortraitSceneAsset({scene,
        sourceDirectory:join(outputRoot,id,'source-scenes'),directory:join(outputRoot,id,'portrait-scenes'),
        evidence:evidence[scene.id],dimensions,ffmpeg:ffmpegPath,run,probe});
    }
    return { version: 92, provider: "gemini-vision", moments: evidence, markerPaths: {}, summary: summarizeTracking(evidence) };
  }
  for (const [label, path] of [["Python tracking runtime", trackingPythonPath], ["football tracking script", trackingScriptPath], ["YOLO player model", trackingModelPath], ["football-specific ball model", trackingBallModelPath]]) {
    try { await stat(path); }
    catch { throw new Error(`${label} is missing at ${path}. Run npm run setup:tracking once, then retry.`); }
  }
  const selected = fitSelectedMoments(moments, Number.MAX_SAFE_INTEGER);
  const { width: trackingOutputWidth, height: trackingOutputHeight } = outputDimensions((await readJob(id)).settings);
  if (selected.length === 0) throw new Error("No valid moments are available for player and ball tracking.");
  const directory = join(outputRoot, id, "tracking");
  await mkdir(directory, { recursive: true });
  const requestId = randomUUID();
  const inputPath = join(directory, `moments-${requestId}.json`);
  const outputPath = join(directory, `tracking-partial-${requestId}.json`);
  let progressWrites = Promise.resolve();
  let progressError;
  const reportProgress = (line) => {
    const detail = parseTrackingProgress(line);
    if (!detail) return;
    progressWrites = progressWrites.then(async () => {
      const current = await readJob(id);
      const frameDetail = detail.sceneSeconds !== undefined ? `, ${detail.sceneSeconds}/${detail.sceneDuration}s` : "";
      const activity = detail.pass === "detect" ? "Finding ball and players" : detail.pass === "camera" ? "Planning smooth camera movement" : "Detector observations saved";
      await updateJob(current, "tracking", Math.max(34, current.progress), {
        trackingProgress: {...detail,checkpointPath:undefined},
        progressDetail: `${activity}: ${detail.completed}/${detail.total} scenes${frameDetail}. ${detail.cacheHits || 0} saved frames reused; ${detail.newFrames || 0} new frames checked.`,
      });
      if(detail.checkpointPath&&detail.sceneId&&options.onSceneReady) {
        const cacheRoot=process.env.TRACKING_CACHE_DIR?join(resolveSetting(process.env.TRACKING_CACHE_DIR),id)
          :join(dataRoot,'tracking-cache',id);
        if(dirname(resolve(detail.checkpointPath))!==resolve(cacheRoot,'scenes')
          ||!detail.checkpointPath.endsWith('.json')) throw new Error('Unexpected native scene checkpoint path.');
        const evidence=JSON.parse(await readFile(detail.checkpointPath,'utf8'));
        options.onSceneReady(detail.sceneId,evidence);
      }
    }).catch(error=>{progressError ||= error;});
  };
  await writeFile(inputPath, JSON.stringify({
    moments: selected.map((selectedMoment) => {
      const moment = hybridKeyframing ? hybridDetectorScene(selectedMoment) : selectedMoment;
      return ({
      id: moment.id,
      startTime: moment.startTime,
      endTime: moment.endTime,
      eventType: moment.eventType,
      focusX: clamp(moment.recommendedCrop?.[0]?.x ?? 0.5, 0, 1),
      storyPhase: moment.storyPhase,
      role: moment.role,
      isReplay: Boolean(moment.isReplay),
      playerHighlight: moment.playerHighlight !== false,
      trackingBrief: moment.trackingBrief,
      effect: moment.effect,
      freezeAtPhase: moment.freezeAtPhase,
      eventCallout: moment.eventCallout,
      colorGrade: moment.colorGrade,
    }); }),
    media,
  }));
  try {
    await run(trackingPythonPath, [
      trackingScriptPath,
      "--source", sourcePath,
      "--moments", inputPath,
      "--output", outputPath,
      "--model", trackingModelPath,
      "--ball-model", trackingBallModelPath,
      "--sample-fps", String(options.sampleFps || trackingSampleFps),
      "--coarse-sample-fps", String(Math.min(options.sampleFps || trackingSampleFps, options.coarseSampleFps || trackingCoarseSampleFps)),
      "--device", trackingDevice,
      "--cpu-workers", String(hybridKeyframing && fastTracking.enabled ? 1 : trackingSceneConcurrency),
      "--image-size", String(options.imageSize || trackingImageSize),
      "--ball-image-size", String(options.ballImageSize || trackingBallImageSize),
      "--confidence", String(trackingConfidence),
      "--ball-confidence", String(trackingBallConfidence),
      "--output-width", String(trackingOutputWidth),
      "--output-height", String(trackingOutputHeight),
      "--window-height", String(trackingOutputHeight),
      "--window-top", "0",
      "--zoom", "1",
      "--tracker", fastTracking.enabled ? "botsort" : "tracktrack",
      "--camera-motion", "sparseOptFlow",
      "--cache-dir", process.env.TRACKING_CACHE_DIR ? join(resolveSetting(process.env.TRACKING_CACHE_DIR), id) : join(dataRoot, "tracking-cache", id),
      "--shots", join(outputRoot, id, "shots.json"),
    ], reportProgress);
    await progressWrites;
    if(progressError)throw progressError;
  } catch (error) {
    await progressWrites;
    await rm(inputPath, { force: true }).catch(() => undefined);
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw new Error(`Local player/ball tracking failed: ${String(error?.message || error).slice(-1200)}`);
  }
  const tracking = JSON.parse(await readFile(outputPath, "utf8"));
  await rm(inputPath, { force: true }).catch(() => undefined);
  await rm(outputPath, { force: true }).catch(() => undefined);
  if (!tracking?.moments || !tracking?.summary || !tracking?.markerPaths) throw new Error("The local tracker returned incomplete keyframe data.");
  if (hybridKeyframing && !options.nativeOnly) {
    if (!geminiEnabled) throw new Error("Hybrid tracking requires Gemini for independent rendered-crop review.");
    const sourceFingerprint = await sourceContentFingerprint(sourcePath);
    const ai = createGeminiClient();
    for (const scene of selected) {
      const current = await readJob(id);
      await updateJob(current, "tracking", Math.max(34, current.progress), {
        progressDetail: `Checking actual ball/player crop: ${scene.id}. Scene selection remains locked.`,
      });
      tracking.moments[scene.id] = await reviewHybridCrop({ sourcePath, sourceFingerprint,
        scene, evidence: tracking.moments[scene.id], media,
        ratio: trackingOutputWidth / trackingOutputHeight,
        directory: join(directory, "hybrid-review"), ffmpeg: ffmpegPath, run,probeVideo:probe,
        model: fastTracking.enabled ? fastTracking.reviewModel : process.env.GEMINI_KEYFRAME_MODEL || process.env.GEMINI_MODEL,
        videoOnly:fastTracking.enabled,
        generate: async (request, label) => (await generateGeminiJson(ai, request, label)).parsed });
    }
    tracking.version = 93;
    tracking.provider = "hybrid-football";
    tracking.summary = summarizeTracking(tracking.moments);
  }
  return tracking;
}

async function reselectBlockedSourceActions(sourcePath,candidates,media,id) {
  const directory=join(outputRoot,id,'source-reselection');
  await mkdir(directory,{recursive:true});
  const trackingPath=join(outputRoot,id,'tracking','tracking.json');
  const tracking=JSON.parse(await readFile(trackingPath,'utf8'));
  const pending=blockedSelectionScenes(candidates,tracking);
  if(!pending.length) return candidates;
  const shots=JSON.parse(await readFile(join(outputRoot,id,'shots.json'),'utf8')).shots;
  const fingerprint=await sourceContentFingerprint(sourcePath);
  const replacements=await mapWithConcurrency(pending,fastTracking.reviewConcurrency,async(scene,index)=>{
    const window=blockedSelectionWindow(scene,shots,media.duration);
    const model=fastTracking.reviewModel;
    const key=stableSignature({version:BLOCKED_SELECTION_VERSION,fingerprint,model,scene:scene.id,
      originalStart:scene.startTime,originalEnd:scene.endTime,window});
    const responsePath=join(directory,`${key}.response.json`);
    let parsed;
    try {parsed=JSON.parse(await readFile(responsePath,'utf8'));} catch { /* New authorized selection. */ }
    if(!parsed) {
      // A previous paid source observation with sufficient complete phases
      // remains usable after a prompt-only upgrade. Invalid earlier answers
      // are retained, but cannot satisfy the new selection contract.
      const oldKey=stableSignature({version:1,fingerprint,model,scene:scene.id,
        originalStart:scene.startTime,originalEnd:scene.endTime,window});
      try {
        const previous=JSON.parse(await readFile(join(directory,`${oldKey}.response.json`),'utf8'));
        applyBlockedSelection(scene,window,previous,{
          model:previous.generationProvenance?.actualModel||model,sourceFingerprint:fingerprint});
        parsed=previous;
        await writeFile(responsePath,JSON.stringify(parsed,null,2));
      } catch { /* Insufficient old evidence needs the changed source selector. */ }
    }
    if(!parsed) {
      await updateJob(await readJob(id),'detecting_moments',33,{
        progressDetail:`Choosing clearer source action ${index+1}/${pending.length}; approved crops stay saved.`});
      const input=join(directory,`${key}.mp4`);
      await run(ffmpegPath,['-hide_banner','-loglevel','error','-y','-ss',String(window.startTime),
        '-i',sourcePath,'-t',String(window.endTime-window.startTime),'-an',
        '-vf',`fps=${SOURCE_RESELECTION_FPS},setpts=PTS-STARTPTS,${framingVideoClockFilter()}`,
        '-c:v','libx264','-preset','veryfast','-crf','18',input]);
      const generated=await generateGeminiJson(createGeminiClient(),
        blockedSelectionRequest(model,(await readFile(input)).toString('base64'),scene,window),
        `Source angle reselection ${scene.id}`);
      parsed=generated.parsed;
      // Save paid observations before validating. A retry must not regenerate
      // the same answer, and a false crop approval is never synthesized here.
      await writeFile(responsePath,JSON.stringify(parsed,null,2));
    }
    try {return applyBlockedSelection(scene,window,parsed,{
      model:parsed.generationProvenance?.actualModel||model,sourceFingerprint:fingerprint});}
    catch(error) {
      error.code='SOURCE_SELECTION_CONFLICT';
      error.message=`Source reselection for ${scene.id}: ${error.message} Saved observations will not be repeated automatically.`;
      throw error;
    }
  });
  const selected=mergeBlockedSelections(candidates,replacements);
  const audit={version:BLOCKED_SELECTION_VERSION,savedAt:new Date().toISOString(),
    authorization:'explicit_blocked_source_reselection',sourceFingerprint:fingerprint,
    approvedSceneIds:candidates.filter(scene=>scene.selectionLocked&&!pending.some(p=>p.id===scene.id)).map(scene=>scene.id),
    previousCandidates:candidates,replacements,combined:false};
  await writeFile(join(directory,`selection-${Date.now()}.json`),JSON.stringify(audit,null,2));
  // Commit the replacement source list only after every selected incident has
  // complete evidence. Old source/crop files remain available in the audit.
  await writeFile(join(outputRoot,id,'step1-scene-manifest.json'),JSON.stringify({version:1,
    candidates:selected,savedAt:audit.savedAt,sourceReselectionVersion:BLOCKED_SELECTION_VERSION},null,2));
  for(const scene of replacements) delete tracking.moments[scene.id];
  await writeFile(trackingPath,JSON.stringify(tracking));
  await writeFile(join(outputRoot,id,'step1-recap-plan.json'),JSON.stringify({version:2,
    stage:'source_split',combined:false,order:'chronological_source_incidents',playbackRate:1,
    verifiedSourceSeconds:renderableEvidenceCapacity(selected.filter(scene=>scene.selectionLocked),.08,{maximumReactionSeconds:7}),
    scenes:selected.filter(scene=>scene.selectionLocked).map(scene=>({id:scene.id,storyId:scene.storyId,
      eventType:scene.eventType,startTime:scene.startTime,endTime:scene.endTime})),
    sourceReselectionVersion:BLOCKED_SELECTION_VERSION},null,2));
  return selected;
}

async function prepareGuidedSourceSelection(sourcePath,candidates,media,id) {
  const fingerprint=await sourceContentFingerprint(sourcePath);
  const initialScoring=candidates.filter(scene=>['goal','disallowed_goal'].includes(scene.eventType))
    .map(scene=>({...scene,contactTime:scene.trackingBrief?.contactTime}));
  const pool=candidates.filter(scene=>scene.semanticVerified===true&&scene.keepDecision!=='reject'
    && scene.eventType!=='celebration'&&scene.storyPhase!=='reaction'
    && !['foul','yellow_card','red_card','offside','var','penalty'].includes(scene.eventType));
  const decisions=await mapWithConcurrency(pool,fastTracking.reviewConcurrency,async(scene,index)=>{
    const scoring=['goal','disallowed_goal'].includes(scene.eventType);
    const model=scoring?fastTracking.reviewModel:process.env.GEMINI_DISCOVERY_MODEL||fastTracking.reviewModel;
    const observed=await prepareHybridActionGuide(sourcePath,sourceActionGuideWindow(scene,media.duration),id,
      {sourceSelection:true,index:index+1,total:pool.length,model});
    const selected=selectGuidedSourceAction(scene,observed,{model,sourceFingerprint:fingerprint,
      authoritativeOutcome:scoring});
    return {id:scene.id,...selected};
  });
  await writeFile(join(outputRoot,id,'source-action-selection.json'),JSON.stringify({version:1,
    phase:'before_scene_lock',broadDiscoveryRepeated:false,decisions},null,2));
  const byId=new Map(decisions.map(value=>[value.id,value]));
  const selected=candidates.map(scene=>{
    const decision=byId.get(scene.id);
    if(!decision) return scene;
    return decision.scene || {...scene,semanticVerified:false,actionComplete:false,
      sceneSelectionApproved:false,selectionLocked:false,keepDecision:'reject',
      rejectReason:decision.reason};
  });
  const coverage=initialScoringCoverage(initialScoring,
    selectInitialActionViews(selected).filter(scene=>scene.sourceAngleSelected),{resolvedCandidates:selected});
  if(!coverage.complete) throw Object.assign(new Error('Complete source action selection still has an unresolved observed goal. No scene has been locked or silently omitted.'),{code:'SOURCE_SELECTION_CONFLICT'});
  return selected;
}

async function prepareHybridActionGuide(sourcePath,scene,id,options={}) {
  const directory=join(outputRoot,id,'tracking','action-guidance');
  await mkdir(directory,{recursive:true});
  const model=options.model||scene.actionGuidance?.model||process.env.GEMINI_DISCOVERY_MODEL||fastTracking.reviewModel;
  // A new source-selection guide belongs to the immutable uploaded bytes,
  // not the re-encoded split clip. Reuse it for Step 2 without another call.
  if(scene.actionGuidance && matchingActionGuidance(scene,scene.actionGuidance,
    await sourceContentFingerprint(sourcePath),model)) return applySavedActionGuidance(scene);
  const split=splitSceneInput(scene,join(outputRoot,id,'source-scenes'));
  const fingerprint=await sourceContentFingerprint(split?.path||sourcePath);
  const key=actionGuidanceKey(scene,fingerprint,model),path=join(directory,`${key}.json`);
  let saved;
  try {saved=JSON.parse(await readFile(path,'utf8'));} catch { /* New scene guide. */ }
  if(!matchingActionGuidance(scene,saved,fingerprint,model)) {
    const current=await readJob(id);
    await updateJob(current,options.sourceSelection?'detecting_moments':'tracking',
      options.sourceSelection?30:Math.max(34,current.progress),{
      progressDetail:options.sourceSelection
        ? `Choosing complete source action ${options.index}/${options.total}; verifying the touch and finish before locking.`
        : `Understanding the ball route in ${scene.id}; selected action boundaries remain unchanged.`,
      ...(options.sourceSelection?{}:{activeTrackingScene:{id:scene.id,status:'observing_action'}}),
    });
    const observationKey=actionGuideObservationKey(scene,fingerprint,model);
    const observationPath=join(directory,`observation-${observationKey}.json`);
    const guide=await sharedActionGuideObservation(observationPath,{
      pending:pendingActionGuideObservations,
      load:async()=>{
        try {return matchingActionGuideObservation(scene,JSON.parse(await readFile(observationPath,'utf8')),fingerprint,model);}
        catch {return null;}
      },
      observe:async()=>{
        let input=split?.path;
        if(!input) {
          input=join(directory,`${key}.source.mp4`);
          await run(ffmpegPath,['-hide_banner','-loglevel','error','-y','-ss',String(scene.startTime),
            '-i',sourcePath,'-t',String(scene.endTime-scene.startTime),'-an','-vf','fps=8,setpts=PTS-STARTPTS',
            '-c:v','libx264','-preset','veryfast','-crf','18',input]);
        }
        const label=`Semantic ball route ${scene.id}`;
        return observeValidatedActionGuidance({
          request:actionGuidanceRequest(model,(await readFile(input)).toString('base64'),scene.endTime-scene.startTime),
          duration:scene.endTime-scene.startTime,label,
          generate:async(request,attempt)=>(await generateGeminiJson(createGeminiClient(),request,
            `${label}${attempt>1?` coordinate correction ${attempt-1}`:''}`,2)).parsed,
          loadResponse:async attempt=>{
            try {const archived=JSON.parse(await readFile(`${observationPath}.response-${attempt}.json`,'utf8'));
              return archived.key===observationKey?archived.raw:null;} catch {return null;}
          },
          saveResponse:async(attempt,raw)=>writeFile(`${observationPath}.response-${attempt}.json`,
            JSON.stringify({key:observationKey,attempt,sceneId:scene.id,model,
              sourceStartTime:scene.startTime,sourceEndTime:scene.endTime,raw,savedAt:new Date().toISOString()})),
          report:async progressDetail=>{
            const current=await readJob(id);
            await updateJob(current,options.sourceSelection?'detecting_moments':'tracking',current.progress,{progressDetail});
          },
        });
      },
      save:async guide=>writeFile(observationPath,JSON.stringify({version:ACTION_GUIDANCE_VERSION,
        key:observationKey,model,sourceFingerprint:fingerprint,sourceStartTime:scene.startTime,
        sourceEndTime:scene.endTime,guide})),
    });
    saved={version:ACTION_GUIDANCE_VERSION,key,model,sourceFingerprint:fingerprint,
      sourceStartTime:scene.startTime,sourceEndTime:scene.endTime,guide};
    await writeFile(path,JSON.stringify(saved));
  }
  return applySavedActionGuidance({...scene,actionGuidance:saved});
}

async function verifyHybridScene(sourcePath,scene,media,id,evidence) {
  if (!evidence) throw new Error(`No detector evidence saved for selected scene ${scene.id}`);
  const current=await readJob(id), dimensions=outputDimensions(current.settings);
  await updateJob(current,'tracking',Math.max(34,current.progress),{
    progressDetail:`Reviewing the actual portrait video for ${scene.id}; detector positions are saved.`,
    activeTrackingScene:{id:scene.id,status:'reviewing'},
  });
  const ai=createGeminiClient();
  const observed=await reviewHybridCrop({sourcePath,sourceFingerprint:await sourceContentFingerprint(sourcePath),
    scene,evidence,media,ratio:dimensions.width/dimensions.height,
    directory:join(outputRoot,id,'tracking','hybrid-review'),ffmpeg:ffmpegPath,run,probeVideo:probe,
    model:fastTracking.reviewModel,videoOnly:true,
    generate:async(request,label)=>(await generateGeminiJson(ai,request,label)).parsed});
  if(observed.finalCropVerified && scene.sourceSceneAsset) {
    observed.portraitSceneAsset=await savePortraitSceneAsset({scene,
      sourceDirectory:join(outputRoot,id,'source-scenes'),directory:join(outputRoot,id,'portrait-scenes'),
      evidence:observed,dimensions,ffmpeg:ffmpegPath,run,probe});
    observed.splitSceneFileName=scene.sourceSceneAsset.fileName;
  }
  return observed;
}

async function loadOrTrackFootball(sourcePath, moments, media, id) {
  // Python validates source/model/config fingerprints and reuses individual
  // scene checkpoints and raw observations, not an all-or-nothing pool cache.
  const savedTrackingPath = join(outputRoot, id, "tracking", "tracking.json");
  await ensureShotBoundaries(sourcePath, id);
  let saved = { version: 91, moments: {}, summary: {}, markerPaths: {} };
  try {
    const parsed = JSON.parse(await readFile(savedTrackingPath, "utf8"));
    if (Number(parsed?.version || 0) >= 91 && parsed?.moments) saved = parsed;
  } catch { /* A genuinely new job has no scene-level tracking repairs yet. */ }
  // Render-only retries own the same immutable job source/settings. Do not
  // retrack every scene before comparing its saved, independently approved
  // crop: reviewed phase metadata may have improved since the old cache key
  // was formed. Exact source intervals, provider and current quality contract
  // still have to pass. Only missing/unapproved scenes enter the tracker.
  const nativeLandscape=(await readJob(id)).settings?.aspectRatio === "16:9";
  const approved={};
  const pending=moments.map(moment=>{
    if(moment.selectedForFinalVideo!==true) return {...moment,selectedForFinalVideo:false};
    const evidence=trackingEvidenceFor(saved,moment);
    const assessment=nativeLandscape ? assessNativeFrameAction(moment,evidence) : assessPlannedSceneTracking(moment,evidence);
    if(providerEvidenceMatches(activeKeyframeProvider,evidence) && assessment?.usable===true) {
      approved[String(moment.id)]=evidence;
      return {...moment,selectedForFinalVideo:false};
    }
    return moment;
  });
  const fresh=pending.some(moment=>moment.selectedForFinalVideo===true)
    ? await trackFootball(sourcePath,pending,media,id)
    : {version:saved.version,moments:{},markerPaths:{}};
  const mergedMoments = { ...approved, ...(fresh.moments || {}) };
  for (const moment of moments.filter((item) => item.selectedForFinalVideo)) {
    if(approved[String(moment.id)]) continue;
    const savedEvidence = trackingEvidenceFor(saved, moment);
    const freshEvidence = trackingEvidenceFor(fresh, moment);
    if (providerEvidenceMatches(activeKeyframeProvider, savedEvidence)
      && trackingEvidenceQuality(moment, savedEvidence) > trackingEvidenceQuality(moment, freshEvidence)) {
      mergedMoments[String(moment.id)] = savedEvidence;
    }
  }
  const merged = {
    version: Math.max(60, Number(saved.version || 0), Number(fresh.version || 0)),
    moments: mergedMoments,
    markerPaths: { ...(saved.markerPaths || {}), ...(fresh.markerPaths || {}) },
    summary: summarizeTracking(mergedMoments),
  };
  await writeFile(savedTrackingPath, JSON.stringify(merged));
  return merged;
}
async function makeStadiumAudio(sourcePath, moments, id) {
  const selected = moments.filter(moment => moment.selectedForFinalVideo !== false)
    .sort((a, b) => Number(a.editOrder) - Number(b.editOrder));
  if (!selected.length) return null;
  const stadiumDir = join(outputRoot, id, "stadium");
  const timelinePath = join(stadiumDir, "broadcast-timeline.wav");
  const separatedPath = join(stadiumDir, "separated", "htdemucs", "broadcast-timeline", "minus_vocals.wav");
  const manifestPath = join(stadiumDir, "manifest.json");
  const signature = stableSignature({ version: 1, sourcePath, selected: selected.map(moment => ({
    id: moment.id, startTime: moment.startTime, endTime: moment.endTime, editOrder: moment.editOrder,
    playbackRate: moment.playbackRate, effect: moment.effect, freezeDuration: moment.freezeDuration,
  })) });
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.signature === signature && (await stat(separatedPath)).size > 0) return separatedPath;
  } catch { /* Create or refresh the vocal-free stadium stem below. */ }
  await mkdir(stadiumDir, { recursive: true });
  const filters = selected.map((moment, index) => {
    const sourceLength = Math.max(0.1, Number(moment.endTime) - Number(moment.startTime));
    const playbackRate = clamp(Number(moment.playbackRate || 1), 0.72, 1.18);
    const freezeDuration = moment.effect === "freeze_analysis" ? clamp(Number(moment.freezeDuration || 0.72), 0.4, 1) : 0;
    const outputLength = sourceLength / playbackRate + freezeDuration;
    return `[0:a]atrim=start=${Number(moment.startTime).toFixed(3)}:duration=${sourceLength.toFixed(3)},asetpts=PTS-STARTPTS,aresample=44100,atempo=${playbackRate.toFixed(5)},apad,atrim=duration=${outputLength.toFixed(3)}[stadium${index}]`;
  });
  if (selected.length === 1) filters.push("[stadium0]anull[stadiumTimeline]");
  else filters.push(`${selected.map((_, index) => `[stadium${index}]`).join("")}concat=n=${selected.length}:v=0:a=1[stadiumTimeline]`);
  await run(ffmpegPath, ["-hide_banner", "-y", "-i", sourcePath, "-filter_complex", filters.join(";"), "-map", "[stadiumTimeline]", "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", timelinePath]);
  await run(trackingPythonPath, ["-m", "demucs", "--two-stems", "vocals", "--other-method", "minus", "--shifts", "1", "--segment", "7", "-j", "1", "-n", "htdemucs", "-o", join(stadiumDir, "separated"), timelinePath]);
  try {
    if ((await stat(separatedPath)).size > 0) {
      await writeFile(manifestPath, JSON.stringify({ signature, model: "htdemucs", stem: "minus_vocals.wav" }, null, 2));
      return separatedPath;
    }
  } catch { /* Report a focused failure below. */ }
  throw new Error("Broadcast voice separation completed without producing a stadium stem.");
}
async function makeContinuousSpeech(text, id) {
  const provider = (process.env.TTS_PROVIDER || "").toLowerCase();
  if (provider !== "google_cloud") throw new Error("TTS_PROVIDER must be google_cloud. No TTS fallback was selected.");
  const narration = String(text || "").trim();
  if (!narration) return new Map();
  const speechDir = join(outputRoot, id, "speech");
  const manifestPath = join(speechDir, "master-manifest.json");
  const output = join(speechDir, "narration-master.wav");
  await mkdir(speechDir, { recursive: true });
  const voiceSignature = [process.env.TTS_MODEL, process.env.TTS_LANGUAGE, process.env.TTS_VOICE, "continuous-v3-energetic-recap"].join(":");
  let reusable = false;
  try {
    const previous = JSON.parse(await readFile(manifestPath, "utf8"));
    reusable = previous.narration === narration && previous.voiceSignature === voiceSignature
      && (await stat(output)).size > 0 && await probeAudioDuration(output) > 0;
  } catch { /* Generate or refresh the continuous master recording. */ }
  if (!reusable) {
    const maximumBytes = /^gemini-/i.test(process.env.TTS_MODEL || '') ? 3500 : 4500;
    const chunks = splitNarrationForTts(narration, maximumBytes);
    const takesDirectory = join(speechDir, 'takes');
    await mkdir(takesDirectory, { recursive: true });
    const takes = [];
    for (const [index, chunk] of chunks.entries()) {
      const key = stableSignature({ version: 1, narration: chunk, voiceSignature });
      const takePath = join(takesDirectory, `${key}.wav`);
      let valid = false;
      try { valid = await probeAudioDuration(takePath) > 0; } catch { /* Record only the missing or corrupt take. */ }
      if (!valid) await synthesizeGoogleCloudSpeech(chunk, takePath, { onRetry: async detail => {
        const current = await readJob(id);
        await updateJob(current, 'generating_commentary', Math.max(64, Number(current.progress || 0)), {
          voiceCapacityWait: { active: true, attempt: detail.attempt,
            retryAt: new Date(Date.now() + detail.delayMs).toISOString() },
          progressDetail: `Google voice synthesis is temporarily busy. Automatically retrying recording ${index + 1}/${chunks.length}; the approved video and script are saved.`,
        });
      } });
      const takeDuration = await probeAudioDuration(takePath);
      await writeFile(join(takesDirectory, `${key}.json`), JSON.stringify({ narration: chunk, voiceSignature, duration: takeDuration }));
      takes.push(takePath);
    }
    if (takes.length === 1) await copyFile(takes[0], output);
    else await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y',
      ...takes.flatMap(path => ['-i', path]), '-filter_complex',
      `${takes.map((_,index)=>`[${index}:a]`).join('')}concat=n=${takes.length}:v=0:a=1[voice]`,
      '-map', '[voice]', '-c:a', 'pcm_s16le', '-ar', '24000', '-ac', '1', output]);
    await updateJob(await readJob(id), 'generating_commentary', 64, { voiceCapacityWait: { active: false } });
  }
  const duration = await probeAudioDuration(output);
  await writeFile(manifestPath, JSON.stringify({ narration, filename: "narration-master.wav", duration, voiceSignature }, null, 2));
  const files = new Map([["__narration__", output]]);
  files.durations = new Map();
  files.narrationDuration = duration;
  files.narrationScript = narration;
  return files;
}

function atempoChain(tempo) {
  const factors = [];
  let remaining = Number(tempo);
  while (remaining > 2) {
    factors.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5) {
    factors.push(0.5);
    remaining /= 0.5;
  }
  factors.push(clamp(remaining, 0.5, 2));
  return factors.map((factor) => "atempo=" + factor.toFixed(6)).join(",");
}

async function fitContinuousNarrationToLockedTimeline(ttsFiles, visualDuration, id) {
  const narrationDuration = Number(ttsFiles?.narrationDuration || 0);
  const targetDuration = Number(visualDuration || 0);
  if (!(narrationDuration > 0) || !(targetDuration > 0)) return ttsFiles;
  const ratio = narrationDuration / targetDuration;
  // A take that runs even slightly beyond the locked pictures can lose its
  // final word in the output mux. Leave naturally short takes untouched, but
  // fit every overlong take just inside the visual endpoint.
  if (ratio >= 0.94 && narrationDuration <= targetDuration - 0.25) return ttsFiles;
  // Never stretch a short voice recording to fill the pictures. Slowing an
  // already expressive performance is exactly what made the recap sound
  // bored. The writing loop owns short narration; this function may only
  // accelerate an overlong recording enough to protect the locked visuals.
  if (ratio < 0.94) {
    ttsFiles.voiceTimingAdjusted = false;
    ttsFiles.voiceTimingShortfall = true;
    return ttsFiles;
  }
  const source = ttsFiles.get("__narration__");
  if (!source) return ttsFiles;
  const fittedDir = join(outputRoot, id, "speech", "locked-timeline");
  const output = join(fittedDir, "narration-master.wav");
  await mkdir(fittedDir, { recursive: true });
  const fitRatio = narrationDuration / Math.max(0.1, targetDuration - 0.25);
  await run(ffmpegPath, [
    "-hide_banner", "-y", "-i", source,
    "-filter:a", atempoChain(fitRatio),
    "-c:a", "pcm_s16le", "-ar", "24000", "-ac", "1", output,
  ]);
  ttsFiles.set("__narration__", output);
  ttsFiles.narrationDuration = await probeAudioDuration(output);
  ttsFiles.voiceTimingAdjusted = true;
  return ttsFiles;
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
    const keyframes = retimeKeyframes(trackingEvidenceFor(tracking, moment)?.keyframes || [], playbackRate);
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
  args.push(...await filterGraphFileArgs(ffmpegPath, filterScriptPath), "-map", "[outv]", "-map", "[outa]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-b:a", "192k", "-movflags", "+faststart", outputPath);
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
async function writeTransformationAudit(destination, job, media, frameable, contentScript) {
  const scenes = Array.isArray(frameable) ? frameable : [];
  let movingNetworks = [];
  try { movingNetworks = JSON.parse(await readFile(join(destination, "tactical", "motion-report.json"), "utf8")); }
  catch { /* The render may contain no eligible pass network. */ }
  const movingNetworkIds = new Set(movingNetworks.filter(report => report.approved).map(report => String(report.momentId)));
  const excerptDuration = scenes.reduce((total, moment) => total + Math.max(0, Number(moment.endTime) - Number(moment.startTime)), 0);
  const analyticallyTreated = scenes.filter(moment => moment.commentary
    || moment.onScreenText || moment.tacticalDrawing !== "none" || !["none", undefined].includes(moment.effect)).length;
  const continuouslyTreatedDuration = scenes.reduce((total, moment) => {
    const duration = Math.max(0, Number(moment.endTime) - Number(moment.startTime));
    const fullSceneGrade = ["cool", "clean", "warm", "dramatic", "goal_gold", "replay_blue"].includes(String(moment.colorGrade || "clean"));
    const originalAudioReplaced = job.settings.originalAudio === "muted" && Boolean(job.settings.commentary && contentScript);
    return total + (fullSceneGrade && originalAudioReplaced ? duration : 0);
  }, 0);
  const transformationAudit = {
    version: 5,
    purpose: "Original football criticism, commentary, and tactical analysis",
    outputFormat: job.settings.aspectRatio,
    originalAudioRemoved: job.settings.originalAudio === "muted",
    continuousOriginalNarration: Boolean(job.settings.commentary && contentScript),
    continuousNaturalExposureTreatment: true,
    editorialColorSystem: "natural_scene_specific_analysis_grades",
    notice: "This production record documents editorial purpose; it is not a legal determination of fair use and cannot prevent platform claims.",
    sourceDuration: Number(media?.duration || 0),
    excerptDuration: Number(excerptDuration.toFixed(3)),
    excerptToSourceRatio: Number((excerptDuration / Math.max(1, Number(media?.duration || 0))).toFixed(4)),
    analyticalTreatmentCoverage: Number((analyticallyTreated / Math.max(1, scenes.length)).toFixed(4)),
    continuousTimelineTreatmentCoverage: Number((continuouslyTreatedDuration / Math.max(0.001, excerptDuration)).toFixed(4)),
    movingTacticalNetworkSceneCount: movingNetworkIds.size,
    eventAwarePresentation: true,
    liveGoalCueCount: scenes.filter(moment => moment.eventType === "goal" && !moment.isReplay && moment.storyPhase !== "replay" && moment.soundEffect === "goal").length,
    replayGoalCueCount: scenes.filter(moment => (moment.isReplay || moment.storyPhase === "replay") && moment.soundEffect === "goal").length,
    scenes: scenes.map((moment) => ({
      id: moment.id,
      sourceStart: moment.startTime,
      sourceEnd: moment.endTime,
      eventType: moment.eventType,
      analyticalPurpose: moment.analysisPurpose || moment.transformationReason || moment.commentary || "Evidence for the video's original football analysis.",
      narration: moment.commentary || null,
      transformation: {
        caption: moment.onScreenText || null,
        effect: moment.effect || "none",
        freezeAtPhase: moment.freezeAtPhase || null,
        tacticalDrawing: moment.tacticalDrawing || "none",
        movingTacticalNetwork: movingNetworkIds.has(String(moment.id)),
        colorGrade: moment.colorGrade || "clean",
        fullSceneColorGrade: true,
        continuousNaturalExposureTreatment: true,
        movingPlayerHighlight: moment.playerHighlight !== false,
        playerHighlightPolicy: "verified ball carrier only; sustained handoff; hidden on uncertainty and after decisive contact",
        eventCallout: Number(moment.presentationVersion || 1) >= 2 ? moment.eventCallout || "none" : "none",
        transitionPolicy: "scene-local reveal after the preceding action completes; no action-overlap transition",
        sourceAudio: job.settings.originalAudio,
        originalAudioReplacedByNarration: job.settings.originalAudio === "muted" && Boolean(job.settings.commentary && contentScript),
      },
    })),
  };
  await writeFile(join(destination, "transformation-audit.json"), JSON.stringify(transformationAudit, null, 2));
}

async function validateRenderedVideo(outputPath, settings) {
  const media = await probe(outputPath);
  const bounds = outputDurationBounds(settings);
  const expected = outputDimensions(settings);
  if (media.width !== expected.width || media.height !== expected.height) {
    throw new Error(`Rendered video is ${media.width}x${media.height}; expected full-screen ${expected.width}x${expected.height}.`);
  }
  if (!media.hasAudio) throw new Error("Rendered video is missing its narration/silence audio track.");
  if (media.duration < bounds.minimum - (settings.durationMode === "auto" ? 0 : 0.15) || media.duration > bounds.maximum + 0.15) {
    if (isViralReel(settings)) throw new Error(`The completed Viral Reel is ${media.duration.toFixed(2)} seconds; it must remain between ${bounds.minimum} and ${bounds.maximum} seconds without filler.`);
    if (settings.durationMode === "auto") throw new Error(`The completed story is only ${media.duration.toFixed(2)} seconds. Automatic highlights must contain at least ${bounds.minimum} seconds of complete actions; no ending padding was added.`);
    throw new Error(`Rendered video duration ${media.duration.toFixed(2)} seconds is outside the selected ${bounds.minimum}-${bounds.maximum} second range.`);
  }
  return {
    passed: true,
    media,
    targetDuration: settings.targetDuration,
    durationRange: { minimum: bounds.minimum, maximum: Number.isFinite(bounds.maximum) ? bounds.maximum : null },
    durationDelta: Number((media.duration - settings.targetDuration).toFixed(3)),
    originalAudioMutedDuringNarration: Boolean(settings.commentary),
  };
}

async function reviewRenderedVideoWithGemini(outputPath, media, id, settings, plannedMoments = [], matchContext = null) {
  const viral = isViralReel(settings);
  const complete = isCompleteHighlights(settings);
  const expectedCanvas = outputDimensions(settings);
  const model = process.env.GEMINI_MODEL;
  const ai = createGeminiClient();
  const proxyPath = join(outputRoot, id, "quality-review.mp4");
  const videoKbps = Math.round(clamp(13 * 1024 * 1024 * 8 / Math.max(1, media.duration) / 1000 - 64, 180, 1200));
  // A 360p/default-resolution review can hide the ball and caption defects.
  // Keep the finished edit's spatial detail; this changes review media only.
  const args = ["-hide_banner", "-y", "-i", outputPath, "-vf", "fps=4,scale=-2:720", "-c:v", "libx264", "-preset", "veryfast", "-b:v", `${videoKbps}k`, "-maxrate", `${videoKbps}k`, "-bufsize", `${videoKbps * 2}k`, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "48k", "-ac", "1", "-ar", "24000", "-movflags", "+faststart", proxyPath];
  await run(ffmpegPath, args);
  const proxy = await readFile(proxyPath);
  const selectedMoments = plannedMoments.filter(moment => moment.selectedForFinalVideo);
  const authoredText = selectedMoments.flatMap(moment => [moment.commentary,moment.onScreenText]).filter(Boolean).join(" \n");
  const expectedGoalClusters = new Set(selectedMoments.filter(moment => moment.eventType === "goal" && !moment.isReplay)
    .map(moment => moment.storyId || moment.id)).size;
  const verifiedEntities = verifiedIdentityNames(matchContext);
  const identityQaInstruction = verifiedEntities.length
    ? `Authored narration may use only these exact externally verified entities: ${JSON.stringify(verifiedEntities)}, and only verified score ${matchContext.finalScore}. Reject every other authored identity or score.`
    : "No player/team identity is independently verified: ANY authored player name, team name, nickname, or scoreline is a rejection.";  const prompt = [
    viral ? "Act as a strict social-football Viral Reel quality controller. Watch the complete rendered video from beginning to end before scoring it." : "Act as a strict football-analysis Shorts quality controller. Watch the complete rendered video from beginning to end before scoring it.",
    "Return JSON only with approved boolean, score 0-100, issues array, observations array, storyCoherence 0-100, voiceStyle 0-100, fullBleed 0-100, ballTracking 0-100, playerHighlight 0-100, framing 0-100, pacing 0-100, transitions 0-100, captions 0-100, watermarkMasking 0-100, and audio 0-100. For EVERY scene, observations must include startTime, endTime, visibleAction, spokenClaim, identityClaims array, narrationMismatch boolean, captionOverload boolean. Give specific visible evidence, not scores alone.",
    viral ? "This must be a coherent 30–45 second sequence of verified incidents. Every incident must keep its complete live action and same-incident reaction or replay proof together before moving to the next incident. Reject unrelated filler, duplicate padding, or unresolved action." : `This is a chronological match highlight containing ${expectedGoalClusters} distinct verified live goal cluster(s). Multiple goals are required when present. Judge coherence by whether each goal has its own setup, decisive action, result and same-goal reaction before the next incident; do not require the whole export to answer only one tactical question.`,
    "Treat local keyframe tracking as the primary visual truth; semantic labels never override failed keyframes. Judge goals, shots on target, shots, and saves as the product's primary content. If a confirmed goal is present, require a continuous readable sequence: scorer and ball before decisive contact, contact, ball flight, goalkeeper or goalmouth result, a brief result hold, then that exact goal's immediate celebration and/or replay proof. Reject a cut to another incident before the same-goal emotional payoff.",
    complete ? "When stable player identity is locally verified, a highlight must be one large, thick, red-only ring attached to that player during the decisive action. It is correct to omit a ring when scorer or player identity is unsafe; never penalize a truthful omission. Reject a small, thin, multicolor, white-outlined, floating, or wrong-player ring. It must disappear immediately when tracking confidence is lost and must not appear on celebrations." : "The highlighted player in a goal must be the scorer at the decisive touch, not the earlier passer, a defender, official, spectator, or substitute. The simple arrow or ring must stay attached to that tracked player and disappear when confidence is lost.",
    "For a shot on target or save, require the shooter and ball at contact, visible ball travel, and the goalkeeper or goalmouth result. Reject clips that start after contact or end before the outcome.",
    viral ? "Require purposeful event timing: freezes and markers are optional and only useful when narration explains that exact moment. Keep one natural base grade, a subtle goal-payoff accent, sparse impact sound, and 4-7 seconds of complete same-incident celebration when available. Reject stacked text, badges, unnecessary effects, random grades, or repeated celebration padding." : complete ? "Require purposeful event timing: freezes and markers are useful only when narration explains that exact moment. Keep one natural base grade, a clearly timed goal-payoff color accent, sparse impact sound, and 3-7 seconds of complete same-goal celebration when available. Reject stacked text, unnecessary effects, random grades, duplicate replays, or celebration padding." : "Require purposeful event timing: freezes and markers are OPTIONAL and only useful when narration explains that exact moment. Keep one natural base grade, a subtle goal-payoff accent, sparse impact sound, and 2-3 seconds of clean celebration. Reject stacked text, badges, unnecessary effects, random grades, or long celebration padding. The opening 0.8-second outcome teaser is intentionally followed by the complete buildup; do not treat that clearly repeated teaser as an incomplete standalone action.",
    `Every gameplay scene must fill the ${expectedCanvas.width}x${expectedCanvas.height} canvas edge-to-edge without black bars, blurred panels, or a small horizontal inset. The football and involved player must remain visible together. Reject visible camera shaking, rapid left-right corrections, false late ball reacquisition, or an empty-pitch goal hold. Player-only framing is allowed only for a brief reaction or celebration.`,
    "Reject every gameplay scene whose first visible sample does not establish the involved player and football together. Before contact keep both in frame; after contact leave the player and follow the ball through its flight to the goalkeeper or goalmouth. A red player ring must end at contact. Alternate broadcast views may use a ball marker only when it clarifies the same incident.",
    "Scene duration must follow and finish the visible action with no fixed per-scene duration; never cut during an unresolved pass, shot, save, duel, or run. Prefer fewer complete scenes and hard cuts. Use slow motion, freezes, zooms, transitions, color changes, emojis, callouts, and sound accents only when they explain a visible point.",
    "The base color grade must stay consistent and natural. Replay or decisive-proof treatment may differ, and a confirmed goal or shot payoff should have a clearly timed color accent, but random alternating color grades are a defect.",
    "Captions are sparse 2-to-4-word complete headlines, NOT continuous subtitles. Require white text, one yellow emphasis word, a dark outline and restrained motion. Most frames and celebrations should have NO added text. Reject dangling fragments and any headline that contradicts the visible action.",
    "The spoken track must sound like continuous football commentary or criticism. Reject narration that says replay, clip, footage, camera, freeze, slow motion, editing, or otherwise describes how the video was produced. Visuals may support a narration beat without matching every word literally, but they must belong to the same incident.",
    viral ? "Use one short analytical voice-over for each verified decisive incident, aligned to its freeze, mixed above quieter original match and crowd audio. Reject competing broadcast speech, mistimed analysis, or continuous play-by-play. Added narration and captions must contain no player name, team name, nickname, or scoreline because identity was not independently verified. Never treat names already visible in the broadcast scoreboard or shirts as authored overlays." : `Narration uses a clear, compelling adult male football analyst voice continuously from the opening hook through the final conclusion, with only brief punctuation pauses. For complete highlights, require a chronological recap that connects every goal, major visible turning point, momentum change, and a concise explanation of why the result happened. Reject disconnected generic tactical lines and continuous play-by-play. ${identityQaInstruction} Extract identityClaims only from authored narration or added captions; never infer them from the broadcast scoreboard, crowd signage, or shirts.`,
    `The exact authored narration and captions are supplied here for identity auditing: ${JSON.stringify(authoredText)}.`,
    footballQualityContract(),
    viral ? "The verified Viral Reel must run 30ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“45 seconds using complete incidents, with no repetitive padding." : settings.durationMode === "auto" ? "AI selected the length. Require at least " + outputDurationBounds(settings).minimum + " seconds and a naturally completed story, with no repetitive or static filler. Do not reject a complete story for missing an estimated target." : "The selected output duration range is " + outputDurationBounds(settings).minimum + "-" + outputDurationBounds(settings).maximum + " seconds. Reject any result outside it.",
    "Narration requested: " + settings.commentary + ". Player highlighting requested: " + settings.playerHighlight + ". Logo/scorebug masking requested: " + settings.logoMasking + ". If masking is requested, reject clearly visible persistent creator logos, channel badges, attribution watermarks, scorebugs, game clocks, or network headers; do not penalize a mask that leaves players, ball, goalmouth action, and pitch readable.",
    "Do not invent problems that cannot be observed. Approve only at score 80 or higher with no severe story, full-screen framing, missing-action, narration, or caption issue.",
  ].join(" ");
  const generated = await generateGeminiJson(ai, {
    model,
    contents: [footballVideoPart(proxy.toString("base64"), 4), { text: prompt }],
    config: { responseMimeType: "application/json", temperature: 0.05,
      httpOptions: {timeout:geminiVideoDeadline(geminiRequestTimeoutMs, media.duration)} },
  }, "final quality review", 3);
  const parsed = generated.parsed;
  let issues = Array.isArray(parsed.issues) ? parsed.issues.map((issue) => String(issue).slice(0, 240)).slice(0, 8) : [];
  const observations = Array.isArray(parsed.observations) ? parsed.observations : [];
  if (observations.length < (viral ? 1 : 2)) issues.push("Quality review did not provide scene-by-scene evidence.");
  for (const observation of observations) {
    const authoredClaims = Array.isArray(observation.identityClaims) ? observation.identityClaims
      .filter((claim) => unverifiedNamedEntities([claim], verifiedEntities).length && !scoreClaimIsVerified(claim, matchContext))
      .filter(claim => authoredText.toLowerCase().includes(String(claim).toLowerCase())) : [];
    if (!Array.isArray(observation.identityClaims) || authoredClaims.length) issues.push(`Unverified or unaudited identity claim at ${observation.startTime}s.`);
    if (observation.narrationMismatch !== false) issues.push(`Narration/evidence mismatch or missing check at ${observation.startTime}s.`);
    if (observation.captionOverload !== false) issues.push(`Caption overload or missing check at ${observation.startTime}s.`);
  }
  const reportedAuthoredClaim = observations.some(observation => Array.isArray(observation.identityClaims)
    && observation.identityClaims.some((claim) => unverifiedNamedEntities([claim], verifiedEntities).length
      && !scoreClaimIsVerified(claim, matchContext)
      && authoredText.toLowerCase().includes(String(claim).toLowerCase())));
  if (!reportedAuthoredClaim) issues = issues.filter(issue => !/\b(?:identity|player name|team name|club identity|nickname|scoreline)\b/i.test(issue));
  const score = scoreField(parsed.score, 0);
  const watermarkMasking = scoreField(parsed.watermarkMasking, 0);
  issues = [...new Set(issues)];
  return {
    approved: Boolean(parsed.approved) && score >= 80 && issues.length === 0,
    score,
    issues,
    observations,
    storyCoherence: scoreField(parsed.storyCoherence, 0),
    voiceStyle: scoreField(parsed.voiceStyle, 0),
    fullBleed: scoreField(parsed.fullBleed, 0),
    ballTracking: scoreField(parsed.ballTracking, 0),
    playerHighlight: scoreField(parsed.playerHighlight, 0),
    framing: scoreField(parsed.framing, 0),
    pacing: scoreField(parsed.pacing, 0),
    transitions: scoreField(parsed.transitions, 0),
    captions: scoreField(parsed.captions, 0),
    watermarkMasking,
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

function run(command, args, onLine) {
  if (resolve(command) === resolve(ffmpegPath)) args = boundedFfmpegArgs(args);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, windowsHide: true, shell: false });
    let stdout = ""; let stderr = "";
    let pending = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (onLine) {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) onLine(line);
        if (stdout.length > 24000) stdout = stdout.slice(-24000);
      }
    });
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

async function listLocalJobs(response) {
  const files = (await readdir(jobRoot)).filter(name => /^[a-f0-9-]+\.json$/i.test(name));
  const jobs = (await Promise.all(files.map(async name => {
    try { return publicJob(JSON.parse(await readFile(join(jobRoot, name), "utf8"))); } catch { return null; }
  }))).filter(Boolean).sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
  const storageBytes = jobs.reduce((sum, job) => sum + Number(job.sourceSize || 0), 0);
  return json(response, 200, { jobs, storageBytes, jobCount: jobs.length });
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

async function streamLocalSource(request, response, id) {
  let job;
  try { job = await readJob(id); } catch { return json(response, 404, { error: "Ready source not found" }); }
  // The original-video library is independent of edit progress. Starting
  // analysis must not revoke preview/download access to the secured source.
  if (!job.sourceKey || job.stage === 'uploading' || job.stage === 'importing')
    return json(response, 404, { error: "Ready source not found" });
  try {
    const info = await stat(job.sourceKey);
    const { createReadStream } = await import("node:fs");
    const range = String(request.headers.range || "").match(/^bytes=(\d*)-(\d*)$/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= info.size) {
        response.writeHead(416, { "Content-Range": `bytes */${info.size}` }); return response.end();
      }
      response.writeHead(206, { "Content-Type": job.sourceContentType || mimeFor(job.sourceKey), "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${info.size}`, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
      return createReadStream(job.sourceKey, { start, end }).pipe(response);
    }
    response.writeHead(200, { "Content-Type": job.sourceContentType || mimeFor(job.sourceKey), "Content-Length": info.size, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
    return createReadStream(job.sourceKey).pipe(response);
  } catch { return json(response, 404, { error: "Stored source not found" }); }
}

async function updateJob(job, stage, progress, extra = {}) {
  const latest=await readJob(job.id).catch(()=>job);
  // Concurrent scene requests can cool down different models. Retain all of
  // them durably, rather than restoring only the most recent UI wait on reboot.
  const cooldowns=mergeGeminiModelCooldowns(job.aiModelCooldowns,latest.aiModelCooldowns,
    geminiModelCooldownStates.get(job.id),extra.aiModelCooldowns);
  geminiModelCooldownStates.set(job.id,cooldowns);
  if (Object.hasOwn(extra, "aiCapacityWait")) geminiCapacityStates.set(job.id, extra.aiCapacityWait);
  const next = { ...job, progressDetail: stage === job.stage ? job.progressDetail : undefined,
    ...extra, stage, progress: Math.max(Number(job.progress || 0), progress), updatedAt: new Date().toISOString() };
  next.sceneTrackingStates={...job.sceneTrackingStates,...latest.sceneTrackingStates,...extra.sceneTrackingStates};
  next.aiModelCooldowns=cooldowns;
  for(const flag of ['sceneSelectionComplete','visualEditLocked','narrationScriptApproved','narrationRecorded','renderCompleted'])
    if(latest[flag]===true && !Object.hasOwn(extra,flag)) next[flag]=true;
  // A pipeline function may still hold the pre-request job object. Do not
  // resurrect its old busy flag after the scheduler received a response.
  if (geminiCapacityStates.has(job.id)) next.aiCapacityWait = geminiCapacityStates.get(job.id);
  next.workflowPhase=workflowPhase(next);
  next.performance=workflowPerformance.observe(next,latest.performance);
  if(stage==='generating_commentary') next.narrationScriptApproved=true;
  if(stage==='editing'&&next.settings?.commentary&&!Object.hasOwn(extra,'narrationRecorded')) next.narrationRecorded=true;
  if(stage==='validating'||stage==='completed') next.renderCompleted=true;
  await saveJob(next); return next;
}
async function saveJob(job) { await saveJobJson(job.id, job); }
async function readJob(id) { return JSON.parse(await readFile(join(jobRoot, `${id}.json`), "utf8")); }
function publicJob(job) {
  const safe = { ...job,workflow:buildWorkflowProgress(job) };
  delete safe.sourceKey; delete safe.outputKey;
  delete safe.importUrl;
  delete safe.observedMoments;
  return safe;
}

function requestedRecapSeconds(brief) {
  const text = String(brief || "");
  const minutes = text.match(/\b(\d{1,2}(?:\.\d+)?)\s*(?:-\s*)?(?:minutes?|mins?|min)\b/i);
  if (minutes) return Number(minutes[1]) * 60;
  const seconds = text.match(/\b(\d{2,3})\s*(?:-\s*)?(?:seconds?|secs?|sec)\b/i);
  return seconds ? Number(seconds[1]) : null;
}

function parseSettings(header) {
  const defaults = { editStyle: "complete_highlights", durationMode: "auto", targetDuration: 60, durationMin: COMPLETE_RECAP_MINIMUM_SECONDS, durationMax: COMPLETE_RECAP_MAXIMUM_SECONDS, aspectRatio: "9:16", commentary: true, playerHighlight: true, captions: true, logoMasking: true, originalAudio: "muted", intensity: "dynamic", recapBrief: "" };
  if (!header) return defaults;
  try {
    const raw = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    const editStyle = ["complete_highlights", "viral_reel", "tactical_analysis"].includes(raw.editStyle) ? raw.editStyle : "complete_highlights";
    const viral = editStyle === "viral_reel";
    const complete = editStyle === "complete_highlights";
    const automatic = automaticDurationSettings();
    const recapBrief = Array.from(String(raw.recapBrief || ""), (character) => character.charCodeAt(0) < 32 ? " " : character).join("").replace(/\s+/g, " ").trim().slice(0, 320);
    const requestedSeconds = complete ? requestedRecapSeconds(recapBrief) : null;
    const requestedTarget = clamp(Number(requestedSeconds), COMPLETE_RECAP_MINIMUM_SECONDS, 300);
    const duration = requestedSeconds
      ? { durationMode: "requested", targetDuration: requestedTarget, durationMin: COMPLETE_RECAP_MINIMUM_SECONDS, durationMax: COMPLETE_RECAP_MAXIMUM_SECONDS }
      : viral ? { durationMode: "auto", targetDuration: 36, durationMin: 30 }
        : complete ? { durationMode: "auto", targetDuration: 60, durationMin: COMPLETE_RECAP_MINIMUM_SECONDS, durationMax: COMPLETE_RECAP_MAXIMUM_SECONDS }
          : automatic;
    const requestedRatio = String(raw.aspectRatio || "");
    const aspectRatio = viral ? "4:5" : ["1:1", "4:3", "9:16", "16:9"].includes(requestedRatio)
      ? requestedRatio
      : "9:16";
    const settings = { ...defaults, ...raw, ...duration, recapBrief, editStyle, aspectRatio, commentary: complete ? true : raw.commentary !== false, originalAudio: complete ? "muted" : raw.originalAudio || (viral ? "reduced" : "muted") };
    return settings;
  }
  catch { throw new Error("Invalid edit settings."); }
}
function isCompleteHighlights(settings) { return settings?.editStyle === "complete_highlights"; }

function neutralOverlayText(moment) {
  if (moment?.eventType === "celebration" || moment?.storyPhase === "reaction") return undefined;
  if (moment?.isReplay || moment?.storyPhase === "replay") return "TACTICAL REPLAY";
  return ({
    goal: "THE DECISIVE TOUCH",
    disallowed_goal: "THE DECISION",
    shot_on_target: "ON TARGET",
    shot_off_target: "JUST WIDE",
    save: "THE SAVE",
    big_chance: "THE BIG CHANCE",
    foul: "THE CHALLENGE",
    free_kick: "THE SET PIECE",
  })[moment?.eventType] || "THE KEY MOMENT";
}

function sanitizeUnverifiedMoments(moments, matchContext) {
  if (matchContext?.status === "verified") return moments;
  let replayCaptionUsed = false;
  return (Array.isArray(moments) ? moments : []).map((moment) => {
    const replay = Boolean(moment?.isReplay || moment?.storyPhase === "replay");
    const suppressCaption = replay && replayCaptionUsed;
    if (replay) replayCaptionUsed = true;
    return {
      ...moment,
      suppressCaption,
      onScreenText: suppressCaption ? undefined : neutralOverlayText(moment),
    };
  });
}

function sanitizeUnverifiedContentPlan(plan, matchContext, settings) {
  if (matchContext?.status === "verified") return plan;
  const safeCaptions = {
    hook: "MATCH TURNING POINTS", setup: "THE OPENING MOVE", analysis: "WHY IT WORKED",
    evidence: "DECISIVE EVIDENCE", turn: "MOMENTUM SHIFTS", conclusion: "THE FINAL LESSON",
  };
  return {
    ...plan,
    title: isCompleteHighlights(settings) ? "How Decisive Moments Shaped This Match" : plan.title,
    contentBeats: (Array.isArray(plan?.contentBeats) ? plan.contentBeats : []).map((beat) => ({
      ...beat,
      captionText: safeCaptions[beat.role] || "THE KEY MOMENT",
    })),
  };
}

function sanitizeSavedEditPlan(editPlan, matchContext, settings) {
  const sanitized = sanitizeUnverifiedContentPlan(editPlan || {}, matchContext, settings);
  return { ...editPlan, title: sanitized.title, contentBeats: sanitized.contentBeats };
}
function applyCompleteDurationBounds(settings, sourceDuration) {
  const bounds = completeRecapDurationBounds(sourceDuration);
  const targetDuration = clamp(Number(settings?.targetDuration || bounds.minimum), bounds.minimum, bounds.maximum);
  const aspectRatio = ["1:1", "4:3", "9:16", "16:9"].includes(String(settings?.aspectRatio)) ? settings.aspectRatio : "9:16";
  return { ...settings, aspectRatio, originalAudio: "muted", targetDuration, durationMin: bounds.minimum, durationMax: bounds.maximum };
}
function outputDurationBounds(settings) {
  if (isViralReel(settings)) return viralReelDurationBounds();
  if (isCompleteHighlights(settings)) return { minimum: COMPLETE_RECAP_MINIMUM_SECONDS,
    maximum: Number.isFinite(Number(settings.durationMax)) ? Number(settings.durationMax) : Infinity };
  // Automatic non-viral jobs may have been saved by an older worker with a
  // 30-second durationMin. Do not let that stale setting reject a naturally
  // complete short story; only the dedicated Viral Reel keeps a hard floor.
  if (settings?.durationMode === "auto") return { minimum: 0, maximum: Number.isFinite(Number(settings.durationMax)) ? Number(settings.durationMax) : Infinity };
  const target = Number(settings?.targetDuration || 65);
  const minimum = Number.isFinite(Number(settings?.durationMin)) ? Number(settings.durationMin) : target * 0.96;
  const maximum = Number.isFinite(Number(settings?.durationMax)) ? Number(settings.durationMax) : target + 3;
  return { minimum, maximum };
}
function minimumPlannedDuration(settings) { return isViralReel(settings) ? viralReelDurationBounds().minimum : isCompleteHighlights(settings) ? Number(settings.durationMin ?? COMPLETE_RECAP_MINIMUM_SECONDS) : settings.durationMode === "auto" ? 0 : Math.max(MIN_SCENE_SECONDS * 2, settings.targetDuration - 1); }
function planningCeiling(settings) { return isCompleteHighlights(settings) ? (Number.isFinite(Number(settings.durationMax)) ? Number(settings.durationMax) : Infinity) : settings.durationMode === "auto" ? (Number.isFinite(Number(settings.durationMax)) ? Number(settings.durationMax) : Infinity) : settings.targetDuration; }
function planningEvidenceCapacity(candidates, settings) {
  const eligible = selectDirectorCandidates(candidates).filter((moment) => framingEligible(moment)
    || (settings?.aspectRatio === "16:9" && canRenderLockedNativeAction(moment)));
  // Complete recaps later retain up to seven seconds of independently
  // verified reaction source. Count that same real footage here, rather than
  // rejecting the plan under a different three-second pre-render cap.
  if (isCompleteHighlights(settings)) return renderableEvidenceCapacity(eligible,.08,{maximumReactionSeconds:7});
  return settings.durationMode === "auto" ? naturalStoryCapacity(eligible) : editableEvidenceDuration(candidates);
}
function safeFileName(name) { return basename(name).replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180) || "source.mp4"; }
function resolveSetting(value) { return isAbsolute(value) ? value : resolve(projectRoot, value); }
function resolveExecutable(value) { return /[\\/]/.test(value) ? resolveSetting(value) : value; }
function mimeFor(path) { return extname(path).toLowerCase() === ".mov" ? "video/quicktime" : extname(path).toLowerCase() === ".webm" ? "video/webm" : "video/mp4"; }
function publicOutputUrl(id) { return `${publicBaseUrl}/outputs/${encodeURIComponent(id)}/final.mp4`; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)); }
function setCors(request, response) { const origin = String(request.headers.origin || ""); if (allowedOrigins.has(origin)) response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Access-Control-Allow-Headers", "content-type,x-file-name,x-edit-settings,x-job-id"); response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS"); }
function json(response, status, value) { if(!response)return value; response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); }
function send(response, status) { response.writeHead(status); response.end(); }
function youtubeCallbackHtml(response, { channel, returnOrigin = localStudioReturnOrigin(), error }) {
  const payload = JSON.stringify({ type: "touchline-youtube-connected", channel: channel || null, error: error || null }).replace(/</g, "\\u003c");
  const targetOrigin = JSON.stringify(returnOrigin).replace(/</g, "\\u003c");
  const title = error ? "YouTube connection failed" : "YouTube connected";
  const message = error || `${channel?.title || "YouTube channel"} is ready for private uploads.`;
  response.writeHead(error ? 400 : 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#101410;color:#eef2e9;font:16px system-ui}.card{max-width:440px;padding:32px;border:1px solid #394039;border-radius:16px;background:#171d18}h1{margin:0 0 10px;color:#c8ff52}p{line-height:1.5}</style></head><body><main class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p>You can close this window.</p></main><script>if(window.opener){window.opener.postMessage(${payload},${targetOrigin});window.close();}</script></body></html>`);
}
function escapeHtml(value) { return String(value || "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
async function readJsonBody(request, maximumBytes) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (Buffer.byteLength(text) > maximumBytes) throw new Error("Request body is too large.");
  }
  try { return JSON.parse(text || "{}"); } catch { throw new Error("Request body must be valid JSON."); }
}
async function inspectTools() {
  const [ffmpeg, ffprobe, trackingPython, trackingModel, trackingBallModel, soccerNetPython, soccerNetModel] = await Promise.all([
    run(ffmpegPath, ["-version"]).then(() => true).catch(() => false),
    run(ffprobePath, ["-version"]).then(() => true).catch(() => false),
    stat(trackingPythonPath).then(() => true).catch(() => false),
    stat(trackingModelPath).then(() => true).catch(() => false),
    stat(trackingBallModelPath).then(() => true).catch(() => false),
    stat(soccerNetPythonPath).then(() => true).catch(() => false),
    stat(soccerNetModelPath).then(() => true).catch(() => false),
  ]);
  return { ffmpeg, ffprobe, trackingPython, trackingModel, trackingBallModel, soccerNetPython, soccerNetModel, ffmpegPath, ffprobePath };
}async function loadDotEnv(path) { try { const text = await readFile(path, "utf8"); for (const line of text.split(/\r?\n/)) { const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!match || process.env[match[1]] !== undefined) continue; process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2"); } } catch { /* The local .env file is optional. */ } }
