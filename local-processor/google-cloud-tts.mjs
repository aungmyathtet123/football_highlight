import { writeFile } from "node:fs/promises";
import { TextToSpeechClient } from "@google-cloud/text-to-speech";

export const commentaryPrompt = [
  "Use a natural adult male voice.",
  "Speak like a confident football analyst explaining one connected incident to an intelligent fan.",
  "Sound conversational, authoritative and energetic, but never shout like live play-by-play commentary.",
  "Emphasize causal words about movement, space, timing, decisions and consequences.",
  "Use punctuation for brief analytical pauses and maintain one consistent performance from hook through payoff.",
  "Do not imitate or clone any real football commentator.",
].join(" ");

export function getGoogleCloudTtsConfig() {
  const config = {
    provider: process.env.TTS_PROVIDER,
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
    location: process.env.GOOGLE_CLOUD_LOCATION,
    model: process.env.TTS_MODEL,
    languageCode: process.env.TTS_LANGUAGE,
    voice: process.env.TTS_VOICE,
  };
  if (config.provider !== "google_cloud") throw configurationError("TTS_PROVIDER must be google_cloud for Google Cloud Text-to-Speech.");
  for (const [name, value] of Object.entries({ GOOGLE_CLOUD_PROJECT: config.projectId, GOOGLE_CLOUD_LOCATION: config.location, TTS_MODEL: config.model, TTS_LANGUAGE: config.languageCode, TTS_VOICE: config.voice })) {
    if (!value) throw configurationError(`${name} is required for Google Cloud Text-to-Speech.`);
  }
  return config;
}

export async function synthesizeGoogleCloudSpeech(text, outputPath) {
  const config = getGoogleCloudTtsConfig();
  const options = { projectId: config.projectId };
  if (config.location !== "global") options.apiEndpoint = `${config.location}-texttospeech.googleapis.com`;
  const client = new TextToSpeechClient(options);
  try {
    const [response] = await client.synthesizeSpeech({
      input: { text, prompt: commentaryPrompt },
      voice: { languageCode: config.languageCode, name: config.voice, modelName: config.model },
      audioConfig: { audioEncoding: "LINEAR16" },
    });
    if (!response.audioContent) throw configurationError("Google Cloud Text-to-Speech returned no audio data.");
    const audio = typeof response.audioContent === "string" ? Buffer.from(response.audioContent, "base64") : Buffer.from(response.audioContent);
    await writeFile(outputPath, audio);
    return { outputPath, bytes: audio.length, config };
  } catch (error) {
    throw classifyGoogleCloudTtsError(error, config);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function classifyGoogleCloudTtsError(error, config) {
  if (error?.code === "TTS_CONFIGURATION") return error;
  const raw = String(error?.message || error);
  if (/default credentials|could not load.*credentials|metadata server|ENOENT.*application_default_credentials/i.test(raw)) {
    return configurationError("Application Default Credentials are not configured. Install gcloud, run `gcloud auth application-default login`, then set the quota project to football-506506.");
  }
  if (/texttospeech\.googleapis\.com.*disabled|SERVICE_DISABLED|API has not been used|not enabled/i.test(raw)) {
    return configurationError("Cloud Text-to-Speech API is disabled for football-506506. Enable texttospeech.googleapis.com and retry.");
  }
  if (error?.code === 16 || /UNAUTHENTICATED|invalid authentication credentials/i.test(raw)) {
    return configurationError("Google Cloud authentication failed. Refresh Application Default Credentials and retry.");
  }
  if (error?.code === 7 || /PERMISSION_DENIED|permission/i.test(raw)) {
    return configurationError("Google Cloud credentials lack permission to use Cloud Text-to-Speech in football-506506. Check IAM and the Service Usage Consumer permission.");
  }
  if (error?.code === 3 || /INVALID_ARGUMENT|unsupported|not found/i.test(raw)) {
    return configurationError(`Google Cloud Text-to-Speech rejected model ${config.model}, language ${config.languageCode}, or voice ${config.voice}. No fallback was selected.`);
  }
  if (error?.code === 8 || /RESOURCE_EXHAUSTED|quota|billing|429/i.test(raw)) {
    return configurationError("Google Cloud Text-to-Speech quota or billing prevented synthesis.");
  }
  return configurationError(`Google Cloud Text-to-Speech failed: ${sanitize(raw)}`);
}

function configurationError(message) { const error = new Error(message); error.code = "TTS_CONFIGURATION"; return error; }
function sanitize(message) { return message.replace(/ya29\.[A-Za-z0-9._-]+/g, "[REDACTED]").slice(0, 700); }