// Detection owns coordinates; Gemini reviews the actual moving portrait crop.
// Keep this policy explicit so a benchmark never changes a deployed worker.
export function fastTrackingPolicy(env = process.env) {
  const enabled = env.FAST_TRACKING_ENABLED === 'true';
  return {
    enabled,
    reviewModel: env.GEMINI_FRAMING_REVIEW_MODEL || env.GEMINI_DISCOVERY_MODEL || env.GEMINI_MODEL,
    reviewFps: 12,
    sampleFps: 12,
    coarseSampleFps: 8,
    reviewConcurrency: Math.max(1, Math.min(2, Number(env.TRACKING_SCENE_CONCURRENCY) || 2)),
    personModel: env.HYBRID_TRACKING_MODEL || './tools/tracking/football-role-detector.pt',
    ballModel: env.HYBRID_BALL_MODEL || './tools/tracking/yolo-football-ball-detection.pt',
  };
}

export function videoEncoderArgs(env = process.env) {
  // Explicit activation after a GPU canary; no claim that software filters
  // become GPU filters or that every installed FFmpeg supports NVENC.
  if (env.VIDEO_ENCODER === 'h264_nvenc') return [
    '-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '20', '-b:v', '0',
  ];
  return ['-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '20'];
}
