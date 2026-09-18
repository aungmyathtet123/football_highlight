const DECISIVE_EVENTS = new Set(["goal", "disallowed_goal", "offside", "var", "penalty"]);

export function analysisProxyWindows(sourceDuration, chunkSeconds = 180, overlapSeconds = 4) {
  const duration = Math.max(0, Number(sourceDuration) || 0);
  const chunk = Math.max(1, Number(chunkSeconds) || 180);
  const overlap = Math.max(0, Math.min(chunk - 0.001, Number(overlapSeconds) || 0));
  const step = Math.max(0.001, chunk - overlap);
  const windows = [];
  for (let startTime = 0; startTime < duration - 0.05; startTime += step) {
    const remaining = duration - startTime;
    // The previous chunk already contains an overlap-only tail. Sending that
    // same one- or two-second fragment as another Gemini video cannot expose
    // a new complete football action and used to create an endless Resume
    // loop when the model correctly returned an empty inventory.
    if (windows.length && remaining <= overlap + 0.05) break;
    windows.push({
      startTime: Number(startTime.toFixed(3)),
      duration: Number(Math.min(chunk, remaining).toFixed(3)),
    });
  }
  return windows;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function buildBroadcastShotInventory(shots, sourceDuration) {
  const duration = Math.max(0, Number(sourceDuration) || 0);
  return (Array.isArray(shots) ? shots : []).flatMap((shot, index) => {
    const rawStart = finite(shot?.startTime);
    const rawEnd = finite(shot?.endTime);
    if (rawStart === undefined || rawEnd === undefined) return [];
    const startTime = Math.max(0, Math.min(duration, rawStart));
    const endTime = Math.max(startTime, Math.min(duration, rawEnd));
    if (endTime - startTime < 0.25) return [];
    return [{
      shotId: `shot-${String(index + 1).padStart(4, "0")}`,
      startTime: Number(startTime.toFixed(3)),
      endTime: Number(endTime.toFixed(3)),
      duration: Number((endTime - startTime).toFixed(3)),
      startFrame: finite(shot?.startFrame),
      endFrame: finite(shot?.endFrame),
    }];
  });
}

export function inventoryForExcerpt(inventory, excerpt) {
  const excerptStart = Number(excerpt?.startTime) || 0;
  const excerptEnd = excerptStart + (Number(excerpt?.duration) || 0);
  return (Array.isArray(inventory) ? inventory : []).flatMap((shot) => {
    const startTime = Math.max(Number(shot.startTime), excerptStart);
    const endTime = Math.min(Number(shot.endTime), excerptEnd);
    if (endTime - startTime < 0.25) return [];
    return [{
      shotId: shot.shotId,
      startTime: Number((startTime - excerptStart).toFixed(3)),
      endTime: Number((endTime - excerptStart).toFixed(3)),
      duration: Number((endTime - startTime).toFixed(3)),
      sourceStartTime: startTime,
      sourceEndTime: endTime,
    }];
  });
}

function groupDuration(group) {
  const intervals = group
    .map((moment) => [Number(moment.startTime), Number(moment.endTime)])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let active;
  for (const interval of intervals) {
    if (!active || interval[0] >= active[1]) {
      total += interval[1] - interval[0];
      active = interval;
      continue;
    }
    if (interval[1] > active[1]) {
      total += interval[1] - active[1];
      active[1] = interval[1];
    }
  }
  return total;
}

export function scheduleIncidentGroupsForTracking(groups, requiredDuration, bufferRatio = 1.45) {
  const ranked = Array.isArray(groups) ? groups : [];
  const required = Math.max(0, Number(requiredDuration) || 0);
  const target = required * Math.max(1, Number(bufferRatio) || 1);
  const mandatory = ranked.filter((group) => group.some((moment) => DECISIVE_EVENTS.has(String(moment.eventType))));
  const chosen = new Set(mandatory);
  let estimatedDuration = mandatory.reduce((sum, group) => sum + groupDuration(group), 0);
  for (const group of ranked) {
    if (chosen.has(group)) continue;
    if (estimatedDuration >= target) break;
    chosen.add(group);
    estimatedDuration += groupDuration(group);
  }
  const primary = ranked.filter((group) => chosen.has(group));
  const reserve = ranked.filter((group) => !chosen.has(group));
  return { primary, reserve, estimatedDuration, targetDuration: target };
}

export function passageFitsShot(passage, shot, tolerance = 0.08) {
  if (!passage || !shot || String(passage.shotId || "") !== String(shot.shotId || "")) return false;
  const start = Number(passage.startTime);
  const end = Number(passage.endTime);
  return Number.isFinite(start) && Number.isFinite(end) && end > start
    && start >= Number(shot.startTime) - tolerance
    && end <= Number(shot.endTime) + tolerance;
}
export function passageFitsShotSequence(passage, shots, tolerance = 0.08) {
  const declaredIds = Array.isArray(passage?.shotIds) && passage.shotIds.length
    ? passage.shotIds.map(String)
    : [String(passage?.shotId || "")];
  const ledger = Array.isArray(shots) ? shots : [];
  const indexes = declaredIds.map((id) => ledger.findIndex((shot) => String(shot.shotId) === id));
  if (!declaredIds[0] || indexes.some((index) => index < 0)) return false;
  if (new Set(declaredIds).size !== declaredIds.length) return false;
  if (indexes.some((index, position) => position > 0 && index !== indexes[position - 1] + 1)) return false;
  const first = ledger[indexes[0]];
  const last = ledger[indexes[indexes.length - 1]];
  const start = Number(passage.startTime);
  const end = Number(passage.endTime);
  return Number.isFinite(start) && Number.isFinite(end) && end > start
    && start >= Number(first.startTime) - tolerance
    && end <= Number(last.endTime) + tolerance;
}
