import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, extname, join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { GoogleAuth } from "google-auth-library";
import { createCheckpointArchive, restoreCheckpointArchive } from "./checkpoint-store.mjs";
import { mergeCloudJobStatus } from "./job-status-policy.mjs";
import { downloadAuthorizedYouTubeSource } from "../../local-processor/source-import.mjs";

const projectRoot = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1)));
const jobId = required("JOB_ID");
const bucket = required("STORAGE_BUCKET");
const sourceObject = required("SOURCE_OBJECT");
const importUrl = String(process.env.IMPORT_URL || "").trim();
const sourceName = process.env.SOURCE_NAME || `source${extname(sourceObject) || ".mp4"}`;
const contentType = process.env.SOURCE_CONTENT_TYPE || "video/mp4";
const editSettings = process.env.EDIT_SETTINGS || "";
const dataRoot = resolve(process.env.WORKER_DATA_DIR || "/tmp/touchline-data");
const port = Number(process.env.LOCAL_PROCESSOR_PORT || 8787);
const localSource = join(dataRoot, "incoming", jobId, `source${extname(sourceObject) || ".mp4"}`);
const statusObject = `jobs/${jobId}.json`;
const outputObject = `outputs/${jobId}/final.mp4`;
const resumeMode = process.env.RESUME_MODE === "checkpoint"
  || Number(process.env.CLOUD_RUN_TASK_ATTEMPT || 0) > 0;
const workerStartedAt = Date.now();
const workerSliceMs = Math.max(60, Number(process.env.WORKER_SLICE_SECONDS || 6000)) * 1000;
const checkpointIntervalMs = Math.max(30, Number(process.env.WORKER_CHECKPOINT_SECONDS || 120)) * 1000;
const checkpointWorkDir = join(dataRoot, "checkpoint-work", jobId);
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const client = await auth.getClient();
const maximumRecoveries = Math.max(1, Math.min(12, Number(process.env.WORKER_RECOVERY_ATTEMPTS || 6)));

let processor;
let cloudStatus = {};
let restoredCheckpoint = null;
let statusWriteTail = Promise.resolve();
let lastStatusWriteAt = 0;
try {
  cloudStatus = await readStatus();
  await mkdir(dirname(localSource), { recursive: true });
  if (importUrl) {
    await importSourceToCloud();
    process.exitCode = 0;
  } else {
  const savedProgress = resumeMode ? Number(cloudStatus.checkpointProgress || cloudStatus.progress || 2) : 2;
  await writeStatus({ id: jobId, stage: "downloading", progress: savedProgress, progressDetail: "Downloading the existing source from private Cloud Storage—not uploading it again from your device." });
  await downloadObject(sourceObject, localSource);
  if (resumeMode && cloudStatus.checkpointObject) {
    const checkpointPath = join(checkpointWorkDir, "restore.tar");
    await mkdir(checkpointWorkDir, { recursive: true });
    await writeStatus({
      id: jobId,
      stage: "restoring",
      progress: savedProgress,
      progressDetail: `Restoring the durable processing checkpoint from ${Number(cloudStatus.checkpointProgress || savedProgress).toFixed(0)}%.`,
    });
    await downloadObject(cloudStatus.checkpointObject, checkpointPath);
    restoredCheckpoint = await restoreCheckpointArchive({ dataRoot, jobId, archivePath: checkpointPath });
    await restoreLocalSource();
    await rm(checkpointPath, { force: true });
    await writeStatus({
      id: jobId,
      stage: "restoring",
      progress: Number(restoredCheckpoint.progress || savedProgress),
      progressDetail: `Saved ${restoredCheckpoint.stage || "processing"} work restored. Continuing without repeating completed analysis and tracking.`,
      restoredCheckpointAt: new Date().toISOString(),
    });
  } else if (resumeMode) {
    await writeStatus({
      id: jobId,
      stage: "downloading",
      progress: savedProgress,
      progressDetail: "This legacy job predates durable processing checkpoints. Its cloud source is reusable, but its earlier analysis cannot be restored.",
    });
  }
  processor = spawn(process.execPath, [join(projectRoot, "local-processor", "server.mjs")], {
    cwd: projectRoot,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      LOCAL_DATA_DIR: dataRoot,
      LOCAL_PROCESSOR_PORT: String(port),
      PUBLIC_BASE_URL: process.env.PUBLIC_PROCESSOR_URL || "",
      ALLOW_EXTERNAL_JOB_ID: "true",
      TRACKING_PYTHON: process.env.TRACKING_PYTHON || "/opt/venv/bin/python",
    },
  });
  await waitForHealth();
  if (restoredCheckpoint) {
    const retryKind = Number(restoredCheckpoint.progress || savedProgress) >= 84 ? "retry-render" : "retry-analysis";
    const retryResponse = await fetch(`http://127.0.0.1:${port}/jobs/${jobId}/${retryKind}`, { method: "POST" });
    if (!retryResponse.ok && retryResponse.status!==409) throw new Error(`The restored checkpoint could not resume (${retryResponse.status}): ${await retryResponse.text()}`);
  } else {
    const uploadResponse = await fetch(`http://127.0.0.1:${port}/jobs`, {
      method: "POST",
      body: createReadStream(localSource),
      duplex: "half",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String((await stat(localSource)).size),
        "X-File-Name": encodeURIComponent(sourceName),
        "X-Edit-Settings": editSettings,
        "X-Job-ID": jobId,
      },
    });
    if (!uploadResponse.ok) {
      const failure=new Error(`Local worker rejected the source (${uploadResponse.status}): ${await uploadResponse.text()}`);
      if(uploadResponse.status===422)failure.code='SOURCE_VALIDATION';
      throw failure;
    }
  }
  const result = await monitorLocalJob();
  if(result.stage==='attention_required') {
    await persistCheckpoint(result);
    await writeStatus(result);
  } else {
  if (result.stage !== "completed") {
    const failure=new Error(result.error?.message || "The editing worker stopped before completion.");
    failure.code=result.error?.code;
    throw failure;
  }
  const finalPath = join(dataRoot, "outputs", jobId, "final.mp4");
  await uploadObject(outputObject, finalPath, "video/mp4");
  await writeStatus({ ...result, outputKey: undefined, outputUrl: `/outputs/${jobId}/final.mp4`, cloudOutputObject: outputObject });
  }
  }
} catch (error) {
  if (error.code !== "WORKER_CHECKPOINT_RESTART") {
    const message = error instanceof Error ? error.message : String(error);
    const retryAvailable = error.code!=='SOURCE_VALIDATION' && !!cloudStatus.checkpointObject
      && Number(process.env.CLOUD_RUN_TASK_ATTEMPT || 0) < Number(process.env.WORKER_TASK_RETRIES || 10);
    await writeStatus({ id: jobId, stage: retryAvailable ? "queued" : "failed",
      progress: Number(cloudStatus.progress || 0),
      progressDetail: retryAvailable ? "Saved progress is ready. Cloud Run is automatically restarting this worker." : message,
      lastWorkerError: message,
      error: retryAvailable ? undefined : { message, code:error.code, retryable:error.code!=='SOURCE_VALIDATION' } }).catch(() => {});
  }
  // Input rejection is a final source result, not a request to repeat the same
  // invalid upload on every Cloud Run retry attempt.
  if(error.code!=='SOURCE_VALIDATION')throw error;
} finally {
  processor?.kill("SIGTERM");
}

async function importSourceToCloud() {
  let lastSavedPercent = -10;
  let lastProgressQueuedAt = Date.now();
  let progressWrite = Promise.resolve();
  await writeStatus({
    id: jobId, stage: "importing", progress: 1, sourceKind: "youtube", readyToAnalyze: false,
    progressDetail: "Connecting to YouTube and preparing the authorized source download.",
  });
  const imported = await downloadAuthorizedYouTubeSource({
    url: importUrl,
    destinationDirectory: dirname(localSource),
    ytDlpPath: process.env.YTDLP_PATH || "/opt/venv/bin/yt-dlp",
    ffmpegPath: process.env.FFMPEG_PATH || "/usr/bin/ffmpeg",
    onProgress: percent => saveImportProgress(percent),
  });
  function saveImportProgress(percent) {
      const rounded = Math.floor(percent / 5) * 5;
      if (rounded <= lastSavedPercent) return;
      if (Date.now() - lastProgressQueuedAt < 1500) return;
      lastSavedPercent = rounded;
      lastProgressQueuedAt = Date.now();
      progressWrite = progressWrite.then(() => writeStatus({
        id: jobId, stage: "importing", progress: Math.max(1, Math.min(99, rounded)),
        sourceKind: "youtube", readyToAnalyze: false,
        progressDetail: `Downloading the authorized video source: ${Math.round(percent)}%. You can close this browser.`,
      })).catch(error => console.error("Import progress save failed", error));
  }
  await progressWrite;
  await uploadObject(sourceObject, imported.sourcePath, imported.sourceContentType);
  await writeStatus({
    id: jobId,
    stage: "uploaded",
    progress: 5,
    progressDetail: "Download complete and verified. Select this source, choose edit settings, then click Analyze & edit.",
    sourceKind: "youtube",
    readyToAnalyze: true,
    sourceName: imported.sourceName,
    sourceSize: imported.sourceSize,
    sourceContentType: imported.sourceContentType,
    sourceVideoId: imported.sourceVideoId,
    sourcePageUrl: imported.sourcePageUrl,
    sourceDuration: imported.sourceDuration,
    sourceThumbnailUrl: imported.sourceThumbnailUrl,
    importedAt: new Date().toISOString(),
    error: undefined,
  });
}

async function monitorLocalJob() {
  let lastSignature = "";
  let recoveryAttempts = 0;
  let checkpointStage = String(cloudStatus.checkpointStage || "");
  let checkpointProgress = Number(cloudStatus.checkpointProgress || 0);
  let checkpointAt = Date.now();
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${port}/jobs/${jobId}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not read worker status (${response.status}).`);
    const job = await response.json();
    // The local URL is not playable until the finished MP4 has reached Cloud Storage.
    if (job.stage === "completed") return job;
    if (job.stage === 'attention_required' || (job.stage==='failed' && job.error?.retryable===false)) return job;
    const signature = `${job.stage}:${job.progress}:${job.progressDetail || ""}`;
    if (signature !== lastSignature) {
      await writeStatus(job);
      lastSignature = signature;
    }
    if (shouldCheckpoint(job, checkpointStage, checkpointProgress)
      || Date.now() - checkpointAt >= checkpointIntervalMs) {
        try {
          const checkpoint = await persistCheckpoint(job);
          checkpointStage = checkpoint.stage;
          checkpointProgress = checkpoint.progress;
          checkpointAt = Date.now();
        } catch (error) {
          console.error("Durable checkpoint save failed", error);
          await writeStatus({
            ...job,
            checkpointWarning: error instanceof Error ? error.message : String(error),
            progressDetail: `${job.progressDetail || "Processing continues."} The previous durable recovery point remains available.`,
          });
        }
    }
    // End a slice with durable state before Cloud Run's hard deadline.
    // A nonzero exit asks Cloud Run to start its configured retry attempt;
    // CLOUD_RUN_TASK_ATTEMPT then restores the checkpoint above.
    if (Date.now() - workerStartedAt >= workerSliceMs) {
      processor?.kill("SIGTERM");
      await persistCheckpoint(job);
      await writeStatus({ ...job, error: undefined,
        progressDetail: "Saved processing work. Automatically continuing in a fresh cloud worker." });
      const restart = new Error("Restarting the worker from its durable checkpoint.");
      restart.code = "WORKER_CHECKPOINT_RESTART";
      throw restart;
    }
    if (job.stage === "failed") {
      if (recoveryAttempts >= maximumRecoveries) return job;
      const retryKind = Number(job.progress || 0) >= 84 ? "retry-render" : "retry-analysis";
      const retry = await fetch(`http://127.0.0.1:${port}/jobs/${jobId}/${retryKind}`, { method: "POST" });
      if (retry.status === 409) { await delay(2000); continue; }
      if (!retry.ok) throw new Error(`Saved-job recovery was rejected (${retry.status}): ${await retry.text()}`);
      recoveryAttempts += 1;
      const resumed = await retry.json();
      await writeStatus({ ...resumed, stage: resumed.stage === "failed" ? "queued" : resumed.stage, error: undefined,
        progressDetail: `Automatic saved-job recovery ${recoveryAttempts}/${maximumRecoveries}; reusing completed analysis and tracking evidence.` });
      lastSignature = "";
      await delay(2000);
      continue;
    }
    await delay(2000);
  }
}

async function persistCheckpoint(job) {
  const checkpointId = `${Date.now()}-${randomUUID()}`;
  const archivePath = join(checkpointWorkDir, `${checkpointId}.tar`);
  const checkpointObject = `checkpoints/${jobId}/${checkpointId}.tar`;
  await mkdir(checkpointWorkDir, { recursive: true });
  try {
    const manifest = await createCheckpointArchive({
      dataRoot,
      jobId,
      archivePath,
      stage: job.stage,
      progress: job.progress,
    });
    await uploadObject(checkpointObject, archivePath, "application/x-tar");
    await writeStatus({
      ...job,
      checkpointObject,
      checkpointStage: manifest.stage,
      checkpointProgress: manifest.progress,
      checkpointSavedAt: manifest.savedAt,
      checkpointWarning: undefined,
    });
    return manifest;
  } finally {
    await rm(archivePath, { force: true });
  }
}

function shouldCheckpoint(job, previousStage, previousProgress) {
  if (["completed"].includes(job.stage)) return false;
  if (job.stage === "failed") return true;
  return job.stage !== previousStage || Number(job.progress || 0) >= Number(previousProgress || 0) + 3;
}

async function restoreLocalSource() {
  const localJobPath = join(dataRoot, "jobs", `${jobId}.json`);
  const localJob = JSON.parse(await readFile(localJobPath, "utf8"));
  const uploadRoot = resolve(dataRoot, "uploads", jobId);
  const sourcePath = resolve(String(localJob.sourceKey || ""));
  if (!sourcePath || (sourcePath !== uploadRoot && !sourcePath.startsWith(`${uploadRoot}${sep}`))) {
    throw new Error("The saved checkpoint contains an unsafe or missing source path.");
  }
  await mkdir(dirname(sourcePath), { recursive: true });
  await copyFile(localSource, sourcePath);
}

async function waitForHealth() {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (processor?.exitCode !== null) throw new Error(`Local processor exited with code ${processor.exitCode}.`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch { /* Health endpoint is not ready yet; retry until the deadline. */ }
    await delay(1000);
  }
  throw new Error("Local processor did not become healthy within two minutes.");
}

async function downloadObject(objectName, destination) {
  const response = await authorizedFetch(mediaUrl(objectName));
  if (!response.ok || !response.body) throw new Error(`Could not download gs://${bucket}/${objectName} (${response.status}).`);
  await pipeWebStream(response.body, createWriteStream(destination));
}

async function uploadObject(objectName, path, type) {
  const info = await stat(path);
  const response = await authorizedFetch(uploadUrl(objectName), {
    method: "POST",
    body: createReadStream(path),
    duplex: "half",
    headers: { "Content-Type": type, "Content-Length": String(info.size) },
  });
  if (!response.ok) throw new Error(`Could not upload gs://${bucket}/${objectName} (${response.status}): ${await response.text()}`);
}

function writeStatus(job) {
  const pending = statusWriteTail.then(() => writeStatusSequentially(job));
  statusWriteTail = pending.catch(() => {});
  return pending;
}

async function writeStatusSequentially(job) {
  const clean = mergeCloudJobStatus(cloudStatus, job, {
    sourceName,
    sourceObject,
    sourceContentType: contentType,
    editSettings,
  });
  const body = Buffer.from(JSON.stringify(clean));
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const wait = lastStatusWriteAt + 1200 - Date.now();
    if (wait > 0) await delay(wait);
    const response = await authorizedFetch(uploadUrl(statusObject), { method: "POST", body, headers: { "Content-Type": "application/json", "Content-Length": String(body.length) } });
    if (response.ok) {
      lastStatusWriteAt = Date.now();
      cloudStatus = clean;
      return;
    }
    const detail = await response.text();
    if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === 6) {
      throw new Error(`Could not save cloud job status (${response.status}): ${detail}`);
    }
    await delay(Math.min(15_000, 1200 * 2 ** attempt) + Math.floor(Math.random() * 500));
  }
}

async function readStatus() {
  const response = await authorizedFetch(mediaUrl(statusObject));
  if (response.status === 404) return { id: jobId, createdAt: new Date().toISOString() };
  if (!response.ok) throw new Error(`Could not read initial cloud job status (${response.status}).`);
  return response.json();
}

async function authorizedFetch(url, options = {}) {
  const token = await client.getAccessToken();
  return fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token.token || token}` } });
}

function mediaUrl(objectName) {
  return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`;
}

function uploadUrl(objectName) {
  return `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
}

async function pipeWebStream(readable, writable) {
  for await (const chunk of readable) if (!writable.write(chunk)) await new Promise(resolveDrain => writable.once("drain", resolveDrain));
  await new Promise((resolveEnd, rejectEnd) => writable.end(error => error ? rejectEnd(error) : resolveEnd()));
}

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function delay(ms) { return new Promise(resolveDelay => setTimeout(resolveDelay, ms)); }
