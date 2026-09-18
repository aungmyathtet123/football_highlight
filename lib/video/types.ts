export type JobStage =
  | "uploaded"
  | "analyzing"
  | "detecting_moments"
  | "writing_content"
  | "aligning_content"
  | "tracking"
  | "ranking"
  | "generating_commentary"
  | "editing"
  | "rendering"
  | "validating"
  | "completed"
  | "failed";

export type EventType =
  | "goal"
  | "disallowed_goal"
  | "offside"
  | "penalty"
  | "assist"
  | "big_chance"
  | "shot_on_target"
  | "save"
  | "foul"
  | "yellow_card"
  | "red_card"
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
  storyId?: string;
  storyPhase?: "hook" | "build_up" | "action" | "payoff" | "reaction" | "replay" | "standalone";
  keepDecision?: "keep" | "support" | "replay" | "reject";
  sourceImportanceScore?: number;
  hookScore?: number;
  flowScore?: number;
  visualClarity?: number;
  excitementScore?: number;
  narrativeCompleteness?: number;
  rejectReason?: string;
  isReplay?: boolean;
  editOrder?: number;
  beatId?: string;
  role?: string;
  transitionIn?: "cut" | "crossfade" | "crosszoom" | "whip" | "flash";
  playerHighlight?: boolean;
  tacticalDrawing?: "none" | "ball" | "run" | "pass" | "map";
  transitionDuration?: number;
  effect?: "none" | "punch_zoom" | "slow_motion" | "speed_up" | "replay_treatment" | "freeze_analysis";
  playbackRate?: number;
  freezeAtPhase?: "origin" | "contact" | "payoff";
  freezeDuration?: number;
  narrationDelay?: number;
  suppressPayoffCaption?: boolean;
  identityLabel?: string;
  analysisPurpose?: string;
  onScreenText?: string;
  eventCallout?: "none" | "amazing" | "goal" | "shot" | "save" | "foul" | "card" | "close" | "pass" | "celebration";
  colorGrade?: "cool" | "clean" | "warm" | "dramatic" | "goal_gold" | "replay_blue";
  soundEffect?: "none" | "whoosh" | "impact" | "goal" | "whistle" | "sparkle";
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
  editStyle?: "complete_highlights" | "viral_reel" | "tactical_analysis";
  durationMode?: "auto" | "requested";
  recapBrief?: string;
  targetDuration: 60 | 65 | 70 | 80 | number;
  durationMin?: number;
  durationMax?: number;
  aspectRatio: "4:5" | "9:16" | "16:9";
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
