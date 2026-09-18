import test from "node:test";
import assert from "node:assert/strict";
import { assessNativeFrameAction, canRenderLockedNativeAction, recoverNativeFullFrameIncidents } from "../local-processor/native-frame-action.mjs";

const goal = {
  eventType: "goal",
  semanticVerified: true,
  actionComplete: true,
  ballVisible: true,
  mainPlayerVisible: true,
};

function evidence(overrides = {}) {
  return {
    playerDetectionCoverage: 1,
    phaseEvidence: {
      setup: { samples: 48, ballCoverage: .96, directJointCoverage: .65 },
      contact: { samples: 5, ballCoverage: .40, directJointCoverage: .20, payoffCoverage: .60 },
      flight: { samples: 6, ballCoverage: .67, payoffCoverage: .33 },
      payoff: { samples: 18, ballCoverage: 0, payoffCoverage: 1 },
    },
    ...overrides,
  };
}

test("accepts a native goal when brief contact occlusion has a verified setup-to-flight handoff", () => {
  assert.deepEqual(assessNativeFrameAction(goal, evidence()), {
    usable: true,
    mode: "native_frame_verified_goal",
  });
});

test("rejects contact occlusion when no flight or goal-region handoff supports it", () => {
  const weak = evidence();
  weak.phaseEvidence.contact.payoffCoverage = .10;
  weak.phaseEvidence.flight.ballCoverage = .10;
  weak.phaseEvidence.flight.payoffCoverage = .10;
  assert.deepEqual(assessNativeFrameAction(goal, weak), {
    usable: false,
    mode: "native_contact_evidence_incomplete",
  });
});

test("still rejects a player-only setup before the scoring action", () => {
  const weak = evidence();
  weak.playerDetectionCoverage = .50;
  weak.phaseEvidence.setup.ballCoverage = .40;
  weak.phaseEvidence.setup.directJointCoverage = .10;
  assert.deepEqual(assessNativeFrameAction(goal, weak), {
    usable: false,
    mode: "native_setup_evidence_incomplete",
  });
});

test("a verified locked native action survives annotation tracking failure", () => {
  const lockedShot = {
    eventType: "shot_off_target",
    selectionLocked: true,
    semanticVerified: true,
    actionComplete: true,
    keepDecision: "keep",
    ballVisible: true,
    mainPlayerVisible: true,
  };
  assert.equal(canRenderLockedNativeAction(lockedShot), true);
  assert.equal(canRenderLockedNativeAction({ ...lockedShot, ballVisible: false }), false);
  assert.equal(canRenderLockedNativeAction({ ...lockedShot, actionComplete: false }), false);
});

test("recovers one semantically verified native angle after all local detector repairs fail", () => {
  const candidates = [
    { ...goal, id: "live", storyId: "goal-1", selectionLocked: true, startTime: 10,
      trackingBrief: { payoffEvidence: { verified: true } } },
    { ...goal, id: "replay", storyId: "goal-1", selectionLocked: true, startTime: 20, isReplay: true,
      trackingBrief: { payoffEvidence: { verified: true } } },
  ];
  const usable = new Map([["live", false], ["replay", false]]);
  const recovered = recoverNativeFullFrameIncidents(candidates, new Map([["live", 80], ["replay", 60]]), usable);
  assert.equal(recovered.find((moment) => moment.id === "live").nativeFullFrameEvidence, true);
  assert.equal(recovered.find((moment) => moment.id === "live").playerHighlight, false);
  assert.equal(usable.get("live"), true);
  assert.deepEqual(assessNativeFrameAction(recovered[0], undefined), {
    usable: true,
    mode: "native_semantic_complete_action",
  });
});

test("does not use semantic native recovery when another local angle already passed", () => {
  const candidate = { ...goal, id: "live", storyId: "goal-1", selectionLocked: true,
    trackingBrief: { payoffEvidence: { verified: true } } };
  const usable = new Map([["live", true]]);
  const recovered = recoverNativeFullFrameIncidents([candidate], new Map([["live", 80]]), usable);
  assert.equal(recovered[0].nativeFullFrameEvidence, undefined);
});

test("does not recover an incident whose visible outcome was not semantically verified", () => {
  const candidate = { ...goal, id: "live", storyId: "goal-1", selectionLocked: true,
    trackingBrief: { payoffEvidence: null } };
  const usable = new Map([["live", false]]);
  const recovered = recoverNativeFullFrameIncidents([candidate], new Map([["live", 80]]), usable);
  assert.equal(recovered[0].nativeFullFrameEvidence, undefined);
  assert.equal(usable.get("live"), false);
});
