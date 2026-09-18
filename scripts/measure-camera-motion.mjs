import fs from "node:fs";
import { trackedPositionExpression } from "../local-processor/tracked-position.mjs";

const id = process.argv[2];
if (!id) throw new Error("Usage: node scripts/measure-camera-motion.mjs <job-id>");
const outputRoot = `local-data/outputs/${id}`;
const tracking = JSON.parse(fs.readFileSync(`${outputRoot}/tracking/tracking.json`, "utf8"));
const job = JSON.parse(fs.readFileSync(`local-data/jobs/${id}.json`, "utf8"));
const valueAt = (expression, time) => Function("t", "clip", "gte", `return ${expression};`)(
  time,
  (value, low, high) => Math.min(high, Math.max(low, value)),
  (left, right) => Number(left >= right),
);
const percentile = (values, portion) => {
  const ordered = values.toSorted((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * portion))] || 0;
};

const selected = job.moments.filter(item => item.selectedForFinalVideo);
const measuredMoments = selected.length ? selected : job.moments.filter(item => tracking.moments?.[item.id]);
for (const moment of measuredMoments) {
  if (moment.eventType === "celebration" || moment.storyPhase === "reaction") continue;
  const keyframes = tracking.moments?.[moment.id]?.keyframes || [];
  if (keyframes.length < 2) continue;
  const expression = trackedPositionExpression(keyframes, "cameraX", 0.5);
  const positions = [];
  for (let time = 0; time <= keyframes.at(-1).time; time += 1 / 30) {
    positions.push(valueAt(expression, time));
  }
  const velocity = positions.slice(1).map((position, index) => (position - positions[index]) * 30);
  const acceleration = velocity.slice(1).map((speed, index) => (speed - velocity[index]) * 30);
  let reversals = 0;
  for (let index = 1; index < velocity.length; index += 1) {
    if (Math.abs(velocity[index]) > 0.03 && Math.abs(velocity[index - 1]) > 0.03
        && Math.sign(velocity[index]) !== Math.sign(velocity[index - 1])) reversals += 1;
  }
  console.log(JSON.stringify({
    id: moment.id,
    expressionLength: expression.length,
    speedP95: Number(percentile(velocity.map(Math.abs), 0.95).toFixed(3)),
    accelerationP95: Number(percentile(acceleration.map(Math.abs), 0.95).toFixed(3)),
    reversals,
  }));
}
