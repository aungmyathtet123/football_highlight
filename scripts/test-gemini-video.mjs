import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { loadProjectEnv } from "../local-processor/env.mjs";

await loadProjectEnv(resolve(".env"));
const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL;
if (!key || !model) fail("GEMINI_API_KEY and GEMINI_MODEL are required.");
const path = resolve(process.argv[2] || "work/processor-test.mp4");
try {
  const video = await readFile(path);
  const ai = new GoogleGenAI({ vertexai: true, apiKey: key });
  const response = await ai.models.generateContent({
    model,
    contents: [
      { inlineData: { data: video.toString("base64"), mimeType: "video/mp4" } },
      { text: "Confirm that you received and inspected this video. Reply with exactly TOUCHLINE_VIDEO_OK." },
    ],
    config: { mediaResolution: "MEDIA_RESOLUTION_LOW" },
  });
  if (!response.text?.includes("TOUCHLINE_VIDEO_OK")) fail("Gemini received the request but did not return the expected video confirmation.");
  console.log("Gemini video connection: OK");
  console.log(`Model: ${model}`);
} catch (error) {
  const message = String(error?.message || error).replaceAll(key, "[REDACTED]");
  fail(`Gemini video connection failed: ${message.slice(0, 700)}`);
}
function fail(message) { console.error(message); process.exit(1); }