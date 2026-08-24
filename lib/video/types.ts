export type JobStage =
  | "uploaded"
  | "analyzing"
  | "detecting_moments"
  | "tracking"
  | "ranking"
  | "generating_commentary"
  | "editing"
  | "rendering"
  | "completed"
  | "failed";

export type EventType =
  | "goal"
  | "penalty"
  | "assist"
  | "big_chance"
  | "shot_on_target"
  | "save"
  | "free_kick"
  | "var"
  | "skill"
  | "dribble"
  | "tackle"
  | "celebration"
  | "normal_play";

export type CropPoint = { time: number; x: number; y: number; confidence: number };

export type OverlayMask = {
  id: string;
  kind: "logo" | "watermark";
  /** Normalized 0–1 output-frame coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  firstSeen: number;
  lastSeen: number;
};

export type FootballMoment = {
  id: string;
  startTime: number;
  endTime: number;
  eventType: EventType;
  importanceScore: number;
  description: string;
  confidence: number;
  ballVisible: boolean;
  mainPlayerVisible: boolean;
  recommendedCrop: CropPoint[];
  selectedForFinalVideo: boolean;
  commentary?: string;
  duplicateGroup?: string;
};

export type EditSettings = {
  targetDuration: 60 | 65 | 70 | 80 | number;
  aspectRatio: "9:16";
  commentary: boolean;
  playerHighlight: boolean;
  captions: boolean;
  logoMasking: boolean;
  originalAudio: "normal" | "reduced" | "muted";
  intensity: "natural" | "dynamic" | "high_energy";
};

export type ProcessingJob = {
  id: string;
  stage: JobStage;
  progress: number;
  sourceKey: string;
  outputKey?: string;
  settings: EditSettings;
  moments: FootballMoment[];
  error?: { code: string; message: string; retryable: boolean };
  createdAt: string;
  updatedAt: string;
};
