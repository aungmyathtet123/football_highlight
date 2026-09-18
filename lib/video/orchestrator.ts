import { packTimeline } from "./ranking";
import type { CommentaryProvider, RenderProvider, TrackingProvider, VideoUnderstandingProvider } from "./providers";
import { ProviderError } from "./providers";
import type { EditSettings, FootballMoment, JobStage, ProcessingJob } from "./types";

export interface JobRepository {
  get(id: string): Promise<ProcessingJob | null>;
  update(id: string, patch: Partial<Pick<ProcessingJob, "stage" | "progress" | "moments" | "outputKey" | "error" | "updatedAt">>): Promise<void>;
}

export interface ProcessingDependencies {
  jobs: JobRepository;
  analyzer: VideoUnderstandingProvider;
  tracker: TrackingProvider;
  commentary: CommentaryProvider;
  renderer: RenderProvider;
  resolveSourceUrl(sourceKey: string): Promise<string>;
  logger?: Pick<Console, "info" | "error">;
}

export async function processVideoJob(jobId: string, dependencies: ProcessingDependencies, signal?: AbortSignal): Promise<void> {
  const log = dependencies.logger ?? console;
  const job = await dependencies.jobs.get(jobId);
  if (!job) throw new Error(`Unknown video job: ${jobId}`);
  try {
    const sourceUrl = await dependencies.resolveSourceUrl(job.sourceKey);
    await stage(dependencies, jobId, "analyzing", 12);
    let moments = await dependencies.analyzer.analyze({ sourceUrl, durationSeconds: 0, settings: job.settings, signal });
    await stage(dependencies, jobId, "detecting_moments", 34, moments);
    if (job.settings.durationMode !== "auto") moments = packTimeline(moments, job.settings.targetDuration);
    await stage(dependencies, jobId, "ranking", 46, moments);
    await stage(dependencies, jobId, "tracking", 55, moments);
    moments = await dependencies.tracker.track({ sourceUrl, moments, signal });
    const minimumDuration = job.settings.editStyle === "complete_highlights" ? 60 : 30;
    if (job.settings.durationMode === "auto") {
      const selectedDuration = moments.filter((moment) => moment.selectedForFinalVideo).reduce((total, moment) => total + (moment.endTime - moment.startTime) / (moment.playbackRate || 1) - (moment.transitionDuration || 0), 0);
      if (selectedDuration < minimumDuration) throw new ProviderError("INSUFFICIENT_EVIDENCE", `The AI-selected complete story must provide at least ${minimumDuration} seconds of verified footage.`);
      job.settings = { ...job.settings, targetDuration: selectedDuration };
    }
    if (job.settings.commentary) {
      await stage(dependencies, jobId, "generating_commentary", 68, moments);
      moments = await dependencies.commentary.generate({ sourceUrl, moments, signal });
    }
    await stage(dependencies, jobId, "editing", 78, moments);
    await stage(dependencies, jobId, "rendering", 86, moments);
    const outputKey = `exports/${jobId}/touchline-final.mp4`;
    const result = await dependencies.renderer.render({ sourceUrl, moments, settings: job.settings, outputKey, signal });
    if (job.settings.durationMode === "auto" && (!Number.isFinite(result.durationSeconds) || result.durationSeconds < (job.settings.editStyle === "complete_highlights" ? 60 : 30))) throw new ProviderError("SHORT_RENDER", `The rendered highlight must be at least ${job.settings.editStyle === "complete_highlights" ? 60 : 30} seconds.`);
    await dependencies.jobs.update(jobId, { stage: "completed", progress: 100, moments, outputKey: result.outputKey, error: undefined, updatedAt: new Date().toISOString() });
    log.info("video_job_completed", { jobId, durationSeconds: result.durationSeconds });
  } catch (error) {
    const providerError = error instanceof ProviderError ? error : new ProviderError("PROCESSING_FAILED", error instanceof Error ? error.message : "Unexpected processing error");
    await dependencies.jobs.update(jobId, { stage: "failed", error: { code: providerError.code, message: providerError.message, retryable: providerError.retryable }, updatedAt: new Date().toISOString() });
    log.error("video_job_failed", { jobId, code: providerError.code, retryable: providerError.retryable });
  }
}

async function stage(dependencies: ProcessingDependencies, id: string, next: JobStage, progress: number, moments?: FootballMoment[]) {
  await dependencies.jobs.update(id, { stage: next, progress, moments, updatedAt: new Date().toISOString() });
  dependencies.logger?.info("video_job_stage", { jobId: id, stage: next, progress });
}

export function validateSettings(input: Partial<EditSettings>): EditSettings {
  const originalAudio = input.originalAudio ?? "reduced";
  const intensity = input.intensity ?? "dynamic";
  const editStyle = input.editStyle ?? "complete_highlights";
  if (!["normal", "reduced", "muted"].includes(originalAudio)) throw new ProviderError("INVALID_AUDIO_MODE", "Original audio mode is not supported.");
  if (!["natural", "dynamic", "high_energy"].includes(intensity)) throw new ProviderError("INVALID_INTENSITY", "Editing intensity is not supported.");
  if (!["complete_highlights", "viral_reel", "tactical_analysis"].includes(editStyle)) throw new ProviderError("INVALID_EDIT_STYLE", "Edit style is not supported.");
  const viral = editStyle === "viral_reel";
  return { editStyle, durationMode: "auto", targetDuration: viral ? 36 : editStyle === "complete_highlights" ? 60 : 30, durationMin: editStyle === "complete_highlights" ? 60 : 30, aspectRatio: viral ? "4:5" : "9:16", commentary: input.commentary ?? true, playerHighlight: input.playerHighlight ?? true, captions: input.captions ?? true, logoMasking: input.logoMasking ?? true, originalAudio: viral && input.originalAudio === undefined ? "reduced" : originalAudio, intensity };
}
