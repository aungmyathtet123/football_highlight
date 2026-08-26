import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  MAX_SCENE_SECONDS,
  assessPlannedSceneTracking,
  buildContentWritingPrompt,
  buildContinuousNarration,
  buildEvidenceAlignmentPrompt,
  buildWholeVideoDirectorPrompt,
  contentPlanProblems,
  normalizeContentPlan,
  plannedSegmentDuration,
  rankSemanticBackups,
  selectDirectorCandidates,
  semanticBackupScore,
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
test("content is written before timestamps or editing are chosen", () => {
  const prompt = buildContentWritingPrompt({ sourceDuration: 529.1, targetDuration: 60 });
  assert.match(prompt, /complete source from beginning to end/i);
  assert.match(prompt, /do not choose timestamps or edit clips yet/i);
  assert.match(prompt, /at least 60 seconds/i);
  assert.match(prompt, /120-147 words/i);
  assert.match(prompt, /never use directing filler/i);
});

test("evidence alignment follows the approved content and targets a full minute", () => {
  const prompt = buildEvidenceAlignmentPrompt({ targetDuration: 60, intensity: "dynamic" });
  assert.match(prompt, /content is already approved/i);
  assert.match(prompt, /do not rewrite the analysis/i);
  assert.match(prompt, /60- to 63-second visual timeline/i);
  assert.match(prompt, /1\.2-5\.0 second clips/i);
});

test("content validation rejects short scripts and directing filler", () => {
  const beats = Array.from({ length: 12 }, (_, index) => ({
    beatId: "beat-" + index,
    narration: index === 0 ? "Look at the replay because this sentence is deliberately invalid filler language." : "Movement and timing create the decisive advantage before the final action becomes obvious.",
    evidenceNeed: "Player and ball together",
    captionText: "KEY DETAIL",
  }));
  const plan = normalizeContentPlan({
    editorialThesis: "A complete thesis",
    storyQuestion: "Why does the move work?",
    storyAnswer: "Movement creates the space.",
    contentBeats: beats,
  }, 60);
  assert.ok(contentPlanProblems(plan, 60).includes("directing_filler_language"));
  const short = normalizeContentPlan({
    editorialThesis: "A thesis",
    storyQuestion: "Why?",
    storyAnswer: "Timing.",
    contentBeats: beats.slice(0, 2),
  }, 60);
  assert.ok(contentPlanProblems(short, 60).some((problem) => problem.startsWith("script_too_short")));
});

test("planned visual duration accounts for playback and transitions", () => {
  const segments = Array.from({ length: 12 }, (_, index) => ({ startTime: index * 6, endTime: index * 6 + 5, playbackRate: 1, transitionDuration: 0.04 }));
  assert.ok(plannedSegmentDuration(segments) > 59.5);
  assert.ok(plannedSegmentDuration(segments) < 60.1);
});
test("processor stage order is observe, write content, align evidence, then track", () => {
  const source = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  const analyze = source.indexOf('updateJob(job, "analyzing"');
  const write = source.indexOf('updateJob(job, "writing_content"');
  const align = source.indexOf('updateJob(job, "aligning_content"');
  const track = source.indexOf('updateJob(job, "tracking", 52');
  assert.ok(analyze >= 0 && analyze < write);
  assert.ok(write < align);
  assert.ok(align < track);
});
test("approved content identity survives alignment and hard cuts stay streamable", () => {
  const server = readFileSync(new URL("../local-processor/server.mjs", import.meta.url), "utf8");
  const renderer = readFileSync(new URL("../local-processor/render-video-v2.mjs", import.meta.url), "utf8");
  assert.match(server, /beatId: String\(directive\.beatId/);
  assert.doesNotMatch(server, /directive\.commentary \|\| candidate\.commentary/);
  assert.match(server, /restoreContentBeatOrder/);
  assert.match(server, /restoreOriginalPlannedScenes/);
  assert.match(renderer, /requestedTransition === "cut"/);
  assert.match(renderer, /concat=n=2:v=1:a=1/);
});
test("semantic backups prefer the same incident over a higher-importance unrelated clip", () => {
  const planned = {
    id: "clearance-action",
    selectedForFinalVideo: true,
    storyId: "goal-line-clearance",
    eventType: "save",
    description: "Cresswell clears Hakimi's header off the goal line.",
    commentary: "A heroic goal-line clearance protects the lead.",
  };
  const sameIncident = {
    id: "clearance-replay",
    storyId: "goal-line-clearance",
    eventType: "save",
    description: "Replay from the net shows the defender clearing the ball off the line.",
    importanceScore: 55,
  };
  const unrelatedGoal = {
    id: "unrelated-goal",
    storyId: "different-goal",
    eventType: "goal",
    description: "A striker scores and celebrates with teammates.",
    importanceScore: 99,
  };
  const unrelatedReaction = {
    id: "same-story-celebration", storyId: planned.storyId, eventType: "celebration", storyPhase: "reaction",
    description: "A player celebrates with teammates near the corner flag.",
  };
  assert.ok(semanticBackupScore(planned, unrelatedReaction) < 18);
  assert.ok(semanticBackupScore(planned, sameIncident) > semanticBackupScore(planned, unrelatedGoal));
  assert.equal(rankSemanticBackups([planned], [unrelatedGoal, sameIncident])[0].moment.id, "clearance-replay");
});
