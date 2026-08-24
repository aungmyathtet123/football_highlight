import type { RenderSegment } from "@/lib/video/render-plan";

export type FfmpegRenderInput = { sourcePath: string; outputPath: string; segments: RenderSegment[] };

/** Produces shell-safe FFmpeg arguments; the web tier never executes user input in a shell. */
export function buildFfmpegArgs(input: FfmpegRenderInput): string[] {
  if (input.segments.length === 0) throw new Error("Cannot render an empty timeline.");
  const filters: string[] = [];
  const concatInputs: string[] = [];
  input.segments.forEach((segment, index) => {
    const duration = Math.max(0.1, segment.sourceEnd - segment.sourceStart);
    const audioGain = Math.max(0, Math.min(1, segment.audioGain));
    const xExpression = `max(0,min(iw-ih*9/16,(iw-ih*9/16)*${segment.crop.focusX.toFixed(4)}))`;
    const maskFilters = segment.masks.map((mask) => {
      const x = Math.round(Math.max(0, Math.min(1, mask.x)) * 1080);
      const y = Math.round(Math.max(0, Math.min(1, mask.y)) * 1920);
      const width = Math.max(8, Math.round(Math.max(0, Math.min(1 - mask.x, mask.width)) * 1080));
      const height = Math.max(8, Math.round(Math.max(0, Math.min(1 - mask.y, mask.height)) * 1920));
      return `delogo=x=${x}:y=${y}:w=${width}:h=${height}:show=0`;
    });
    const masking = maskFilters.length > 0 ? `,${maskFilters.join(",")}` : "";
    filters.push(`[0:v]trim=start=${segment.sourceStart.toFixed(3)}:duration=${duration.toFixed(3)},setpts=PTS-STARTPTS,crop=ih*9/16:ih:${xExpression}:0,scale=1080:1920:flags=lanczos,setsar=1${masking}[v${index}]`);
    filters.push(`[0:a]atrim=start=${segment.sourceStart.toFixed(3)}:duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS,volume=${audioGain.toFixed(2)}[a${index}]`);
    concatInputs.push(`[v${index}][a${index}]`);
  });
  filters.push(`${concatInputs.join("")}concat=n=${input.segments.length}:v=1:a=1[outv][outa]`);
  return ["-hide_banner", "-y", "-i", input.sourcePath, "-filter_complex", filters.join(";"), "-map", "[outv]", "-map", "[outa]", "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", input.outputPath];
}
