import { resolve } from "node:path";
import { loadProjectEnv } from "../local-processor/env.mjs";
import {
  configuredVideoIntelligenceFeatures,
  verifyVideoIntelligenceConnection,
  videoIntelligenceEnabled,
} from "../local-processor/google-video-intelligence.mjs";

await loadProjectEnv(resolve(".env"));

if (!videoIntelligenceEnabled()) fail("VIDEO_INTELLIGENCE_ENABLED must be true in .env.");
if (!process.env.GOOGLE_CLOUD_PROJECT) fail("GOOGLE_CLOUD_PROJECT is missing from .env.");

try {
  const result = await verifyVideoIntelligenceConnection();
  console.log("Google Video Intelligence client: OK");
  console.log(`Project: ${result.projectId}`);
  console.log(`Location: ${result.location}`);
  console.log(`Features: ${configuredVideoIntelligenceFeatures().join(", ")}`);
  console.log("No video was processed by this connection test.");
} catch (error) {
  const message = String(error?.message || error);
  if (/credential|unauthenticated|permission_denied|401|403/i.test(message)) {
    fail("Video Intelligence authentication failed. Run gcloud auth application-default login and set the quota project.");
  }
  fail(`Video Intelligence connection failed: ${message.slice(0, 600)}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
