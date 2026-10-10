import { writeFile, rename } from "node:fs/promises";
import { setTimeout as delay } from 'node:timers/promises';
import { TextToSpeechClient } from "@google-cloud/text-to-speech";
import { transientTtsError, ttsRetryDelay } from './tts-policy.mjs';

export const commentaryPrompt = [
  "Perform this as an energetic adult male football recap announcer with crisp broadcast-quality pronunciation and an audible vocal smile.",
  "Use infectious enthusiasm, urgent forward momentum, athletic confidence, and the excitement of a major post-match recap from the opening word. Never sound like a calm documentary, audiobook, corporate explainer, or neutral newsreader.",
  "Build tension quickly toward each decisive touch, use only a split-second dramatic pause before the strike, then deliver the goal, save, or outcome with an unmistakable lift in pitch, pace, force, and emotion.",
  "Punch action verbs and football consequences. Vary pitch, stress, volume, and sentence rhythm; use sharp attacks, short breaths, and confident finishes. Reset the energy after each outcome and drive immediately into the next incident.",
  "Average 165 to 175 words per minute with minimal dead air. Stay lively and compelling through the final sentence. Sound excited but controlled; never scream and never imitate live play-by-play.",
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

export async function synthesizeGoogleCloudSpeech(text, outputPath, {
  onRetry = async () => {}, sleep = delay, maxAttempts = 12,
  targetDuration = null,
  config = getGoogleCloudTtsConfig(), createClient = options => new TextToSpeechClient(options),
} = {}) {
  const generativeVoice = /^gemini-/i.test(config.model);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 60)
    throw configurationError('TTS retry attempts must be between 1 and 60.');
  const maximumBytes = generativeVoice ? 4000 : 5000;
  if (!String(text || '').trim() || Buffer.byteLength(text, 'utf8') > maximumBytes)
    throw configurationError(`Narration must contain 1-${maximumBytes} UTF-8 bytes per TTS request; split long narration before synthesis.`);
  if (generativeVoice && Buffer.byteLength(commentaryPrompt, 'utf8') > 4000)
    throw configurationError('The TTS performance prompt exceeds the provider byte limit.');
  const options = { projectId: config.projectId };
  if (config.location !== "global") options.apiEndpoint = `${config.location}-texttospeech.googleapis.com`;
  const client = createClient(options);
  try {
    const request = {
      input: generativeVoice ? { text, prompt: commentaryPrompt + (Number(targetDuration) > 0
        ? ` This narration belongs to a ${Number(targetDuration).toFixed(2)} second finished scene. Speak naturally and clearly, completing all words within that window. Do not read timestamps or add words. Do not rush or leave long pauses.` : '') } : { text },
      voice: generativeVoice
        ? { languageCode: config.languageCode, name: config.voice, modelName: config.model }
        : { languageCode: config.languageCode, name: config.voice },
      audioConfig: { audioEncoding: "LINEAR16" },
    };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response;
      try {
        [response] = await client.synthesizeSpeech(request, { timeout: 180000, retry: null });
        if (!response.audioContent?.length) throw new Error('Google Cloud Text-to-Speech returned no audio data.');
      } catch (error) {
        if (!transientTtsError(error)) throw error;
        if (attempt === maxAttempts) {
          const waiting = new Error(`Google Cloud Text-to-Speech remains temporarily unavailable: ${sanitize(String(error?.message || error))}`);
          waiting.code = 'TTS_TRANSIENT'; waiting.retryable = true;
          throw waiting;
        }
        const delayMs = ttsRetryDelay(attempt);
        await onRetry({ attempt, delayMs, reason: sanitize(String(error?.message || error)) });
        await sleep(delayMs);
        continue;
      }
      const audio = typeof response.audioContent === "string" ? Buffer.from(response.audioContent, "base64") : Buffer.from(response.audioContent);
      await writeFile(`${outputPath}.tmp`, audio);
      await rename(`${outputPath}.tmp`, outputPath);
      return { outputPath, bytes: audio.length, config };
    }
  } catch (error) {
    throw classifyGoogleCloudTtsError(error, config);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function classifyGoogleCloudTtsError(error, config) {
  if (['TTS_CONFIGURATION', 'TTS_TRANSIENT'].includes(error?.code)) return error;
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
