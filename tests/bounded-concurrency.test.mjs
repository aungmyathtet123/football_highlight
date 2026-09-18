import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency } from "../local-processor/bounded-concurrency.mjs";

test("bounded worker pool preserves result order and never exceeds its limit", async () => {
  let active = 0;
  let maximum = 0;
  const results = await mapWithConcurrency([40, 5, 20, 1, 10], 2, async (delay, index) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, delay));
    active -= 1;
    return index * 2;
  });
  assert.deepEqual(results, [0, 2, 4, 6, 8]);
  assert.equal(maximum, 2);
});

test("bounded worker pool treats invalid limits as one worker", async () => {
  const order = [];
  await mapWithConcurrency([1, 2, 3], 0, async value => {
    order.push("start-" + value);
    await Promise.resolve();
    order.push("end-" + value);
  });
  assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
});
