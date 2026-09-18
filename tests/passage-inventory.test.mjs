import test from "node:test";
import assert from "node:assert/strict";
import {
  analysisProxyWindows,
  buildBroadcastShotInventory,
  inventoryForExcerpt,
  passageFitsShot,
  passageFitsShotSequence,
  scheduleIncidentGroupsForTracking,
} from "../local-processor/passage-inventory.mjs";

test("does not create an overlap-only Gemini tail excerpt", () => {
  assert.deepEqual(analysisProxyWindows(529.107, 180, 4), [
    { startTime: 0, duration: 180 },
    { startTime: 176, duration: 180 },
    { startTime: 352, duration: 177.107 },
  ]);
});

test("keeps a tail excerpt when it contains source time beyond the overlap", () => {
  assert.deepEqual(analysisProxyWindows(538, 180, 4), [
    { startTime: 0, duration: 180 },
    { startTime: 176, duration: 180 },
    { startTime: 352, duration: 180 },
    { startTime: 528, duration: 10 },
  ]);
});

test("builds a stable complete broadcast-shot ledger", () => {
  const shots = buildBroadcastShotInventory([
    { startTime: 0, endTime: 6, startFrame: 0, endFrame: 150 },
    { startTime: 6, endTime: 14 },
  ], 14);
  assert.deepEqual(shots.map(({ shotId, startTime, endTime }) => ({ shotId, startTime, endTime })), [
    { shotId: "shot-0001", startTime: 0, endTime: 6 },
    { shotId: "shot-0002", startTime: 6, endTime: 14 },
  ]);
});

test("projects source shots into excerpt-relative time", () => {
  const inventory = buildBroadcastShotInventory([{ startTime: 8, endTime: 16 }, { startTime: 16, endTime: 21 }], 30);
  assert.deepEqual(inventoryForExcerpt(inventory, { startTime: 10, duration: 8 }).map(({ shotId, startTime, endTime }) => ({ shotId, startTime, endTime })), [
    { shotId: "shot-0001", startTime: 0, endTime: 6 },
    { shotId: "shot-0002", startTime: 6, endTime: 8 },
  ]);
});

test("tracking schedule always includes goals and keeps reserves", () => {
  const groups = [
    [{ id: "goal", eventType: "goal", startTime: 90, endTime: 98 }],
    [{ id: "shot", eventType: "shot_on_target", startTime: 10, endTime: 20 }],
    [{ id: "build", eventType: "normal_play", startTime: 30, endTime: 40 }],
  ];
  const scheduled = scheduleIncidentGroupsForTracking(groups, 10, 1);
  assert.ok(scheduled.primary.some((group) => group[0].id === "goal"));
  assert.equal(scheduled.primary.length, 2);
  assert.equal(scheduled.reserve.length, 1);
});

test("passages cannot escape their declared broadcast shot", () => {
  const shot = { shotId: "shot-0002", startTime: 6, endTime: 14 };
  assert.equal(passageFitsShot({ shotId: "shot-0002", startTime: 7, endTime: 13 }, shot), true);
  assert.equal(passageFitsShot({ shotId: "shot-0002", startTime: 5, endTime: 13 }, shot), false);
});
test("complete actions may span only consecutive declared broadcast shots", () => {
  const shots = [
    { shotId: "shot-0001", startTime: 0, endTime: 3 },
    { shotId: "shot-0002", startTime: 3, endTime: 5 },
    { shotId: "shot-0003", startTime: 5, endTime: 8 },
  ];
  assert.equal(passageFitsShotSequence({ shotIds: ["shot-0001", "shot-0002"], startTime: 1, endTime: 5 }, shots), true);
  assert.equal(passageFitsShotSequence({ shotIds: ["shot-0001", "shot-0003"], startTime: 1, endTime: 7 }, shots), false);
  assert.equal(passageFitsShotSequence({ shotId: "shot-0002", startTime: 3.2, endTime: 4.8 }, shots), true);
});
