function simplifyShot(values, tolerance) {
  if (values.length <= 2) return values;
  const keep = new Set([0, values.length - 1]);
  const visit = (start, end) => {
    if (end <= start + 1) return;
    const first = values[start], last = values[end];
    const duration = Math.max(0.000001, last.time - first.time);
    let furthest = -1, error = tolerance;
    for (let index = start + 1; index < end; index += 1) {
      const progress = Math.min(1, Math.max(0, (values[index].time - first.time) / duration));
      const expected = first.value + (last.value - first.value) * progress;
      const currentError = Math.abs(values[index].value - expected);
      if (currentError > error) { error = currentError; furthest = index; }
    }
    if (furthest >= 0) {
      keep.add(furthest);
      visit(start, furthest);
      visit(furthest, end);
    }
  };
  visit(0, values.length - 1);
  return [...keep].sort((a, b) => a - b).map(index => values[index]);
}

function sparseControls(values, tolerance) {
  const output = [];
  let start = 0;
  for (let index = 1; index <= values.length; index += 1) {
    if (index < values.length && !values[index].cut) continue;
    const shot = simplifyShot(values.slice(start, index), tolerance);
    output.push(...shot.filter((_, shotIndex) => !output.length || shotIndex > 0));
    if (index < values.length) {
      output.push(values[index]);
      start = index;
    }
  }
  return output;
}

// Dense tracker samples are evidence. Rendering uses a small set of linear
// camera controls, preserving hard source cuts while removing sub-pixel target
// corrections that otherwise appear as shake after a 16:9-to-9:16 crop.
export function trackedPositionExpression(frames, field, fallback) {
  const ordered = frames.map(frame=>({time:Number(frame.time),value:Number(frame[field]),cut:Boolean(frame.sceneCut || frame.cameraCut)}))
    .filter(frame=>Number.isFinite(frame.time)&&Number.isFinite(frame.value)).sort((a,b)=>a.time-b.time);
  const unique = [...new Map(ordered.map(frame=>[frame.time,frame])).values()];
  const tolerance = field.startsWith("camera") ? 0.006 : 3;
  const values = sparseControls(unique, tolerance);
  if (!values.length) return Number(fallback).toFixed(6);
  const terms = [values[0].value.toFixed(6)];
  for (let i=1;i<values.length;i++) {
    const current=values[i-1], next=values[i], change=next.value-current.value;
    if (Math.abs(change)<0.0000005) continue;
    const progress=next.cut ? `gte(t,${next.time.toFixed(6)})` : `clip((t-${current.time.toFixed(6)})/${(next.time-current.time).toFixed(6)},0,1)`;
    terms.push(`(${change.toFixed(6)})*${progress}`);
  }
  // A balanced sum avoids FFmpeg's nesting limit without discarding keyframes.
  const sum=(lo,hi)=>hi-lo===1?terms[lo]:`(${sum(lo,Math.floor((lo+hi)/2))}+${sum(Math.floor((lo+hi)/2),hi)})`;
  return sum(0,terms.length);
}
