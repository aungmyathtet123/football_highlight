export function normalizeAuthorizedYouTubeUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); }
  catch { throw new Error("Enter a valid YouTube video URL."); }
  if (url.protocol !== "https:") throw new Error("The YouTube URL must use HTTPS.");
  if (url.username || url.password || (url.port && url.port !== "443")) throw new Error("This YouTube URL is not supported.");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const youtubeHost = host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be" || host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com");
  if (!youtubeHost) throw new Error("Only YouTube video links are supported by this importer.");
  const videoId = host === "youtu.be"
    ? url.pathname.split("/").filter(Boolean)[0]
    : url.searchParams.get("v") || url.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,})/)?.[1];
  if (!videoId || !/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) throw new Error("This link does not identify one YouTube video.");
  url.hash = "";
  return { url: url.href, videoId };
}
