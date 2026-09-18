// A scene label or a percentage of its duration is not visible outcome evidence.
export function normalizePayoffEvidence(raw, eventType, sceneStart, sceneEnd, offset = 0) {
  if (!raw || raw.verified !== true || raw.eventType !== eventType) return null;
  const box = raw.targetBox;
  if (!Array.isArray(box) || box.length !== 4 || !box.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)
    || box[0] >= box[2] || box[1] >= box[3]) return null;
  if (![raw.startTime, raw.endTime].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const startTime = Math.max(sceneStart, raw.startTime + offset);
  const endTime = Math.min(sceneEnd, raw.endTime + offset);
  if (endTime - startTime < 0.5) return null;
  return { verified: true, eventType, startTime, endTime, targetBox: box };
}

export function verifiedPayoffWindow(moment, tracked, playbackRate = 1, freeze = { duration: 0, outputTime: 0 }) {
  const evidence = normalizePayoffEvidence(moment.trackingBrief?.payoffEvidence, moment.eventType, moment.startTime, moment.endTime);
  if (!evidence || !(playbackRate > 0)) return null;
  const start = evidence.startTime - moment.startTime;
  const end = evidence.endTime - moment.startTime;
  const box = evidence.targetBox;
  let run = [];
  for (const frame of tracked?.keyframes || []) {
    const crop = frame.cropBox;
    const valid = Number.isFinite(frame.time) && frame.time >= start && frame.time <= end
      && frame.directBall === true && frame.ballInFrame === true && frame.ballConfidence >= 0.12
      && Array.isArray(crop) && crop.length === 4 && crop.every(Number.isFinite)
      && crop[0] <= box[0] && crop[1] <= box[1] && crop[2] >= box[2] && crop[3] >= box[3];
    if (!valid) { run = []; continue; }
    if (frame.sceneCut || (run.length && (frame.time - run.at(-1).time > 0.16 || frame.time <= run.at(-1).time))) run = [];
    run.push(frame);
    if (run.at(-1).time - run[0].time < 0.5) continue;
    const retime = (t) => t / playbackRate + (freeze.duration > 0 && t / playbackRate >= freeze.outputTime ? freeze.duration : 0);
    // Only expose the interval actually checked; never extend the caption over
    // subsequent walking players or an unchecked camera cut.
    return { start: retime(run[0].time), end: retime(run.at(-1).time), verified: true };
  }
  return null;
}
