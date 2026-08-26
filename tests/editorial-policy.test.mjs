import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SCENE_SECONDS,
  assessPlannedSceneTracking,
  buildContinuousNarration,
  buildWholeVideoDirectorPrompt,
  selectDirectorCandidates,
  splitCaptionChunks,
  strongestStoryCandidates,
} from "../local-processor/editorial-policy.mjs";
import { commentaryPrompt } from "../local-processor/google-cloud-tts.mjs";

test("whole-video director prompt enforces the requested editorial flow", () => {
  const prompt = buildWholeVideoDirectorPrompt({
    sourceDuration: 540,
    targetDuration: 60,
    intensity: "dynamic",
    commentary: true,
  });
  assert.match(prompt, /complete 540\.00-second source from beginning to end/i);
  assert.match(prompt, /exactly one analytical question/i);
  assert.match(prompt, /one incident\/storyId/i);
  assert.match(prompt, /full-bleed 1080x1920/i);
  assert.match(prompt, /continuous male analyst narration/i);
  assert.match(prompt, /between 1\.2 and 5 output seconds/i);
  assert.equal(MAX_SCENE_SECONDS, 5);
});

test("director candidate selection considers strong moments from the end of a long video", () => {
  const candidates = Array.from({ length: 220 }, (_, index) => ({
    id: "candidate-" + index,
    startTime: index * 2,
    importanceScore: index === 219 ? 100 : 50,
    confidence: 0.8,
    keepDecision: "keep",
  }));
  const selected = selectDirectorCandidates(candidates, 180);
  assert.equal(selected.length, 180);
  assert.ok(selected.some((candidate) => candidate.id === "candidate-219"));
  assert.deepEqual(selected, [...selected].sort((a, b) => a.startTime - b.startTime));
});

test("deterministic fallback chooses a complete story instead of unrelated highlights", () => {
  const candidates = [
    { id: "solo", storyId: "unrelated", storyPhase: "payoff", importanceScore: 99, ballVisible: true, mainPlayerVisible: true },
    { id: "a", storyId: "incident", storyPhase: "build_up", importanceScore: 82, ballVisible: true, mainPlayerVisible: true },
    { id: "b", storyId: "incident", storyPhase: "action", importanceScore: 84, ballVisible: true, mainPlayerVisible: true },
    { id: "c", storyId: "incident", storyPhase: "payoff", importanceScore: 88, ballVisible: true, mainPlayerVisible: true },
    { id: "d", storyId: "incident", storyPhase: "replay", importanceScore: 80, ballVisible: true, mainPlayerVisible: true },
    { id: "e", storyId: "incident", storyPhase: "reaction", importanceScore: 76, ballVisible: false, mainPlayerVisible: true },
  ];
  assert.deepEqual(strongestStoryCandidates(candidates).map((candidate) => candidate.id), ["a", "b", "c", "d", "e"]);
});

test("continuous narration follows edit order and remains sentence based", () => {
  const narration = buildContinuousNarration([
    { selectedForFinalVideo: true, editOrder: 1, commentary: "That movement opens the space" },
    { selectedForFinalVideo: false, editOrder: 2, commentary: "Do not include this" },
    { selectedForFinalVideo: true, editOrder: 0, commentary: "Watch the defender step forward." },
  ]);
  assert.equal(narration, "Watch the defender step forward. That movement opens the space.");
});

test("captions are broken into animated mobile-size groups", () => {
  const chunks = splitCaptionChunks("Watch the defender step forward because that movement opens the space.", 4);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.split(/\s+/).length <= 4));
  assert.equal(chunks.join(" "), "Watch the defender step forward because that movement opens the space.");
});

test("TTS direction requests a male analyst rather than play-by-play hype", () => {
  assert.match(commentaryPrompt, /adult male voice/i);
  assert.match(commentaryPrompt, /football analyst/i);
  assert.match(commentaryPrompt, /never shout like live play-by-play/i);
  assert.match(commentaryPrompt, /one consistent performance/i);
});

test("tracking preserves a planned replay when only its opening frame is weak", () => {
  const assessment = assessPlannedSceneTracking(
    { eventType: "goal", storyPhase: "replay", role: "proof" },
    { openingJointVisible: false, jointVisibilityCoverage: 0.83, jointFitCoverage: 0.5 },
  );
  assert.deepEqual(assessment, { usable: true, mode: "recovered_planned_scene" });
});

test("tracking still rejects a planned gameplay scene with persistently missing joint framing", () => {
  const assessment = assessPlannedSceneTracking(
    { eventType: "normal_play", storyPhase: "action", role: "action" },
    { openingJointVisible: false, jointVisibilityCoverage: 0.31, jointFitCoverage: 0.22 },
  );
  assert.equal(assessment.usable, false);
});
