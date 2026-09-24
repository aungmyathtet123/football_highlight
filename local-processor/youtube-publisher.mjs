import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createSerializedJsonStore } from "./serialized-json-store.mjs";

const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const YOUTUBE_READ_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CHANNELS_ENDPOINT = "https://www.googleapis.com/youtube/v3/channels?part=id,snippet,statistics&mine=true";
const UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";

export async function createYouTubePublisher({ dataRoot, credentialFile, redirectUri, allowedReturnOrigins = [], fetchImpl = fetch }) {
  const youtubeRoot = join(dataRoot, "youtube");
  await mkdir(youtubeRoot, { recursive: true });
  const saveJson = createSerializedJsonStore(youtubeRoot);
  const states = new Map();
  const uploadLocks = new Map();

  async function credentials() {
    if (!credentialFile) throw new Error("YouTube OAuth is not configured. Set YOUTUBE_OAUTH_CLIENT_FILE.");
    const document = JSON.parse(await readFile(credentialFile, "utf8"));
    const value = document.web || document.installed;
    if (!value?.client_id || !value?.client_secret) throw new Error("The YouTube OAuth credential file is invalid.");
    return { clientId: value.client_id, clientSecret: value.client_secret };
  }

  async function readConnections() {
    try { return JSON.parse(await readFile(join(youtubeRoot, "connections.json"), "utf8")); }
    catch { return { version: 1, channels: {}, uploads: {} }; }
  }

  async function saveConnections(value) { await saveJson("connections", value); }

  async function status() {
    let configured = true;
    try { await credentials(); } catch { configured = false; }
    const stored = await readConnections();
    return {
      configured,
      channels: Object.values(stored.channels || {}).map(publicChannel).sort((a, b) => a.connectedAt.localeCompare(b.connectedAt)),
      uploads: Object.values(stored.uploads || {}).map(publicUpload),
    };
  }

  async function authorizationUrl(returnTo) {
    const { clientId } = await credentials();
    const returnOrigin = safeReturnOrigin(returnTo, allowedReturnOrigins);
    const state = randomBytes(24).toString("base64url");
    states.set(state, { returnOrigin, expiresAt: Date.now() + 10 * 60 * 1000 });
    for (const [key, value] of states) if (value.expiresAt < Date.now()) states.delete(key);
    return buildAuthorizationUrl({ clientId, redirectUri, state });
  }

  async function completeAuthorization({ code, state }) {
    const pending = states.get(state);
    states.delete(state);
    if (!pending || pending.expiresAt < Date.now()) throw new Error("This YouTube connection request expired. Start it again.");
    if (!code) throw new Error("Google did not return an authorization code.");
    const { clientId, clientSecret } = await credentials();
    const tokenResponse = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
    });
    const tokens = await responseJson(tokenResponse, "Google could not authorize this YouTube channel.");
    const channelResponse = await fetchImpl(CHANNELS_ENDPOINT, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const channelData = await responseJson(channelResponse, "YouTube could not identify the selected channel.");
    const channel = channelData.items?.[0];
    if (!channel?.id) throw new Error("The selected Google account does not have a YouTube channel.");
    const stored = await readConnections();
    const previous = stored.channels?.[channel.id];
    stored.channels ||= {};
    stored.channels[channel.id] = {
      channelId: channel.id,
      title: channel.snippet?.title || "YouTube channel",
      handle: channel.snippet?.customUrl || "",
      thumbnailUrl: channel.snippet?.thumbnails?.default?.url || "",
      subscriberCount: Number(channel.statistics?.subscriberCount || 0),
      refreshToken: tokens.refresh_token || previous?.refreshToken,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
      connectedAt: previous?.connectedAt || new Date().toISOString(),
    };
    if (!stored.channels[channel.id].refreshToken) throw new Error("Google did not issue a reusable upload token. Remove the app from Google permissions and connect again.");
    await saveConnections(stored);
    return { channel: publicChannel(stored.channels[channel.id]), returnOrigin: pending.returnOrigin };
  }

  async function upload({ jobId, channelId, outputPath, title, description }) {
    const key = `${jobId}:${channelId}`;
    if (uploadLocks.has(key)) return uploadLocks.get(key);
    const task = performUpload({ jobId, channelId, outputPath, title, description });
    uploadLocks.set(key, task);
    try { return await task; } finally { uploadLocks.delete(key); }
  }

  async function performUpload({ jobId, channelId, outputPath, title, description }) {
    const stored = await readConnections();
    const existing = stored.uploads?.[`${jobId}:${channelId}`];
    if (existing?.status === "completed") return publicUpload(existing);
    const channel = stored.channels?.[channelId];
    if (!channel) throw new Error("Connect this YouTube channel before uploading.");
    const info = await stat(outputPath);
    const accessToken = await validAccessToken(channel, stored);
    const metadata = {
      snippet: { title: cleanText(title, 100) || "Touchline AI football recap", description: cleanText(description, 5000), categoryId: "17" },
      status: { privacyStatus: "private", selfDeclaredMadeForKids: false },
    };
    const sessionResponse = await fetchImpl(UPLOAD_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(info.size),
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify(metadata),
    });
    if (!sessionResponse.ok) await responseJson(sessionResponse, "YouTube could not start the upload.");
    const uploadUrl = sessionResponse.headers.get("location");
    if (!uploadUrl) throw new Error("YouTube did not return a resumable upload URL.");
    const uploadResponse = await fetchImpl(uploadUrl, {
      method: "PUT",
      headers: { "Content-Length": String(info.size), "Content-Type": "video/mp4" },
      body: createReadStream(outputPath),
      duplex: "half",
    });
    const video = await responseJson(uploadResponse, "YouTube could not finish the video upload.");
    const record = {
      jobId, channelId, videoId: video.id, title: metadata.snippet.title, privacyStatus: "private",
      status: "completed", uploadedAt: new Date().toISOString(), url: `https://studio.youtube.com/video/${encodeURIComponent(video.id)}/edit`,
    };
    const latest = await readConnections();
    latest.uploads ||= {};
    latest.uploads[`${jobId}:${channelId}`] = record;
    await saveConnections(latest);
    return publicUpload(record);
  }

  async function validAccessToken(channel, stored) {
    if (channel.accessToken && Number(channel.expiresAt || 0) > Date.now() + 60_000) return channel.accessToken;
    const { clientId, clientSecret } = await credentials();
    const response = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: channel.refreshToken, grant_type: "refresh_token" }),
    });
    const tokens = await responseJson(response, "Google could not refresh the YouTube authorization.");
    channel.accessToken = tokens.access_token;
    channel.expiresAt = Date.now() + Number(tokens.expires_in || 3600) * 1000;
    await saveConnections(stored);
    return channel.accessToken;
  }

  return { status, authorizationUrl, completeAuthorization, upload };
}

export function buildAuthorizationUrl({ clientId, redirectUri, state }) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
    scope: `${YOUTUBE_UPLOAD_SCOPE} ${YOUTUBE_READ_SCOPE}`,
    state,
  }).toString();
  return url.toString();
}

function safeReturnOrigin(returnTo, allowedOrigins) {
  try {
    const origin = new URL(returnTo).origin;
    if (allowedOrigins.includes(origin)) return origin;
  } catch { /* Fall through to the configured origin. */ }
  return allowedOrigins[0] || "http://localhost:3001";
}

function publicChannel(channel) {
  return {
    channelId: channel.channelId,
    title: channel.title,
    handle: channel.handle,
    thumbnailUrl: channel.thumbnailUrl,
    subscriberCount: channel.subscriberCount,
    connectedAt: channel.connectedAt,
  };
}

function publicUpload(upload) {
  return {
    jobId: upload.jobId,
    channelId: upload.channelId,
    videoId: upload.videoId,
    title: upload.title,
    privacyStatus: upload.privacyStatus,
    status: upload.status,
    uploadedAt: upload.uploadedAt,
    url: upload.url,
  };
}

function cleanText(value, maximum) {
  return Array.from(String(value || ""), character => character.charCodeAt(0) < 32 && character !== "\n" ? " " : character)
    .join("").trim().slice(0, maximum);
}

async function responseJson(response, fallback) {
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : {}; } catch { value = {}; }
  if (!response.ok) throw new Error(value?.error?.message || value?.error_description || fallback);
  return value;
}
