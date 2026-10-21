// Sending an HD file alone does not request detailed Gemini video processing.
// Gemini 3's default video setting uses 70 tokens/frame; HIGH uses 280 and is
// recommended for small within-frame details such as the moving football.
// https://ai.google.dev/gemini-api/docs/media-resolution
export const NARRATION_VIDEO_PROFILE = Object.freeze({ version: 1, fps: 2, resolution: "MEDIUM" });

// HIGH remains the default for discovery, small-ball observations and actual
// crop verification. Only the writer's already-verified whole-edit overview
// uses MEDIUM; it does not replace any action or framing evidence.
export function footballVideoPart(data, fps, resolution = "HIGH") {
  if (!Number.isFinite(fps) || fps <= 0 || fps > 120) throw new Error("Invalid Gemini video frame rate.");
  if (!["HIGH", "MEDIUM", "LOW"].includes(resolution)) throw new Error("Invalid Gemini video resolution.");
  return { inlineData: { mimeType: "video/mp4", data }, videoMetadata: { fps },
    mediaResolution: { level: `MEDIA_RESOLUTION_${resolution}` } };
}
