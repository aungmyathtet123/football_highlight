import assert from "node:assert/strict";
import test from "node:test";
import { buildViralReelPlan, isViralReel, viralReelDurationBounds } from "../local-processor/viral-reel-policy.mjs";
import { outputDimensions } from "../local-processor/render-video-v2.mjs";

const verified = {
  semanticVerified: true,
  keepDecision: "keep",
  trackingDecision: "phase_verified_goal",
  confidence: 0.95,
  importanceScore: 90,
  hookScore: 85,
  narrativeCompleteness: 90,
  visualClarity: 90,
  mainPlayerVisible: true,
};

test("Viral Reel combines strongest complete incidents to reach 30 seconds and never authors a player label", () => {
  const candidates = [
    { ...verified, id: "goal-a", storyId: "a", eventType: "goal", storyPhase: "action", startTime: 10, endTime: 18 },
    { ...verified, id: "reaction-a", storyId: "a", eventType: "celebration", storyPhase: "reaction", trackingDecision: "planned_reaction", startTime: 18, endTime: 24 },
    { ...verified, id: "replay-a", storyId: "a", eventType: "goal", storyPhase: "replay", keepDecision: "replay", isReplay: true, startTime: 25, endTime: 31 },
    { ...verified, id: "chance-b", storyId: "b", eventType: "big_chance", storyPhase: "action", startTime: 40, endTime: 47, importanceScore: 50 },
    { ...verified, id: "reaction-b", storyId: "b", eventType: "celebration", storyPhase: "reaction", trackingDecision: "planned_reaction", startTime: 47, endTime: 53, importanceScore: 50 },
  ];
  const plan = buildViralReelPlan(candidates);
  const selected = plan.moments.filter(moment => moment.selectedForFinalVideo);
  assert.equal(plan.storyId, "a");
  assert.deepEqual(plan.storyIds, ["a", "b"]);
  assert.equal(plan.incidentCount, 2);
  assert.ok(plan.plannedDuration >= 30);
  assert.ok(selected.every(moment => moment.commentary === ""));
  assert.ok(selected.every(moment => moment.identityLabel === undefined));
  assert.equal(selected.find(moment => moment.id === "goal-a").playerHighlight, true);
  assert.equal(selected.find(moment => moment.id === "replay-a").playerHighlight, false);
  assert.equal(selected.find(moment => moment.id === "reaction-a").endTime, 24);
});

test("decision replay receives a proof freeze and only evidence-safe text", () => {
  const candidates = [
    { ...verified, id: "action", storyId: "decision", eventType: "disallowed_goal", storyPhase: "action", startTime: 1, endTime: 8 },
    { ...verified, id: "replay", storyId: "decision", eventType: "disallowed_goal", storyPhase: "replay", keepDecision: "replay", isReplay: true, startTime: 10, endTime: 16 },
    { ...verified, id: "offside", storyId: "decision", eventType: "offside", storyPhase: "payoff", trackingDecision: "phase_verified_action", startTime: 17, endTime: 22 },
  ];
  const selected = buildViralReelPlan(candidates).moments.filter(moment => moment.selectedForFinalVideo);
  assert.equal(selected.find(moment => moment.id === "replay").effect, "freeze_analysis");
  assert.equal(selected.find(moment => moment.id === "offside").onScreenText, "DECISION: OFFSIDE");
  assert.ok(selected.every(moment => !/winger|scorer|striker/i.test(moment.onScreenText || "")));
});

test("unverified or rejected incidents cannot be selected", () => {
  assert.throws(() => buildViralReelPlan([
    { ...verified, id: "bad", storyId: "bad", eventType: "goal", storyPhase: "action", startTime: 0, endTime: 8, semanticVerified: false },
  ]), /No semantically and locally verified/);
});

test("Viral Reel uses a compact 4:5 canvas", () => {
  assert.equal(isViralReel({ editStyle: "viral_reel" }), true);
  assert.deepEqual(viralReelDurationBounds(), { minimum: 30, maximum: 45 });
  assert.deepEqual(outputDimensions({ aspectRatio: "4:5" }), { width: 1080, height: 1350 });
  assert.deepEqual(outputDimensions({ aspectRatio: "9:16" }), { width: 1080, height: 1920 });
  assert.deepEqual(outputDimensions({ aspectRatio: "16:9" }), { width: 1920, height: 1080 });
});
