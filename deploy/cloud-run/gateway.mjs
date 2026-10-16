import http from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { GoogleAuth } from "google-auth-library";
import { normalizeAuthorizedYouTubeUrl } from "./source-import-policy.mjs";
import { createCloudYouTubePublisher } from "./youtube-publisher.mjs";
import { proxyResponseHeaders } from "./proxy-response-headers.mjs";
import {buildWorkflowProgress} from '../../local-processor/workflow-progress.mjs';

const project = required("GOOGLE_CLOUD_PROJECT");
const region = process.env.CLOUD_RUN_REGION || "asia-southeast1";
const workerJob = process.env.CLOUD_RUN_WORKER_JOB || "touchline-worker";
const bucket = required("STORAGE_BUCKET");
const port = Number(process.env.PORT || 8080);
const serveWeb = /^(1|true|yes)$/i.test(String(process.env.SERVE_WEB || ""));
const webPort = Number(process.env.WEB_PORT || 3000);
const accessPassword = String(process.env.APP_ACCESS_PASSWORD || "");
const sessionSecret = String(process.env.APP_SESSION_SECRET || "");
const youtubePublisher = createCloudYouTubePublisher({
  clientJson: process.env.YOUTUBE_OAUTH_CLIENT_JSON || "",
  redirectUri: process.env.YOUTUBE_OAUTH_REDIRECT_URI || "",
  signingSecret: sessionSecret || accessPassword,
  readJsonObject: name => readJsonObject(name),
  writeJsonObject: (name, value, generation) => writeJsonObject(name, value, generation),
  authorizedFetch: (url, options) => authorizedFetch(url, options),
  mediaUrl: name => mediaUrl(name),
});
const allowedOrigins = new Set(String(process.env.ALLOWED_ORIGINS || "http://localhost:3001,http://127.0.0.1:3001").split(",").map(value => value.trim()).filter(Boolean));
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const client = await auth.getClient();
const webProcess = serveWeb ? spawn(process.execPath, ["node_modules/vinext/dist/cli.js", "start"], {
  cwd: process.cwd(), stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, PORT: String(webPort) },
}) : null;
webProcess?.on("error", error => console.error("Touchline web process could not start.", error));
webProcess?.on("exit", code => console.error(`Touchline web process exited with code ${code}.`));

http.createServer(async (request, response) => {
  try {
    setCors(request, response);
    if (request.method === "OPTIONS") return send(response, 204);
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/login" && request.method === "GET") return loginPage(response);
    if (url.pathname === "/login" && request.method === "POST") return login(request, response);
    if (accessPassword && !authenticated(request)) {
      if (isApiPath(url.pathname)) return json(response, 401, { error: "Sign in to the private Touchline workspace first." });
      response.writeHead(302, { Location: "/login", "Cache-Control": "no-store" }); return response.end();
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, { ok: true, mode: "cloud_run_job", uploadMode: "resumable", region, workerJob });
    }
    if (request.method === "GET" && url.pathname === "/youtube/channels") return json(response, 200, await youtubePublisher.status());
    if (request.method === "GET" && url.pathname === "/youtube/oauth/start") {
      const location = youtubePublisher.authorizationUrl(request);
      response.writeHead(302, { Location: location, "Cache-Control": "no-store" }); return response.end();
    }
    if (request.method === "GET" && url.pathname === "/youtube/oauth/callback") {
      try {
        const channel = await youtubePublisher.completeAuthorization(url.searchParams);
        return youtubeCallbackHtml(response, { channel });
      } catch (error) {
        return youtubeCallbackHtml(response, { error: error instanceof Error ? error.message : "YouTube authorization failed." });
      }
    }
    if (request.method === "POST" && url.pathname === "/youtube/uploads") {
      const body = await readJson(request, 64 * 1024);
      const jobId = String(body.jobId || "");
      if (!/^[a-f0-9-]{36}$/i.test(jobId)) return json(response, 400, { error: "A completed video job is required." });
      const job = await readJsonObject(`jobs/${jobId}.json`);
      if (job?.stage !== "completed" || !job.cloudOutputObject) return json(response, 409, { error: "Finish uploading the rendered video to cloud storage first." });
      return json(response, 200, await youtubePublisher.upload({ jobId, channelId: String(body.channelId || ""), outputObject: job.cloudOutputObject, title: String(body.title || job.editPlan?.title || "Touchline AI football recap"), description: String(body.description || "") }));
    }
    if (request.method === "GET" && url.pathname === "/jobs") return listJobs(response);
    if (request.method === "POST" && url.pathname === "/uploads/resumable") return createUpload(request, response);
    if (request.method === "POST" && url.pathname === "/imports/youtube") return createYouTubeImport(request, response);
    const retryImportMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]{36})\/retry-import$/i);
    if (request.method === "POST" && retryImportMatch) return retryYouTubeImport(response, retryImportMatch[1]);
    const uploadSessionMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]{36})\/upload-session$/i);
    if (request.method === "POST" && uploadSessionMatch) return resumeUploadSession(request, response, uploadSessionMatch[1]);
    const uploadProgressMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]{36})\/upload-progress$/i);
    if (request.method === "POST" && uploadProgressMatch) return saveUploadProgress(request, response, uploadProgressMatch[1]);
    const startMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]{36})\/start$/i);
    if (request.method === "POST" && startMatch) return startJob(request, response, startMatch[1], false);
    const retryMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]{36})\/(retry-analysis|retry-render)$/i);
    if (request.method === "POST" && retryMatch) return startJob(request, response, retryMatch[1], true, false, retryMatch[2]);
    const reselectMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]{36})\/reselect-blocked$/i);
    if (request.method === "POST" && reselectMatch) return startJob(request, response, reselectMatch[1], true, true);
    const jobMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]{36})$/i);
    if (request.method === "GET" && jobMatch) return getJob(response, jobMatch[1]);
    if (request.method === "DELETE" && jobMatch) return deleteJob(response, jobMatch[1]);
    const publishedMatch = url.pathname.match(/^\/jobs\/([a-f0-9-]{36})\/published$/i);
    if (request.method === "POST" && publishedMatch) return markPublished(request, response, publishedMatch[1]);
    const outputMatch = url.pathname.match(/^\/outputs\/([a-f0-9-]{36})\/final\.mp4$/i);
    if (request.method === "GET" && outputMatch) return streamOutput(request, response, outputMatch[1]);
    const sourceMatch = url.pathname.match(/^\/sources\/([a-f0-9-]{36})$/i);
    if (request.method === "GET" && sourceMatch) return streamSource(request, response, sourceMatch[1]);
    if (serveWeb) return proxyWeb(request, response);
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return json(response, 500, { error: error instanceof Error ? error.message : "Unexpected cloud gateway error" });
  }
}).listen(port, "0.0.0.0", () => console.log(`Touchline cloud gateway listening on ${port}`));

async function login(request, response) {
  const body = await readBody(request, 8192);
  const password = new URLSearchParams(body).get("password") || "";
  if (!safeEqual(password, accessPassword)) return loginPage(response, "That password is incorrect.", 401);
  response.writeHead(302, {
    Location: "/",
    "Set-Cookie": `touchline_session=${sessionValue()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
    "Cache-Control": "no-store",
  });
  response.end();
}

function loginPage(response, error = "", status = 200) {
  const message = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Touchline AI sign in</title><style>body{margin:0;background:#080b10;color:#f5f7fa;font-family:Inter,system-ui;display:grid;place-items:center;min-height:100vh}.card{width:min(88vw,390px);background:#111722;border:1px solid #263044;border-radius:22px;padding:34px;box-shadow:0 24px 80px #0008}h1{margin:0 0 8px;font-size:28px}p{color:#9ca9ba;line-height:1.5}.error{color:#ff8585}input,button{box-sizing:border-box;width:100%;border-radius:12px;padding:14px;font:inherit}input{margin:18px 0 12px;background:#090d14;color:white;border:1px solid #354056}button{border:0;background:#c9ff35;color:#10150a;font-weight:800;cursor:pointer}.mark{color:#c9ff35;font-weight:900;letter-spacing:.08em}</style></head><body><form class="card" method="post" action="/login"><div class="mark">TOUCHLINE AI</div><h1>Creator workspace</h1><p>This private editor runs on your Google Cloud project.</p>${message}<input type="password" name="password" autocomplete="current-password" autofocus required placeholder="Workspace password"><button type="submit">Sign in</button></form></body></html>`);
}

async function proxyWeb(request, response) {
  const headers = { ...request.headers };
  delete headers.host;
  const hasBody = !["GET", "HEAD"].includes(request.method || "GET");
  let upstream;
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      upstream = await fetch(`http://127.0.0.1:${webPort}${request.url || "/"}`, {
        method: request.method, headers, ...(hasBody ? { body: request, duplex: "half" } : {}), redirect: "manual",
      });
      break;
    } catch (error) {
      lastError = error;
      if (attempt === 29) break;
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
    }
  }
  if (!upstream) throw lastError || new Error("The web application did not become ready.");
  const responseHeaders = proxyResponseHeaders(upstream.headers);
  response.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) return response.end();
  for await (const chunk of upstream.body) if (!response.write(chunk)) await new Promise(resolveDrain => response.once("drain", resolveDrain));
  response.end();
}

function authenticated(request) {
  if (!accessPassword) return true;
  const cookies = Object.fromEntries(String(request.headers.cookie || "").split(";").map(item => item.trim().split(/=(.*)/s).slice(0, 2)).filter(parts => parts[0]));
  return safeEqual(cookies.touchline_session || "", sessionValue());
}

function sessionValue() { return createHmac("sha256", sessionSecret || accessPassword).update("touchline-session-v1").digest("base64url"); }
function safeEqual(left, right) { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && timingSafeEqual(a, b); }
function isApiPath(path) { return /^\/(?:health|uploads|imports|jobs|sources|outputs|youtube)(?:\/|$)/.test(path); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function youtubeCallbackHtml(response, { channel, error }) { const payload = JSON.stringify({ type: "touchline-youtube-connected", channel: channel || null, error: error || null }).replace(/</g, "\\u003c"); const message = error || `${channel?.title || "YouTube channel"} is ready for private uploads.`; response.writeHead(error ? 400 : 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(`<!doctype html><html><head><meta charset="utf-8"><title>YouTube connection</title></head><body><h1>YouTube connection</h1><p>${escapeHtml(message)}</p><p>You can close this window.</p><script>if(window.opener){window.opener.postMessage(${payload},window.location.origin);window.close();}</script></body></html>`); }

async function createUpload(request, response) {
  const body = await readJson(request, 64 * 1024);
  const sourceName = safeFileName(body.fileName || "source.mp4");
  const contentType = String(body.contentType || "video/mp4");
  if (!contentType.startsWith("video/")) return json(response, 415, { error: "Upload must be a video file." });
  const size = Number(body.size || 0);
  if (!Number.isFinite(size) || size <= 0 || size > 2 * 1024 * 1024 * 1024) return json(response, 413, { error: "Video must be between 1 byte and 2 GB." });
  const id = randomUUID();
  const extension = [".mp4", ".mov", ".webm", ".mkv"].find(value => sourceName.toLowerCase().endsWith(value)) || ".mp4";
  const sourceObject = `uploads/${id}/source${extension}`;
  const origin = String(request.headers.origin || "");
  const uploadUrl = await createResumableSession({ sourceObject, contentType, size, origin });
  const status = {
    id, stage: "uploading", progress: 1, progressDetail: "Upload ready. Keep this page open, or select the same file later to continue.",
    sourceName, sourceObject, sourceContentType: contentType, sourceSize: size,
    uploadSessionUrl: uploadUrl, uploadedBytes: 0,
    editSettings: String(body.editSettings || ""), moments: [], warnings: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await writeJsonObject(`jobs/${id}.json`, status);
  return json(response, 201, { ...publicJob(status), uploadUrl });
}

async function createYouTubeImport(request, response) {
  const body = await readJson(request, 32 * 1024);
  if (body.rightsConfirmed !== true) return json(response, 400, { error: "Confirm that you own or are authorized to use this video." });
  const normalized = normalizeAuthorizedYouTubeUrl(body.url);
  const id = randomUUID();
  const sourceObject = `uploads/${id}/source.mp4`;
  const now = new Date().toISOString();
  const status = {
    id, stage: "importing", progress: 1,
    progressDetail: "YouTube import queued. The cloud download continues if you close this browser.",
    sourceKind: "youtube", sourceName: `YouTube ${normalized.videoId}.mp4`, sourceObject,
    sourceContentType: "video/mp4", sourceSize: 0, sourceVideoId: normalized.videoId,
    sourcePageUrl: normalized.url, importUrl: normalized.url, readyToAnalyze: false,
    editSettings: String(body.editSettings || ""), moments: [], warnings: [], createdAt: now, updatedAt: now,
  };
  await writeJsonObject(`jobs/${id}.json`, status);
  try {
    const operation = await launchWorker([
      ["JOB_ID", id], ["STORAGE_BUCKET", bucket], ["SOURCE_OBJECT", sourceObject],
      ["SOURCE_NAME", status.sourceName], ["SOURCE_CONTENT_TYPE", "video/mp4"],
      ["EDIT_SETTINGS", status.editSettings], ["RESUME_MODE", "fresh"], ["IMPORT_URL", normalized.url],
    ]);
    const current = (await readJsonObject(`jobs/${id}.json`)) || status;
    const next = { ...current, cloudOperation: operation.name, updatedAt: new Date().toISOString() };
    await writeJsonObject(`jobs/${id}.json`, next, current.__generation);
    return json(response, 202, publicJob(next));
  } catch (error) {
    const failed = { ...status, stage: "failed", error: { code: "IMPORT_START_FAILED", message: error instanceof Error ? error.message : String(error), retryable: true }, updatedAt: new Date().toISOString() };
    await writeJsonObject(`jobs/${id}.json`, failed);
    return json(response, 503, publicJob(failed));
  }
}

async function retryYouTubeImport(response, id) {
  const status = await readJsonObject(`jobs/${id}.json`);
  if (!status) return json(response, 404, { error: "Import job not found." });
  if (status.sourceKind !== "youtube" || !status.importUrl || status.importedAt) return json(response, 409, { error: "This job is not a retryable YouTube import." });
  if (status.stage !== "failed") return json(response, 409, { error: "Only a failed import can be retried." });
  const queued = { ...status, stage: "importing", progress: 1, readyToAnalyze: false, progressDetail: "Retrying the saved video import in a new cloud worker.", updatedAt: new Date().toISOString() };
  delete queued.error;
  const saved = await writeJsonObject(`jobs/${id}.json`, queued, status.__generation);
  if (!saved) return json(response, 409, { error: "The import changed while it was being retried. Refresh and try again." });
  try {
    const operation = await launchWorker([
      ["JOB_ID", id], ["STORAGE_BUCKET", bucket], ["SOURCE_OBJECT", status.sourceObject || `uploads/${id}/source.mp4`],
      ["SOURCE_NAME", status.sourceName], ["SOURCE_CONTENT_TYPE", "video/mp4"],
      ["EDIT_SETTINGS", status.editSettings || ""], ["RESUME_MODE", "fresh"], ["IMPORT_URL", status.importUrl],
    ]);
    const current = (await readJsonObject(`jobs/${id}.json`)) || queued;
    const next = { ...current, cloudOperation: operation.name };
    await writeJsonObject(`jobs/${id}.json`, next, current.__generation);
    return json(response, 202, publicJob(next));
  } catch (error) {
    const failed = { ...queued, stage: "failed", error: { code: "IMPORT_START_FAILED", message: error instanceof Error ? error.message : String(error), retryable: true }, updatedAt: new Date().toISOString() };
    await writeJsonObject(`jobs/${id}.json`, failed);
    return json(response, 503, publicJob(failed));
  }
}

async function resumeUploadSession(request, response, id) {
  const status = await readJsonObject(`jobs/${id}.json`);
  if (!status) return json(response, 404, { error: "Upload job not found." });
  if (!["uploaded", "uploading"].includes(status.stage)) return json(response, 409, { error: "This job is no longer waiting for an upload." });
  const body = await readJson(request, 32 * 1024);
  const fileName = safeFileName(body.fileName || "");
  const size = Number(body.size || 0);
  if (fileName !== status.sourceName || size !== Number(status.sourceSize || 0)) return json(response, 409, { error: "Select the same video file used for this upload." });
  let uploadUrl = String(status.uploadSessionUrl || "");
  if (!uploadUrl || body.reset === true) {
    uploadUrl = await createResumableSession({
      sourceObject: status.sourceObject,
      contentType: status.sourceContentType || "video/mp4",
      size,
      origin: String(request.headers.origin || ""),
    });
    const next = { ...status, stage: "uploading", uploadSessionUrl: uploadUrl, uploadedBytes: 0, progress: 1, progressDetail: "A new resumable upload session is ready.", updatedAt: new Date().toISOString() };
    const saved = await writeJsonObject(`jobs/${id}.json`, next, status.__generation);
    if (!saved) return json(response, 409, { error: "The upload changed while it was being resumed. Refresh and try again." });
  }
  return json(response, 200, { id, uploadUrl, uploadedBytes: Number(status.uploadedBytes || 0), sourceSize: Number(status.sourceSize || size) });
}

async function saveUploadProgress(request, response, id) {
  const status = await readJsonObject(`jobs/${id}.json`);
  if (!status) return json(response, 404, { error: "Upload job not found." });
  if (!["uploaded", "uploading"].includes(status.stage)) return json(response, 409, { error: "This job is no longer uploading." });
  const body = await readJson(request, 32 * 1024);
  const size = Number(status.sourceSize || 0);
  const uploadedBytes = Math.max(Number(status.uploadedBytes || 0), Math.min(size, Number(body.uploadedBytes || 0)));
  const complete = size > 0 && uploadedBytes >= size;
  const percent = size > 0 ? Math.round(uploadedBytes / size * 100) : 0;
  const next = {
    ...status,
    stage: complete ? "uploaded" : "uploading",
    uploadedBytes,
    progress: complete ? 5 : Math.max(1, Math.min(4, Math.floor(percent / 25) + 1)),
    progressDetail: complete ? "Upload complete. Starting the cloud editing worker." : `Uploaded ${percent}% of the source. Select the same file to continue if you leave this page.`,
    updatedAt: new Date().toISOString(),
  };
  const saved = await writeJsonObject(`jobs/${id}.json`, next, status.__generation);
  if (!saved) return json(response, 409, { error: "Upload progress changed. Query the saved upload offset and continue." });
  return json(response, 200, publicJob(next));
}

async function createResumableSession({ sourceObject, contentType, size, origin }) {
  const session = await authorizedFetch(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=resumable&name=${encodeURIComponent(sourceObject)}`, {
    method: "POST",
    body: "",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": contentType,
      "X-Upload-Content-Length": String(size),
      ...(origin ? { Origin: origin } : {}),
    },
  });
  if (!session.ok) throw new Error(`Cloud Storage could not create the upload session (${session.status}): ${await session.text()}`);
  const uploadUrl = session.headers.get("location");
  if (!uploadUrl) throw new Error("Cloud Storage did not return an upload URL.");
  return uploadUrl;
}

async function startJob(request, response, id, retry, reselectBlocked=false, retryAction='') {
  let status = await readJsonObject(`jobs/${id}.json`);
  if (!status) return json(response, 404, { error: "Job not found" });
  if (!retry && status.stage !== "uploaded") return json(response, 409, { error: status.stage === "uploading" ? "Finish uploading the source before starting this job." : "This job has already been started." });
  if (retry && !['failed','attention_required'].includes(status.stage)
    && !(status.stage === 'completed' && retryAction === 'retry-analysis'))
    return json(response, 409, { error: "This job is already running or waiting for its automatic retry." });
  if (reselectBlocked && (status.stage !== 'attention_required' || !status.checkpointObject))
    return json(response, 409, {error:'Source action repair requires a saved scene checkpoint needing attention.'});
  if (reselectBlocked && !await objectExists(status.checkpointObject))
    return json(response, 409, {error:'The saved processing checkpoint has expired. Restore the source and checkpoint before repairing this job.'});
  if (!retry) {
    const body = await readJson(request, 64 * 1024).catch(() => ({}));
    if (body.editSettings) status = { ...status, editSettings: String(body.editSettings) };
  }
  const sourceObject = await resolveSourceObject(status, id);
  if (!sourceObject || !await objectExists(sourceObject)) {
    const waiting = { ...status, stage: "uploading", progress: 1, progressDetail: "The source upload is incomplete. Select the same video file to continue.", updatedAt: new Date().toISOString() };
    await writeJsonObject(`jobs/${id}.json`, waiting, status.__generation);
    return json(response, 409, { error: "The source upload has not finished. Select the same video file to continue." });
  }
  status = { ...status, sourceObject };
  const currentRepairFeedback=Object.fromEntries(Object.entries(status.sceneTrackingStates||{})
    .filter(([,state])=>state?.status==='needs_repair')
    .map(([sceneId,state])=>[sceneId,String(state.detail||'independent crop review failed')]));
  const repairFeedback={...(status.sourceRepairFeedback||{}),...currentRepairFeedback};
  const resumeProgress = Number(status.checkpointProgress || status.progress || 1);
  const queued = {
    ...status,
    ...(reselectBlocked?{sourceRepairFeedback:repairFeedback}:{}),
    stage: "queued",
    progress: retry ? resumeProgress : 5,
    progressDetail: retry
      ? status.checkpointObject
        ? `Resume accepted. Waiting for a cloud worker to restore the saved ${resumeProgress.toFixed(0)}% checkpoint.`
        : "Retry accepted. This legacy job has no durable processing checkpoint, so only its cloud source can be reused."
      : "Upload complete. Waiting for an editing worker.",
    updatedAt: new Date().toISOString(),
  };
  delete queued.error;
  delete queued.uploadSessionUrl;
  const claimed = await writeJsonObject(`jobs/${id}.json`, queued, status.__generation);
  if (!claimed) return json(response, 409, { error: "Another request already started this job." });
  let operation;
  try {
    operation = await launchWorker([
      ["JOB_ID", id], ["STORAGE_BUCKET", bucket], ["SOURCE_OBJECT", sourceObject],
      ["SOURCE_NAME", status.sourceName], ["SOURCE_CONTENT_TYPE", status.sourceContentType || "video/mp4"],
      ["EDIT_SETTINGS", status.editSettings || ""], ["RESUME_MODE", retry ? "checkpoint" : "fresh"],
      ["RESUME_ACTION", retryAction],
      ["SOURCE_RESELECTION_REQUESTED", reselectBlocked ? "true" : "false"],
      ["SOURCE_RESELECTION_FEEDBACK", reselectBlocked ? JSON.stringify(repairFeedback):""],
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeJsonObject(`jobs/${id}.json`, { ...queued, stage: "failed", error: { message }, updatedAt: new Date().toISOString() });
    throw new Error(message);
  }
  const next = { ...queued, cloudOperation: operation.name };
  await writeJsonObject(`jobs/${id}.json`, next);
  return json(response, 202, publicJob(next));
}

async function getJob(response, id) {
  const loaded = await readJsonObject(`jobs/${id}.json`);
  const job = loaded ? await reconcileCloudOperation(loaded) : null;
  return job ? json(response, 200, publicJob(withRetention(job))) : json(response, 404, { error: "Job not found" });
}

async function listJobs(response) {
  const statusObjects = await listObjects("jobs/");
  const loaded = await Promise.all(statusObjects
    .filter(object => /^jobs\/[a-f0-9-]{36}\.json$/i.test(object.name))
    .map(object => readJsonObject(object.name).catch(() => null)));
  const jobs = await Promise.all(loaded.filter(Boolean).map(job => reconcileCloudOperation(job)));
  await Promise.all(jobs.map(job => applyRetention(job)));
  const refreshed = jobs.filter(job => !job.__expired).map(job => publicJob(withRetention(job)));
  refreshed.sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
  const allObjects = await listObjects("");
  const storageBytes = allObjects.reduce((sum, object) => sum + Number(object.size || 0), 0);
  return json(response, 200, { jobs: refreshed, storageBytes, jobCount: refreshed.length, retention: { failedDays: 14, unpublishedDays: 14, publishedSourceHours: 24, publishedOutputDays: 7 } });
}

async function deleteJob(response, id) {
  const job = await readJsonObject(`jobs/${id}.json`);
  if (!job) return json(response, 404, { error: "Job not found" });
  if (!["completed", "failed", "attention_required"].includes(job.stage) && !(job.stage === "uploaded" && job.readyToAnalyze)) return json(response, 409, { error: "A working job cannot be deleted. Wait for it to finish or need attention first." });
  await deleteJobObjects(job, true);
  return send(response, 204);
}

async function markPublished(request, response, id) {
  const job = await readJsonObject(`jobs/${id}.json`);
  if (!job) return json(response, 404, { error: "Job not found" });
  if (job.stage !== "completed") return json(response, 409, { error: "Only a completed video can be marked as published." });
  const body = await readJson(request, 32 * 1024);
  const next = {
    ...job,
    publishedAt: job.publishedAt || new Date().toISOString(),
    youtubeUrl: String(body.url || job.youtubeUrl || "").slice(0, 500),
    youtubeVideoId: String(body.videoId || job.youtubeVideoId || "").slice(0, 100),
    youtubeChannelId: String(body.channelId || job.youtubeChannelId || "").slice(0, 100),
    updatedAt: new Date().toISOString(),
  };
  const saved = await writeJsonObject(`jobs/${id}.json`, next, job.__generation);
  if (!saved) return json(response, 409, { error: "The job changed while publication was being saved. Refresh and try again." });
  const publishedCustomTime = next.publishedAt;
  await Promise.all([
    setObjectCustomTime(job.sourceObject || `uploads/${id}/source.mp4`, publishedCustomTime),
    setObjectCustomTime(job.cloudOutputObject || `outputs/${id}/final.mp4`, publishedCustomTime),
  ]);
  return json(response, 200, publicJob(withRetention(next)));
}

async function applyRetention(job) {
  const now = Date.now();
  if (job.stage === "failed" && now >= retentionDate(job, "failed-delete")) {
    await deleteJobObjects(job, true);
    Object.defineProperty(job, "__expired", { value: true, enumerable: false, configurable: true });
    return;
  }
  if (job.stage !== "completed") return;
  const sourceDue = retentionDate(job, "source-delete");
  const outputDue = retentionDate(job, "output-delete");
  let changed = false;
  if (!job.sourceDeletedAt && now >= sourceDue) {
    await deletePrefix(`uploads/${job.id}/`);
    job.sourceDeletedAt = new Date().toISOString();
    changed = true;
  }
  if (!job.outputDeletedAt && now >= outputDue) {
    await deletePrefix(`outputs/${job.id}/`);
    job.outputDeletedAt = new Date().toISOString();
    changed = true;
  }
  if (changed) {
    job.updatedAt = new Date().toISOString();
    await writeJsonObject(`jobs/${job.id}.json`, job, job.__generation);
  }
}

function withRetention(job) {
  const sourceDeleteAt = new Date(retentionDate(job, "source-delete")).toISOString();
  const outputDeleteAt = new Date(retentionDate(job, "output-delete")).toISOString();
  return { ...job, retention: { sourceDeleteAt, outputDeleteAt, sourceDeleted: Boolean(job.sourceDeletedAt), outputDeleted: Boolean(job.outputDeletedAt), published: Boolean(job.publishedAt) } };
}

function retentionDate(job, kind) {
  const updated = Date.parse(job.updatedAt || job.createdAt || new Date().toISOString());
  const completed = Date.parse(job.completedAt || job.updatedAt || job.createdAt || new Date().toISOString());
  const published = job.publishedAt ? Date.parse(job.publishedAt) : NaN;
  if (kind === "failed-delete") return updated + 14 * 86400000;
  if (Number.isFinite(published)) return published + (kind === "source-delete" ? 86400000 : 7 * 86400000);
  return completed + 14 * 86400000;
}

async function deleteJobObjects(job, includeStatus) {
  await Promise.all([deletePrefix(`uploads/${job.id}/`), deletePrefix(`outputs/${job.id}/`), deletePrefix(`checkpoints/${job.id}/`)]);
  if (includeStatus) await deleteObject(`jobs/${job.id}.json`);
}

async function deletePrefix(prefix) {
  const objects = await listObjects(prefix);
  await Promise.all(objects.map(object => deleteObject(object.name)));
}

async function deleteObject(objectName) {
  const response = await authorizedFetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`, { method: "DELETE" });
  if (![204, 404].includes(response.status)) throw new Error(`Cloud Storage could not delete ${objectName} (${response.status}).`);
}

async function setObjectCustomTime(objectName, customTime) {
  const response = await authorizedFetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customTime }),
  });
  if (![200, 404].includes(response.status)) throw new Error(`Cloud Storage could not schedule cleanup for ${objectName} (${response.status}).`);
}

async function listObjects(prefix) {
  const objects = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({ prefix, fields: "items(name,size,updated),nextPageToken", maxResults: "1000" });
    if (pageToken) query.set("pageToken", pageToken);
    const response = await authorizedFetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o?${query}`);
    if (!response.ok) throw new Error(`Cloud Storage could not list ${prefix || "stored files"} (${response.status}).`);
    const page = await response.json();
    objects.push(...(page.items || []));
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  return objects;
}

async function resolveSourceObject(status, id) {
  if (status.sourceObject) return status.sourceObject;
  const objects = await listObjects(`uploads/${id}/`);
  return objects[0]?.name || "";
}

async function reconcileCloudOperation(job) {
  if (job.stage === "uploaded" && Number(job.progress || 0) < 5) {
    const sourceObject = await resolveSourceObject(job, job.id);
    if (!sourceObject || !await objectExists(sourceObject)) {
      const waiting = {
        ...job,
        ...(sourceObject ? { sourceObject } : {}),
        stage: "uploading",
        uploadedBytes: Number(job.uploadedBytes || 0),
        progressDetail: "The source upload is incomplete. Select the same video file to continue from the saved cloud offset.",
        updatedAt: new Date().toISOString(),
      };
      const saved = await writeJsonObject(`jobs/${job.id}.json`, waiting, job.__generation);
      return saved ? waiting : (await readJsonObject(`jobs/${job.id}.json`)) || waiting;
    }
  }
  if (["uploading", "uploaded", "completed", "failed", "attention_required"].includes(job.stage) || !job.cloudOperation) return job;
  const response = await authorizedFetch(`https://run.googleapis.com/v2/${job.cloudOperation}`);
  if (!response.ok) return job;
  const operation = await response.json();
  // Cloud Run may report a cancelled execution as a completed operation with
  // no top-level error. The execution's Completed condition is authoritative;
  // otherwise the dashboard can remain "tracking" forever and reject Resume.
  const executionConditions = [
    ...(Array.isArray(operation.metadata?.conditions) ? operation.metadata.conditions : []),
    ...(Array.isArray(operation.response?.conditions) ? operation.response.conditions : []),
  ];
  const executionFailed = executionConditions.some(condition => condition.type === "Completed"
    && (condition.state === "CONDITION_FAILED" || condition.status === "False"));
  if (!operation.done || (!operation.error && !executionFailed)) return job;
  const sourceCandidate = await resolveSourceObject(job, job.id);
  const sourceObject = sourceCandidate && await objectExists(sourceCandidate) ? sourceCandidate : "";
  const next = {
    ...job,
    ...(sourceObject ? { sourceObject } : {}),
    stage: "failed",
    progressDetail: ["youtube", "remote"].includes(job.sourceKind) && !sourceObject
      ? "The video import worker stopped before saving the source. Retry the import; no editing work was started."
      : sourceObject
        ? job.checkpointObject
          ? `The cloud worker stopped. A durable ${Number(job.checkpointProgress || job.progress || 0).toFixed(0)}% checkpoint is ready to resume.`
          : "The cloud worker stopped. The saved source is ready, but this legacy run has no durable processing checkpoint."
        : "The source upload is incomplete. Select the same video file to continue.",
    error: { code: ["youtube", "remote"].includes(job.sourceKind) && !sourceObject ? "SOURCE_IMPORT_FAILED" : "CLOUD_WORKER_FAILED", message: ["youtube", "remote"].includes(job.sourceKind) && !sourceObject ? "The video source import stopped before completion." : sourceObject ? (job.checkpointObject ? "The cloud worker stopped; resume from the saved processing checkpoint." : "The cloud worker stopped; retry from the saved source.") : "The source upload did not finish.", retryable: true },
    updatedAt: new Date().toISOString(),
  };
  const saved = await writeJsonObject(`jobs/${job.id}.json`, next, job.__generation);
  return saved ? next : (await readJsonObject(`jobs/${job.id}.json`)) || next;
}

async function streamOutput(request, response, id) {
  const upstream = await authorizedFetch(mediaUrl(`outputs/${id}/final.mp4`), { headers: request.headers.range ? { Range: String(request.headers.range) } : {} });
  if (!upstream.ok || !upstream.body) return json(response, upstream.status === 416 ? 416 : 404, { error: "Output not found" });
  const headers = { "Content-Type": upstream.headers.get("content-type") || "video/mp4", "Cache-Control": "private, no-store", "Accept-Ranges": "bytes" };
  // Do not forward Content-Length: Cloud Run caps non-chunked HTTP/1 responses
  // at 32 MiB, while the finished MP4 can be much larger. Node streams it as
  // Transfer-Encoding: chunked; Content-Range still supports browser seeking.
  const contentRange = upstream.headers.get("content-range");
  if (contentRange) headers["Content-Range"] = contentRange;
  response.writeHead(upstream.status, headers);
  for await (const chunk of upstream.body) if (!response.write(chunk)) await new Promise(resolveDrain => response.once("drain", resolveDrain));
  response.end();
}

async function streamSource(request, response, id) {
  const job = await readJsonObject(`jobs/${id}.json`);
  if (!job || job.stage !== "uploaded" || !job.readyToAnalyze) return json(response, 404, { error: "Ready source not found." });
  const objectName = await resolveSourceObject(job, id);
  if (!objectName) return json(response, 404, { error: "Stored source not found." });
  const upstream = await authorizedFetch(mediaUrl(objectName), { headers: request.headers.range ? { Range: String(request.headers.range) } : {} });
  if (!upstream.ok || !upstream.body) return json(response, upstream.status === 416 ? 416 : 404, { error: "Stored source not found." });
  const headers = { "Content-Type": job.sourceContentType || "video/mp4", "Cache-Control": "private, no-store", "Accept-Ranges": "bytes" };
  const contentRange = upstream.headers.get("content-range");
  if (contentRange) headers["Content-Range"] = contentRange;
  response.writeHead(upstream.status, headers);
  for await (const chunk of upstream.body) if (!response.write(chunk)) await new Promise(resolveDrain => response.once("drain", resolveDrain));
  response.end();
}

async function launchWorker(environment) {
  const runResponse = await authorizedFetch(`https://run.googleapis.com/v2/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/jobs/${encodeURIComponent(workerJob)}:run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ overrides: { taskCount: 1, timeout: "7200s", containerOverrides: [{ env: environment.map(([name, value]) => ({ name, value: String(value || "") })) }] } }),
  });
  if (!runResponse.ok) throw new Error(`Cloud Run could not start the worker (${runResponse.status}): ${await runResponse.text()}`);
  return runResponse.json();
}

async function objectExists(objectName) {
  const response = await authorizedFetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?fields=name`);
  return response.ok;
}

async function readJsonObject(objectName) {
  const response = await authorizedFetch(mediaUrl(objectName));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Cloud Storage could not read ${objectName} (${response.status}).`);
  const value = await response.json();
  Object.defineProperty(value, "__generation", { value: response.headers.get("x-goog-generation") || "", enumerable: false });
  return value;
}

async function writeJsonObject(objectName, value, generation = "") {
  const body = Buffer.from(JSON.stringify(value));
  const precondition = generation ? `&ifGenerationMatch=${encodeURIComponent(generation)}` : "";
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const response = await authorizedFetch(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}${precondition}`, { method: "POST", body, headers: { "Content-Type": "application/json", "Content-Length": String(body.length) } });
    if (response.status === 412) return false;
    if (response.ok) return true;
    const detail = await response.text();
    if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === 6) {
      throw new Error(`Cloud Storage could not write ${objectName} (${response.status}): ${detail}`);
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(15_000, 1200 * 2 ** attempt) + Math.floor(Math.random() * 500)));
  }
}

async function authorizedFetch(url, options = {}) {
  const token = await client.getAccessToken();
  return fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token.token || token}` } });
}

function mediaUrl(objectName) { return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`; }
function publicJob(job) { const value = { ...job, workflow:buildWorkflowProgress(job),resumeAvailable: Boolean(job.checkpointObject) }; if (job.stage === "completed" && job.cloudOutputObject) value.outputUrl = `/outputs/${job.id}/final.mp4`; delete value.sourceObject; delete value.editSettings; delete value.cloudOutputObject; delete value.uploadSessionUrl; delete value.checkpointObject; delete value.importUrl; return value; }
function safeFileName(value) { return Array.from(String(value), character => character.charCodeAt(0) < 32 || /[\\/:*?"<>|]/.test(character) ? "_" : character).join("").slice(0, 180) || "source.mp4"; }
function setCors(request, response) { const origin = String(request.headers.origin || ""); if (allowedOrigins.has(origin)) { response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Vary", "Origin"); } response.setHeader("Access-Control-Allow-Headers", "content-type,x-file-name,x-edit-settings"); response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS"); }
function json(response, status, value) { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); }
function send(response, status) { response.writeHead(status); response.end(); }
function required(name) { const value = String(process.env[name] || "").trim(); if (!value) throw new Error(`${name} is required.`); return value; }
async function readJson(request, maximum) { const chunks = []; let total = 0; for await (const chunk of request) { total += chunk.length; if (total > maximum) throw new Error("Request body is too large."); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
async function readBody(request, maximum) { const chunks = []; let total = 0; for await (const chunk of request) { total += chunk.length; if (total > maximum) throw new Error("Request body is too large."); chunks.push(chunk); } return Buffer.concat(chunks).toString("utf8"); }
