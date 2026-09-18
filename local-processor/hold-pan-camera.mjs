const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function timeOf(item, fallback = 0) {
  const value = Number(item?.time ?? item?.record?.time);
  return Number.isFinite(value) ? value : fallback;
}

function persistentExit(items, start, camera, lookAhead, persistence, stopAtOwnershipChange = false) {
  const startTime = timeOf(items[start]);
  const startingOwner = items[start]?.cameraOwner;
  let direction = 0;
  let breachStart = null;
  let lastTime = null;
  let samples = 0;
  let destination = camera;
  for (let index = start + 1; index < items.length; index += 1) {
    const item = items[index];
    const time = timeOf(item, startTime);
    if (item.cut || time - startTime > lookAhead) break;
    if (stopAtOwnershipChange && startingOwner && item.cameraOwner !== startingOwner) break;
    const low = Number(item.low), high = Number(item.high);
    if (!Number.isFinite(low) || !Number.isFinite(high)) continue;
    const nextDirection = camera < low ? 1 : camera > high ? -1 : 0;
    if (!nextDirection) {
      direction = 0; breachStart = null; lastTime = null; samples = 0; destination = camera;
      continue;
    }
    if (direction && nextDirection !== direction) {
      direction = 0; breachStart = null; lastTime = null; samples = 0; destination = camera;
      continue;
    }
    direction = nextDirection;
    breachStart ??= time;
    lastTime = time;
    samples += 1;
    destination = direction > 0 ? Math.max(destination, low) : Math.min(destination, high);
    if (samples >= 3 && lastTime - breachStart >= persistence) {
      return { destination, deadline: breachStart };
    }
  }
  return null;
}

function openingCamera(items, start, fallback, minimumCamera, maximumCamera, lookAhead) {
  const startTime = timeOf(items[start]);
  let low = minimumCamera, high = maximumCamera;
  const targets = [];
  for (let index = start; index < items.length; index += 1) {
    const item = items[index];
    const time = timeOf(item, startTime);
    if (index > start && (item.cut || time - startTime > lookAhead)) break;
    const itemLow = Number(item.low), itemHigh = Number(item.high);
    if (!Number.isFinite(itemLow) || !Number.isFinite(itemHigh)) continue;
    // Ignore unconstrained detector gaps. The first verified player/ball or
    // ball-flight interval should establish the shot opening, not a semantic
    // fallback that may point at empty grass.
    if (itemHigh - itemLow >= (maximumCamera - minimumCamera) * .92) continue;
    const nextLow = Math.max(low, itemLow), nextHigh = Math.min(high, itemHigh);
    if (nextLow <= nextHigh) {
      low = nextLow;
      high = nextHigh;
      const target = Number(item.target);
      if (Number.isFinite(target)) targets.push(target);
    }
  }
  if (!targets.length) return clamp(fallback, minimumCamera, maximumCamera);
  targets.sort((left, right) => left - right);
  return clamp(targets[Math.floor(targets.length / 2)], low, high);
}

// Dense detections are evidence, not camera commands. Hold each broadcast
// shot while its action remains visible; create one slow pan only after a
// persistent safe-zone exit. A pan owns the crop until it has completed.
export function holdAndPanCamera(items, options = {}) {
  if (!Array.isArray(items) || !items.length) return [];
  const minimumCamera = Number(options.minimumCamera ?? 0);
  const maximumCamera = Number(options.maximumCamera ?? 1);
  const lookAhead = Number(options.lookAhead ?? 0.85);
  const persistence = Number(options.persistence ?? 0.28);
  const minimumHold = Number(options.minimumHold ?? 0.55);
  const postPanHold = Number(options.postPanHold ?? minimumHold);
  const minimumPanDistance = Number(options.minimumPanDistance ?? 0.032);
  const maximumSpeed = Number(options.maximumSpeed ?? 0.075);
  const durationScale = Number(options.durationScale ?? 1.5);
  const minimumPanDuration = Number(options.minimumPanDuration ?? 0.80);
  const maximumPanDuration = Number(options.maximumPanDuration ?? 1.80);
  const arriveBeforeExit = options.arriveBeforeExit === true;
  const constrainEachFrame = options.constrainEachFrame === true;
  const stopAtOwnershipChange = options.stopAtOwnershipChange === true;
  const output = [];
  let camera = openingCamera(
    items, 0, Number(items[0].target ?? 0.5), minimumCamera, maximumCamera, lookAhead,
  );
  let pan = null;
  let lockedUntil = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const time = timeOf(item, index ? timeOf(items[index - 1]) : 0);
    if (index === 0 || item.cut) {
      camera = openingCamera(
        items, index, Number(item.target ?? camera), minimumCamera, maximumCamera, lookAhead,
      );
      pan = null;
      lockedUntil = time + minimumHold;
      output.push(camera);
      continue;
    }
    if (pan) {
      if (time >= pan.end) {
        camera = pan.to;
        // A completed pan may be followed immediately by a pass in the other
        // direction. Do not impose the opening hold again and make the camera
        // chase the receiver after the football has already arrived.
        lockedUntil = pan.end + postPanHold;
        pan = null;
      } else {
        const progress = clamp((time - pan.start) / Math.max(0.001, pan.end - pan.start), 0, 1);
        const eased = progress * progress * (3 - 2 * progress);
        camera = pan.from + (pan.to - pan.from) * eased;
      }
    }
    if (!pan && time >= lockedUntil) {
      const exit = persistentExit(items, index, camera, lookAhead, persistence, stopAtOwnershipChange);
      if (exit) {
        const destination = clamp(exit.destination, minimumCamera, maximumCamera);
        const distance = Math.abs(destination - camera);
        if (distance >= minimumPanDistance) {
          let duration = clamp(durationScale * distance / Math.max(0.001, maximumSpeed), minimumPanDuration, maximumPanDuration);
          if (arriveBeforeExit && Number.isFinite(exit.deadline)) {
            duration = Math.min(duration, Math.max(minimumPanDuration, exit.deadline - time + .08));
          }
          pan = { start: time, end: time + duration, from: camera, to: destination };
        }
      }
    }
    if (constrainEachFrame) {
      // Follow the editorial safe zone with a planned pan, but only use the
      // wider hard limits for emergency per-frame correction. Using the same
      // narrow interval for both caused visible detector-driven shaking.
      const low = Number(item.hardLow ?? item.low), high = Number(item.hardHigh ?? item.high);
      const fullRange = maximumCamera - minimumCamera;
      if (Number.isFinite(low) && Number.isFinite(high) && low <= high && high - low < fullRange * .92) {
        camera = clamp(camera, low, high);
      }
    }
    output.push(clamp(camera, minimumCamera, maximumCamera));
  }
  return output;
}

// A crop cannot physically travel a large fraction of the source width in a
// single tracker interval without looking like a whip. When that discontinuity
// also coincides with an evidence/ownership handoff, it is a broadcast-angle
// change (or an equally discontinuous detector handoff) and must render as a
// frame-exact cut rather than an invented pan through unrelated grass.
export function isActionHandoffCut(items, cameraPath, index) {
  if (!Array.isArray(items) || !Array.isArray(cameraPath) || index <= 0 || index >= items.length) return false;
  const current = items[index], previous = items[index - 1];
  if (current?.cut) return true;
  const dt = timeOf(current) - timeOf(previous);
  const distance = Math.abs(Number(cameraPath[index]) - Number(cameraPath[index - 1]));
  if (!(dt > 0 && dt <= .26) || !Number.isFinite(distance)) return false;
  const evidenceHandoff = current?.hasBall !== previous?.hasBall
    || current?.cameraOwner !== previous?.cameraOwner;
  return distance >= .28 || (distance >= .14 && evidenceHandoff);
}
