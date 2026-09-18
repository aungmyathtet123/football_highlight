import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEditorialScore } from "../local-processor/score-normalization.mjs";

test("normalizes Gemini 0-10 rubric scores to percentages", () => {
  assert.equal(normalizeEditorialScore(8, 45), 80);
  assert.equal(normalizeEditorialScore(9.5, 45), 95);
});

test("preserves scores already expressed as percentages", () => {
  assert.equal(normalizeEditorialScore(82, 45), 82);
  assert.equal(normalizeEditorialScore(undefined, 45), 45);
});