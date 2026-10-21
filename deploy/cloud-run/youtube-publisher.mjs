import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const storageKey = "youtube/connections.json";
const scopes = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";

export function createCloudYouTubePublisher({ clientJson, redirectUri, signingSecret, readJsonObject, writeJsonObject, authorizedFetch, mediaUrl, fetchImpl = fetch }) {
  function credentials() {
    let document;
    try { document = JSON.parse(clientJson); } catch { throw new Error("YouTube OAuth is not configured on this cloud service."); }
    const value = document.web || document.installed;
    if (!value?.client_id || !value?.client_secret || !redirectUri || !signingSecret) throw new Error("YouTube OAuth is not configured on this cloud service.");
    if (!value.redirect_uris?.includes(redirectUri)) throw new Error(`Add ${redirectUri} to the Google OAuth client's authorized redirect URIs, then update its cloud credential secret.`);
    return { id: value.client_id, secret: value.client_secret };
  }

  async function connections() { return (await readJsonObject(storageKey)) || { version: 1, channels: {}, uploads: {} }; }
  async function save(next, previous) {
    const accepted = await writeJsonObject(storageKey, next, previous.__generation || "");
    if (!accepted) throw new Error("YouTube connection data changed during this request. Please retry.");
  }
  function publicChannel(channel) { const { channelId, title, handle, thumbnailUrl, subscriberCount, connectedAt } = channel; return { channelId, title, handle, thumbnailUrl, subscriberCount, connectedAt }; }
  function publicUpload(upload) { const { jobId, channelId, videoId, title, privacyStatus, status, uploadedAt, url } = upload; return { jobId, channelId, videoId, title, privacyStatus, status, uploadedAt, url }; }

  async function status() {
    let configured = true;
    let setupMessage = "";
    try { credentials(); } catch (error) { configured = false; setupMessage = error.message; }
    const stored = await connections();
    return { configured, setupMessage, channels: Object.values(stored.channels || {}).map(publicChannel), uploads: Object.values(stored.uploads || {}).map(publicUpload) };
  }

  function authorizationUrl(request) {
    const { id } = credentials();
    const origin = new URL(redirectUri).origin;
    if (new URL(`https://${request.headers.host}`).origin !== origin) throw new Error("The YouTube callback must use this site's configured HTTPS origin.");
    const payload = `${Date.now()}.${randomBytes(16).toString("hex")}`;
    const signature = createHmac("sha256", signingSecret).update(payload).digest("base64url");
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: id, redirect_uri: redirectUri, response_type: "code", access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true", scope: scopes, state: `${payload}.${signature}` }).toString();
    return url.toString();
  }

  async function completeAuthorization(params) {
    if (params.get("error")) throw new Error(params.get("error_description") || params.get("error"));
    const [timestamp, nonce, signature] = String(params.get("state") || "").split(".");
    const payload = `${timestamp}.${nonce}`;
    const expected = createHmac("sha256", signingSecret).update(payload).digest("base64url");
    const left = Buffer.from(signature || ""); const right = Buffer.from(expected);
    if (!/^\d+$/.test(timestamp || "") || Math.abs(Date.now() - Number(timestamp)) > 10 * 60_000 || left.length !== right.length || !timingSafeEqual(left, right)) throw new Error("This YouTube connection request expired. Start it again.");
    const code = params.get("code");
    if (!code) throw new Error("Google did not return an authorization code.");
    const { id, secret } = credentials();
    const tokens = await googleJson(await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirectUri, grant_type: "authorization_code" }) }), "Google could not authorize this YouTube channel.");
    const data = await googleJson(await fetchImpl("https://www.googleapis.com/youtube/v3/channels?part=id,snippet,statistics&mine=true", { headers: { Authorization: `Bearer ${tokens.access_token}` } }), "YouTube could not identify the selected channel.");
    const item = data.items?.[0];
    if (!item?.id) throw new Error("The selected Google account does not have a YouTube channel.");
    const stored = await connections();
    const previous = stored.channels?.[item.id];
    const channel = { channelId: item.id, title: item.snippet?.title || "YouTube channel", handle: item.snippet?.customUrl || "", thumbnailUrl: item.snippet?.thumbnails?.default?.url || "", subscriberCount: Number(item.statistics?.subscriberCount || 0), connectedAt: previous?.connectedAt || new Date().toISOString(), refreshToken: tokens.refresh_token || previous?.refreshToken, accessToken: tokens.access_token, expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000 };
    if (!channel.refreshToken) throw new Error("Google did not issue a reusable upload token. Revoke this app's Google permission and connect again.");
    stored.channels ||= {}; stored.channels[item.id] = channel;
    await save(stored, stored);
    return publicChannel(channel);
  }

  async function accessToken(channel, stored) {
    if (channel.accessToken && channel.expiresAt > Date.now() + 60_000) return channel.accessToken;
    const { id, secret } = credentials();
    const tokens = await googleJson(await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: channel.refreshToken, grant_type: "refresh_token" }) }), "Google could not refresh this YouTube connection.");
    channel.accessToken = tokens.access_token; channel.expiresAt = Date.now() + Number(tokens.expires_in || 3600) * 1000;
    await save(stored, stored);
    return channel.accessToken;
  }

  async function upload({ jobId, channelId, outputObject, title, description }) {
    credentials();
    const stored = await connections();
    const existing = stored.uploads?.[`${jobId}:${channelId}`];
    if (existing?.status === "completed") return publicUpload(existing);
    const channel = stored.channels?.[channelId];
    if (!channel) throw new Error("Connect this YouTube channel before uploading.");
    const token = await accessToken(channel, stored);
    const source = await authorizedFetch(mediaUrl(outputObject));
    if (!source.ok || !source.body) throw new Error("The finished cloud video is not available.");
    const size = Number(source.headers.get("content-length") || 0);
    if (!size) throw new Error("Cloud Storage did not report the video size.");
    const metadata = { snippet: { title: cleanText(title, 100) || "Touchline AI football recap", description: cleanText(description, 5000), categoryId: "17" }, status: { privacyStatus: "private", selfDeclaredMadeForKids: false } };
    const session = await fetchImpl("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(size), "X-Upload-Content-Type": "video/mp4" }, body: JSON.stringify(metadata) });
    if (!session.ok) await googleJson(session, "YouTube could not start the upload.");
    const location = session.headers.get("location");
    if (!location) throw new Error("YouTube did not return a resumable upload URL.");
    const video = await googleJson(await fetchImpl(location, { method: "PUT", headers: { "Content-Length": String(size), "Content-Type": "video/mp4" }, body: source.body, duplex: "half" }), "YouTube could not finish the video upload.");
    if (!video.id) throw new Error("YouTube did not confirm the new video ID.");
    const latest = await connections();
    const record = { jobId, channelId, videoId: video.id, title: metadata.snippet.title, privacyStatus: "private", status: "completed", uploadedAt: new Date().toISOString(), url: `https://studio.youtube.com/video/${encodeURIComponent(video.id)}/edit` };
    latest.uploads ||= {}; latest.uploads[`${jobId}:${channelId}`] = record;
    await save(latest, latest);
    return publicUpload(record);
  }

  return { status, authorizationUrl, completeAuthorization, upload };
}

function cleanText(value, limit) { return String(value || "").replace(/[\x00-\x09\x0b-\x1f]/g, " ").trim().slice(0, limit); }
async function googleJson(response, fallback) { const raw = await response.text(); let value = {}; try { value = JSON.parse(raw); } catch {} if (!response.ok) throw new Error(value?.error?.message || value?.error_description || fallback); return value; }
