import test from "node:test";
import assert from "node:assert/strict";
import { holdAndPanCamera, isActionHandoffCut } from "../local-processor/hold-pan-camera.mjs";

const samples = (count, make) => Array.from({ length: count }, (_, index) => ({
  time: index * .1, target: .5, low: .35, high: .65, ...make(index),
}));

test("camera stays exactly locked while the subject remains in the safe zone", () => {
  const path = holdAndPanCamera(samples(30, index => ({ target: .5 + Math.sin(index) * .025 })));
  assert.equal(new Set(path.map(value => value.toFixed(6))).size, 1);
});

test("one-frame detector excursions do not create camera movement", () => {
  const path = holdAndPanCamera(samples(30, index => index === 12 ? { low: .62, high: .70, target: .65 } : {}));
  assert.equal(new Set(path.map(value => value.toFixed(6))).size, 1);
});

test("a sustained safe-zone exit creates one slow uninterrupted pan", () => {
  const path = holdAndPanCamera(samples(45, index => index >= 12 ? { low: .58, high: .70, target: .62 } : {}));
  const moving = path.slice(1).map((value, index) => Math.abs(value - path[index]) > 1e-7);
  const starts = moving.filter((value, index) => value && !moving[index - 1]).length;
  assert.equal(starts, 1);
  const maximumStep = Math.max(...path.slice(1).map((value, index) => Math.abs(value - path[index])));
  assert.ok(maximumStep <= .008, `step ${maximumStep} was too fast`);
  assert.ok(path.at(-1) >= .58);
});

test("source cuts reset immediately instead of panning through unrelated space", () => {
  const items = samples(25, index => index === 12
    ? { cut: true, target: .72, low: .66, high: .80 }
    : index > 12 ? { target: .72, low: .66, high: .80 } : {});
  const path = holdAndPanCamera(items, { maximumCamera: .85 });
  assert.equal(path[11], .5);
  assert.equal(path[12], .72);
});

test("a shot opens on its first verified action instead of an empty semantic fallback", () => {
  const items = samples(20, index => index < 4
    ? { target: .2, low: .1, high: .9 }
    : { target: .62, low: .56, high: .68 });
  const path = holdAndPanCamera(items, { minimumCamera: .15, maximumCamera: .85, lookAhead: .8 });
  assert.equal(path[0], .62);
  assert.equal(path[3], .62);
});

test("a forward pass reverses the prior pan and reaches the receiver before the ball exits", () => {
  const items = samples(35, index => {
    if (index < 10) return { target: .38, low: .32, high: .46 };
    const progress = Math.min(1, (index - 10) / 8);
    const target = .38 + progress * .32;
    return { target, low: target - .06, high: target + .06 };
  });
  const path = holdAndPanCamera(items, {
    minimumCamera: .15, maximumCamera: .85, lookAhead: 1.3,
    persistence: .18, minimumHold: .45, postPanHold: .08,
    minimumPanDistance: .028, maximumSpeed: .20,
    minimumPanDuration: .45, maximumPanDuration: 2.4,
    arriveBeforeExit: true, constrainEachFrame: true,
  });
  for (let index = 10; index < items.length; index += 1) {
    assert.ok(path[index] >= items[index].low - 1e-9, `camera lagged the ball at ${items[index].time}s`);
    assert.ok(path[index] <= items[index].high + 1e-9, `camera ran ahead of the current action at ${items[index].time}s`);
  }
  assert.ok(path[18] >= .63, "camera did not complete the receiver handoff");
});

test("preferred action framing starts a pan without hard-clamping every detector sample", () => {
  const items = samples(30, index => index < 8 ? {
    target: .42, low: .36, high: .48, hardLow: .30, hardHigh: .56,
  } : {
    target: .64, low: .59, high: .69, hardLow: .50, hardHigh: .77,
  });
  const path = holdAndPanCamera(items, {
    minimumCamera: .15, maximumCamera: .85, lookAhead: 1.3,
    persistence: .18, minimumHold: .45, postPanHold: .08,
    minimumPanDistance: .028, maximumSpeed: .20,
    minimumPanDuration: .45, maximumPanDuration: 2.4,
    arriveBeforeExit: true, constrainEachFrame: true,
  });
  const maximumStep = Math.max(...path.slice(1).map((value, index) => Math.abs(value - path[index])));
  assert.ok(maximumStep < .07, `preferred-zone correction jumped by ${maximumStep}`);
  assert.ok(path.at(-1) >= .59, "camera did not settle on the receiving action");
});

test("an early football safe-zone breach respects the pan speed ceiling", () => {
  const items = samples(45, index => index < 8 ? {
    target: .40, low: .34, high: .48, hardLow: .28, hardHigh: .58,
  } : {
    target: .64, low: .58, high: .70, hardLow: .40, hardHigh: .82,
  });
  const path = holdAndPanCamera(items, {
    minimumCamera: .15, maximumCamera: .85, lookAhead: 1.8,
    persistence: .14, minimumHold: .42, postPanHold: .10,
    minimumPanDistance: .028, maximumSpeed: .12,
    minimumPanDuration: .75, maximumPanDuration: 2.8,
    arriveBeforeExit: false, constrainEachFrame: true,
  });
  const speeds = path.slice(1).map((value, index) => Math.abs(value - path[index]) / .1);
  assert.ok(Math.max(...speeds) <= .125, `pan exceeded its speed ceiling: ${Math.max(...speeds)}`);
  assert.ok(path.at(-1) >= .58, "early pan never reached the receiver safe zone");
});

test("a physically impossible ownership jump becomes a hard action cut", () => {
  const items = [
    { time: 1, cut: false, hasBall: false, cameraOwner: "hold" },
    { time: 1.2, cut: false, hasBall: true, cameraOwner: "ball" },
  ];
  assert.equal(isActionHandoffCut(items, [.28, .79], 1), true);
});

test("a normal football pan remains continuous", () => {
  const items = [
    { time: 1, cut: false, hasBall: true, cameraOwner: "ball" },
    { time: 1.2, cut: false, hasBall: true, cameraOwner: "ball" },
  ];
  assert.equal(isActionHandoffCut(items, [.48, .51], 1), false);
});
