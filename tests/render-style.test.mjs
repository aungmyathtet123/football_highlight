import test from "node:test";
import assert from "node:assert/strict";

import {
  activePlayerOverlayFrames,
  editorialGrade,
  naturalEditorialGradeFilters,
  sceneEntryTransition,
  soundEffectSource,
} from "../local-processor/render-video-v2.mjs";

test("football events receive distinct editorial grades", () => {
  assert.equal(editorialGrade({ eventType: "goal", storyPhase: "action" }), "goal_gold");
  assert.equal(editorialGrade({ eventType: "goal", storyPhase: "replay", isReplay: true }), "replay_blue");
  assert.equal(editorialGrade({ eventType: "celebration", storyPhase: "reaction" }), "warm");
  assert.equal(editorialGrade({ eventType: "normal_play", role: "build_up" }), "cool");
  assert.notDeepEqual(naturalEditorialGradeFilters("goal_gold"), naturalEditorialGradeFilters("replay_blue"));
});

test("event transitions reveal locally without overlapping the previous action", () => {
  const goal = sceneEntryTransition({ eventType: "goal", transitionIn: "flash" }, 1, 5);
  assert.equal(goal.kind, "white");
  assert.match(goal.filter, /fade=t=in:st=0/);
  assert.doesNotMatch(goal.filter, /xfade/);
});

test("goal cue is a single delayed three-layer analysis sting", () => {
  const source = soundEffectSource({ soundEffect: "goal" }, 2, 5, 1.25);
  assert.match(source, /goalCrowd2/);
  assert.match(source, /goalTone2/);
  assert.match(source, /goalImpact2/);
  assert.match(source, /amix=inputs=3/);
  assert.match(source, /adelay=1250\|1250/);
});

test("player ring is hidden unless ball carrier evidence is sustained", () => {
  const isolated = activePlayerOverlayFrames({ eventType: "goal" }, [
    { time: 0, markerVisible: 1, directBall: true, ballInFrame: true, playerInFrame: true, jointFit: 1, subjectConfidence: .9, playerTrackId: 3, playerCenterX: 400, playerCenterY: 500 },
  ]);
  assert.equal(isolated[0].analysisMarkerVisible, 0);

  const sustained = activePlayerOverlayFrames({ eventType: "goal" }, [0, .15, .3].map((time) => ({
    time, markerVisible: 1, directBall: true, ballInFrame: true, playerInFrame: true,
    jointFit: 1, subjectConfidence: .9, playerTrackId: 3, playerCenterX: 400, playerCenterY: 500,
  })));
  assert.deepEqual(sustained.map(frame => frame.analysisMarkerVisible), [1, 1, 1]);
});
