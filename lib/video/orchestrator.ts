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
    moments = packTimeline(moments, job.settings.targetDuration);
    await stage(dependencies, jobId, "ranking", 46, moments);
    await stage(dependencies, jobId, "tracking", 55, moments);
    moments = await dependencies.tracker.track({ sourceUrl, moments, signal });
    if (job.settings.commentary) {
      await stage(dependencies, jobId, "generating_commentary", 68, moments);
      moments = await dependencies.commentary.generate({ sourceUrl, moments, signal });
    }
    await stage(dependencies, jobId, "editing", 78, moments);
    await stage(dependencies, jobId, "rendering", 86, moments);
    const outputKey = `exports/${jobId}/touchline-final.mp4`;
    const result = await dependencies.renderer.render({ sourceUrl, moments, settings: job.settings, outputKey, signal });
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
  const allowedDurations = new Set([60, 65, 70, 80]);
  const targetDuration = Number(input.targetDuration ?? 65);
  if (!allowedDurations.has(targetDuration)) throw new ProviderError("INVALID_DURATION", "Final length must be 60, 65, 70, or 80 seconds.");
  const originalAudio = input.originalAudio ?? "reduced";
  const intensity = input.intensity ?? "dynamic";
  if (!["normal", "reduced", "muted"].includes(originalAudio)) throw new ProviderError("INVALID_AUDIO_MODE", "Original audio mode is not supported.");
  if (!["natural", "dynamic", "high_energy"].includes(intensity)) throw new ProviderError("INVALID_INTENSITY", "Editing intensity is not supported.");
  return { targetDuration, aspectRatio: "9:16", commentary: input.commentary ?? true, playerHighlight: input.playerHighlight ?? true, captions: input.captions ?? true, logoMasking: input.logoMasking ?? true, originalAudio, intensity };
}
