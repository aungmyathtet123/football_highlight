import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadProjectEnv } from "../local-processor/env.mjs";
import { synthesizeGoogleCloudSpeech } from "../local-processor/google-cloud-tts.mjs";

await loadProjectEnv(resolve(".env"));
const outputPath = resolve("work/google-cloud-tts-test.wav");
await mkdir(dirname(outputPath), { recursive: true });

try {
  await synthesizeGoogleCloudSpeech("What a finish. The striker finds the space and makes no mistake.", outputPath);
  console.log("Google Cloud TTS connection: OK");
  console.log(`Generated file: ${outputPath}`);
} catch (error) {
  console.error(error?.message || error);
  process.exit(1);
}