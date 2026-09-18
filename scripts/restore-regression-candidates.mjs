// Restore the complete semantically reviewed candidate set for an isolated
// regression job after a downstream tracking failure. This never changes a
// production job and lets camera-policy iterations reuse paid video analysis.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const directory = resolve(process.argv[2] || "");
const id = String(process.argv[3] || "");
if (!directory.includes("pipeline-regression-") || !/^[a-f0-9-]{36}$/i.test(id)) {
  throw new Error("Provide an isolated pipeline-regression directory and job ID.");
}
const data = join(directory, "data");
const jobPath = join(data, "jobs", `${id}.json`);
const cacheDirectory = join(data, "outputs", id, "semantic-cache");
const job = JSON.parse(await readFile(jobPath, "utf8"));
const candidates = [];
for (const name of await readdir(cacheDirectory)) {
  if (!name.endsWith(".json")) continue;
  const cached = JSON.parse(await readFile(join(cacheDirectory, name), "utf8"));
  candidates.push(...(Array.isArray(cached.candidates) ? cached.candidates : []));
}
const unique = [...new Map(candidates.map((candidate) => [String(candidate.id), candidate])).values()]
  .sort((left, right) => Number(left.startTime) - Number(right.startTime))
  .map((candidate) => {
    const restored = { ...candidate, selectedForFinalVideo: false };
    for (const key of ["selectionLocked", "selectionDecision", "sceneSelectionApproved", "selectionKeepDecision",
      "trackingDecision", "trackingPassed", "chosenIncidentAngle", "portraitRepairReason", "fallbackPresentation"])
      delete restored[key];
    return restored;
  });
if (!unique.length) throw new Error("No semantic candidates were found.");
for (const key of ["error", "outputKey", "outputUrl", "completedAt", "qualityReview", "renderValidation",
  "editPlan", "trackingSummary", "evidenceReport", "resumeFromCandidates", "resumeTrackingOnly"])
  delete job[key];
Object.assign(job, {
  stage: "detecting_moments",
  progress: 30,
  settings: {
    ...job.settings,
    editStyle: "complete_highlights",
    aspectRatio: "16:9",
    commentary: true,
    originalAudio: "muted",
  },
  moments: unique,
  observedMoments: unique,
  updatedAt: new Date().toISOString(),
});
await writeFile(jobPath, JSON.stringify(job, null, 2));
console.log(JSON.stringify({ id, restoredCandidates: unique.length }));
