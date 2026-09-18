import assert from "node:assert/strict";
import test from "node:test";
import {
  downgradeToSafeStatic,
  recoverSafeStaticCandidates,
  safeStaticFallbackEligible,
  usesSafeStaticPresentation,
} from "../local-processor/delivery-policy.mjs";

const verifiedGoal = {
  eventType: "goal",
  semanticVerified: true,
  actionComplete: true,
  ballVisible: true,
  mainPlayerVisible: true,
  confidence: 0.94,
  visualClarity: 88,
  effect: "freeze_analysis",
  playerHighlight: true,
};

test("gameplay actions cannot bypass failed ball tracking with a static crop", () => {
  assert.equal(safeStaticFallbackEligible(verifiedGoal), false);
});

test("a verified freeze survives only with a verified phase anchor", () => {
  const fallback = downgradeToSafeStatic({
    ...verifiedGoal,
    trackingBrief: { contactTime: 12.4 },
  }, "insufficient_joint_framing", true);
  assert.equal(fallback.effect, "freeze_analysis");
});

test("only player-only reactions may use a static fallback", () => {
  const approved = { ...verifiedGoal, id: "approved", keepDecision: "keep" };
  const rejected = { ...verifiedGoal, id: "rejected", keepDecision: "reject", trackingDecision: "unstable_camera" };
  const reaction = {
    ...verifiedGoal,
    id: "reaction",
    eventType: "celebration",
    storyPhase: "reaction",
    keepDecision: "reject",
    trackingDecision: "unstable_camera",
  };
  const recovered = recoverSafeStaticCandidates([approved, rejected, reaction]);
  assert.equal(recovered[0], approved);
  assert.equal(recovered[1], rejected);
  assert.equal(recovered[2].keepDecision, "keep");
  assert.equal(usesSafeStaticPresentation(recovered[2]), true);
});

test("uncertain or incomplete events never enter the guaranteed fallback", () => {
  assert.equal(safeStaticFallbackEligible({ ...verifiedGoal, semanticVerified: false }), false);
  assert.equal(safeStaticFallbackEligible({ ...verifiedGoal, actionComplete: false }), false);
  assert.equal(safeStaticFallbackEligible({ ...verifiedGoal, ballVisible: false }), false);
});
