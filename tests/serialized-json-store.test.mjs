import assert from "node:assert/strict";
import test from "node:test";
import { createSerializedJsonStore } from "../local-processor/serialized-json-store.mjs";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("serializes concurrent writes for the same key and uses unique temp files", async () => {
  const releaseFirstWrite = deferred();
  const writes = [];
  const moves = [];
  let unique = 0;
  const save = createSerializedJsonStore("C:\\jobs", {
    processId: 42,
    uniqueId: () => `unique-${++unique}`,
    write: async (path, value) => {
      writes.push({ path, value });
      if (writes.length === 1) await releaseFirstWrite.promise;
    },
    move: async (from, to) => { moves.push({ from, to }); },
    remove: async () => undefined,
  });

  const first = save("job-1", { progress: 1 });
  const second = save("job-1", { progress: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 1);

  releaseFirstWrite.resolve();
  await Promise.all([first, second]);

  assert.equal(writes.length, 2);
  assert.equal(moves.length, 2);
  assert.notEqual(writes[0].path, writes[1].path);
  assert.deepEqual(moves.map(entry => entry.to), ["C:\\jobs\\job-1.json", "C:\\jobs\\job-1.json"]);
});

test("retries transient Windows rename errors", async () => {
  let moveAttempts = 0;
  const waits = [];
  const save = createSerializedJsonStore("C:\\jobs", {
    processId: 42,
    uniqueId: () => "one",
    write: async () => undefined,
    move: async () => {
      moveAttempts += 1;
      if (moveAttempts < 3) throw Object.assign(new Error("locked"), { code: "EPERM" });
    },
    remove: async () => undefined,
    sleep: async milliseconds => { waits.push(milliseconds); },
  });

  await save("job-2", { stage: "processing" });
  assert.equal(moveAttempts, 3);
  assert.deepEqual(waits, [25, 50]);
});