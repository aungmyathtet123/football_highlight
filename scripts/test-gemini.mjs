import { resolve } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { loadProjectEnv } from "../local-processor/env.mjs";

await loadProjectEnv(resolve(".env"));

const key = process.env.GEMINI_API_KEY;
const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION;
const model = process.env.GEMINI_MODEL;

if (!key) fail("GEMINI_API_KEY is missing from .env.");
if (!project) fail("GOOGLE_CLOUD_PROJECT is missing from .env.");
if (!location) fail("GOOGLE_CLOUD_LOCATION is missing from .env.");
if (!model) fail("GEMINI_MODEL is missing from .env.");

try {
  const ai = new GoogleGenAI({ vertexai: true, apiKey: key });
  const response = await ai.models.generateContent({
    model,
    contents: "Reply with exactly: TOUCHLINE_GEMINI_OK",
  });
  if (!response.text?.includes("TOUCHLINE_GEMINI_OK")) {
    fail(`Gemini responded, but the configured model ${model} did not return the expected confirmation.`);
  }
  console.log("Gemini connection: OK");
  console.log(`Project: ${project}`);
  console.log(`Location: ${location}`);
  console.log(`Model: ${model}`);
} catch (error) {
  const message = String(error?.message || error);
  if (/api key|unauthenticated|permission_denied|401|403/i.test(message)) fail("Gemini authentication failed. Verify GEMINI_API_KEY and that the Agent Platform API key is enabled for this project.");
  if (/model|not found|unsupported|404/i.test(message)) fail(`Gemini model ${model} is unavailable for this API key. Configure GEMINI_MODEL with an available model ID; no fallback was selected.`);
  if (/quota|billing|resource_exhausted|429/i.test(message)) fail("Gemini quota or billing prevented the connection test.");
  fail(`Gemini connection failed: ${sanitize(message)}`);
}

function fail(message) { console.error(message); process.exit(1); }
function sanitize(message) { return message.replaceAll(key || "<missing>", "[REDACTED]").slice(0, 600); }