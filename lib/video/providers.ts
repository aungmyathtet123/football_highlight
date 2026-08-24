import type { EditSettings, FootballMoment } from "./types";

export interface VideoUnderstandingProvider {
  analyze(input: { sourceUrl: string; durationSeconds: number; settings: EditSettings; signal?: AbortSignal }): Promise<FootballMoment[]>;
}

export interface TrackingProvider {
  track(input: { sourceUrl: string; moments: FootballMoment[]; signal?: AbortSignal }): Promise<FootballMoment[]>;
}

export interface CommentaryProvider {
  generate(input: { sourceUrl: string; moments: FootballMoment[]; signal?: AbortSignal }): Promise<FootballMoment[]>;
}

export interface RenderProvider {
  render(input: { sourceUrl: string; moments: FootballMoment[]; settings: EditSettings; outputKey: string; signal?: AbortSignal }): Promise<{ outputKey: string; durationSeconds: number }>;
}

export class ProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) { super(message); this.name = "ProviderError"; }
}
