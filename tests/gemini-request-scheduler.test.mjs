import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createGeminiRequestGate,
  quotaRetryDelay,
  retryAfterMilliseconds,
} from "../local-processor/gemini-request-scheduler.mjs";

test("Gemini quota backoff honors Retry-After and otherwise grows to its cap", () => {
  assert.equal(retryAfterMilliseconds({ response: { headers: { get: () => "75" } } }), 75_000);
  assert.equal(retryAfterMilliseconds(new Error("RetryInfo retryDelay: 120s")), 120_000);
  assert.equal(quotaRetryDelay(1, { baseDelayMs: 60_000, maximumDelayMs: 300_000, random: () => 0.5 }), 60_000);
  assert.equal(quotaRetryDelay(4, { baseDelayMs: 60_000, maximumDelayMs: 300_000, random: () => 0.5 }), 300_000);
  assert.equal(quotaRetryDelay(1, { retryAfterMs: 90_000 }), 90_000);
});

test("Gemini request gate serializes calls and paces successful requests", async () => {
  let clock = 1_000;
  const waits = [];
  const order = [];
  const gate = createGeminiRequestGate({
    minimumIntervalMs: 12_000,
    now: () => clock,
    sleep: async milliseconds => { waits.push(milliseconds); clock += milliseconds; },
  });
  const first = gate.schedule(async () => { order.push("first"); return 1; });
  const second = gate.schedule(async () => { order.push("second"); return 2; });
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ["first", "second"]);
  assert.deepEqual(waits, [12_000]);
  assert.equal(gate.status().queued, 0);
});
test("processor persists quota waits and retries 429 responses without a fixed attempt ceiling", () => {
  const source = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  assert.match(source, /const geminiRequestGate = createGeminiRequestGate/);
  assert.match(source, /async function recordGeminiCapacityWait/);
  assert.match(source, /aiCapacityWait: \{/);
  assert.match(source, /resumeFromCandidates: Boolean/);
  assert.match(source, /for \(;;\)/);
  assert.match(source, /async function generateGeminiJson/);
  assert.match(source, /returned incomplete JSON\. Saved progress/);
  assert.match(source, /Gemini semantic verification\", 3\)/);
  assert.match(source, /if \(quotaLimited\) \{[\s\S]*quotaAttempt \+= 1;[\s\S]*continue;/);
  assert.doesNotMatch(source, /const exhausted = attempt === attempts/);
  assert.equal(source.match(/\.models\.generateContent\(/g)?.length, 1, "only the scheduler may call Gemini directly");
});
test("Gemini discovery is confined to Step 1 before scene-by-scene tracking", () => {
  const source = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  const processStart = source.indexOf("async function processJob");
  const trackingStart = source.indexOf("const prepared = await prepareIncidentEvidence", processStart);
  const writingStart = source.indexOf('updateJob(job, "writing_content", 40', trackingStart);
  const stepTwo = source.slice(trackingStart, writingStart);
  assert.ok(processStart >= 0 && trackingStart > processStart && writingStart > trackingStart);
  assert.match(source.slice(processStart, trackingStart), /discoverAdditionalCandidatesWithGemini/);
  assert.doesNotMatch(stepTwo, /discoverAdditionalCandidatesWithGemini|ensureTrackedGoalCompanions|recoverMissingLiveGoalIncidents/);
  assert.match(stepTwo, /Step 2 is deliberately one-way/);
});
