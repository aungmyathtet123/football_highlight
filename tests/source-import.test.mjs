import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAuthorizedYouTubeUrl, parseYtDlpProgress } from "../local-processor/source-import.mjs";

test("authorized YouTube import accepts individual watch, short, live and youtu.be links", () => {
  assert.equal(normalizeAuthorizedYouTubeUrl("https://www.youtube.com/watch?v=cvaMuxrK_8I").videoId, "cvaMuxrK_8I");
  assert.equal(normalizeAuthorizedYouTubeUrl("https://youtube.com/shorts/R4i22aCRTVo").videoId, "R4i22aCRTVo");
  assert.equal(normalizeAuthorizedYouTubeUrl("https://youtu.be/cvaMuxrK_8I?t=12").videoId, "cvaMuxrK_8I");
  assert.equal(normalizeAuthorizedYouTubeUrl("https://www.youtube.com/live/cvaMuxrK_8I").videoId, "cvaMuxrK_8I");
});

test("authorized YouTube import rejects credentials, insecure URLs, playlists and deceptive hosts", () => {
  for (const value of [
    "http://youtube.com/watch?v=cvaMuxrK_8I",
    "https://user:pass@youtube.com/watch?v=cvaMuxrK_8I",
    "https://youtube.com.evil.example/watch?v=cvaMuxrK_8I",
    "https://www.youtube.com/playlist?list=PL123456",
    "https://127.0.0.1/source.mp4",
  ]) assert.throws(() => normalizeAuthorizedYouTubeUrl(value));
});

test("yt-dlp progress parser returns bounded numeric percentages", () => {
  assert.equal(parseYtDlpProgress("[download]  42.7% of 120.00MiB at 8.0MiB/s"), 42.7);
  assert.equal(parseYtDlpProgress("[download] 100.0% of 120.00MiB"), 100);
  assert.equal(parseYtDlpProgress("[Merger] Merging formats"), null);
});

test("cloud deployment keeps import and analysis as separate durable stages", async () => {
  const { readFile } = await import("node:fs/promises");
  const gateway = await readFile(new URL("../deploy/cloud-run/gateway.mjs", import.meta.url), "utf8");
  const worker = await readFile(new URL("../deploy/cloud-run/worker.mjs", import.meta.url), "utf8");
  const studio = await readFile(new URL("../app/video-studio.tsx", import.meta.url), "utf8");
  const dockerfile = await readFile(new URL("../deploy/cloud-run/Dockerfile.worker", import.meta.url), "utf8");
  assert.match(gateway, /\/imports\/youtube/);
  assert.match(gateway, /readyToAnalyze: false/);
  assert.match(worker, /stage: "uploaded"/);
  assert.match(worker, /readyToAnalyze: true/);
  assert.match(studio, /Analyze & edit downloaded video/);
  assert.match(studio, /\/sources\/\$\{job\.id\}/);
  assert.match(dockerfile, /yt-dlp/);
});
