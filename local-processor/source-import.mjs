import { access, readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { spawn } from "node:child_process";
import { normalizeAuthorizedYouTubeUrl } from "../deploy/cloud-run/source-import-policy.mjs";

export { normalizeAuthorizedYouTubeUrl } from "../deploy/cloud-run/source-import-policy.mjs";

export const MAX_IMPORTED_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;

export function parseYtDlpProgress(line) {
  const match = String(line || "").match(/\[download\]\s+([\d.]+)%/i);
  return match ? Math.max(0, Math.min(100, Number(match[1]))) : null;
}

export async function downloadAuthorizedYouTubeSource({ url, destinationDirectory, ytDlpPath = "yt-dlp", ffmpegPath = "", onProgress = () => {} }) {
  const normalized = normalizeAuthorizedYouTubeUrl(url);
  const outputTemplate = join(destinationDirectory, "source.%(ext)s");
  await runProcess(ytDlpPath, [
    "--no-playlist", "--newline", "--progress", "--write-info-json", "--no-write-playlist-metafiles",
    "--js-runtimes", "node",
    ...(ffmpegPath ? ["--ffmpeg-location", ffmpegPath] : []),
    "--format", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b[height<=1080]",
    "--merge-output-format", "mp4", "--remux-video", "mp4", "--output", outputTemplate, normalized.url,
  ], (line) => {
    const progress = parseYtDlpProgress(line);
    if (progress !== null) onProgress(progress);
  }).catch(error => {
    if (/not made this video available in your country|not available in your country|geo.?restricted/i.test(String(error))) {
      throw new Error("This YouTube video is unavailable from the cloud worker's region. Download it where you have access, then use Upload file.");
    }
    throw error;
  });
  const entries = await readdir(destinationDirectory);
  const sourceFile = entries.find(name => /^source\.mp4$/i.test(name));
  if (!sourceFile) throw new Error("The downloader could not create a playable MP4 source.");
  const sourcePath = join(destinationDirectory, sourceFile);
  const sourceInfo = await stat(sourcePath);
  if (sourceInfo.size <= 0) throw new Error("The downloaded video is empty.");
  if (sourceInfo.size > MAX_IMPORTED_SOURCE_BYTES) throw new Error("The downloaded video exceeds the 2 GB source limit.");
  const ffprobePath = ffmpegPath ? join(dirname(ffmpegPath), process.platform === "win32" ? "ffprobe.exe" : "ffprobe") : "ffprobe";
  const probeOutput = await runProcess(ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-show_entries", "stream=codec_type", "-of", "json", sourcePath]);
  const media = JSON.parse(probeOutput);
  if (!media.streams?.some(stream => stream.codec_type === "video") || !Number.isFinite(Number(media.format?.duration)) || Number(media.format.duration) <= 0) {
    throw new Error("The downloaded MP4 does not contain a playable video stream.");
  }
  const infoPath = join(destinationDirectory, "source.info.json");
  let info = {};
  try { await access(infoPath); info = JSON.parse(await readFile(infoPath, "utf8")); } catch { info = {}; }
  const title = safeImportedTitle(info.title || `YouTube ${normalized.videoId}`);
  return {
    sourcePath,
    sourceName: `${title}.mp4`,
    sourceSize: sourceInfo.size,
    sourceContentType: "video/mp4",
    sourceVideoId: normalized.videoId,
    sourcePageUrl: normalized.url,
    sourceDuration: Number(media.format.duration),
    sourceThumbnailUrl: /^https:\/\//i.test(String(info.thumbnail || "")) ? String(info.thumbnail) : "",
    originalExtension: extname(sourceFile).toLowerCase(),
  };
}

function safeImportedTitle(value) {
  return Array.from(String(value || "YouTube video"), character => character.charCodeAt(0) < 32 || /[\\/:*?"<>|]/.test(character) ? "_" : character).join("").replace(/\s+/g, " ").trim().slice(0, 160) || "YouTube video";
}

function runProcess(command, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    let pending = "";
    let stderr = "";
    let stdout = "";
    const consume = chunk => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) onLine?.(line);
    };
    child.stdout.on("data", chunk => { stdout = `${stdout}${chunk}`.slice(-1024 * 1024); consume(chunk); });
    child.stderr.on("data", chunk => { consume(chunk); stderr = `${stderr}${chunk}`.slice(-8000); });
    child.on("error", reject);
    child.on("close", code => {
      if (pending) onLine?.(pending);
      if (code === 0) return resolve(stdout);
      const detail = stderr.replace(/\s+/g, " ").trim().slice(-1200);
      reject(new Error(`YouTube download failed${detail ? `: ${detail}` : "."}`));
    });
  });
}
