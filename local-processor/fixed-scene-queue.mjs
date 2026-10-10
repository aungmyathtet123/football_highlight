export const FIXED_SCENE_QUEUE_VERSION = 1;
export const LIVE_FIRST_SELECTION_POLICY = 'first_complete_live';
export const sourceTimelineStart = scene => Number(scene.sourceReselection?.previousStart ?? scene.startTime);

export function fixedRenderSceneQueue(candidates) {
  const locked=candidates.filter(scene=>scene.selectionLocked===true && scene.fixedSceneQueueVersion===1);
  if(!locked.length) return null;
  if(locked.some(scene=>scene.selectedForFinalVideo!==true))
    throw new Error('A selected split scene was disabled before rendering. Restore its verified queue entry.');
  return [...locked].sort((a,b)=>Number(a.editOrder??Number.MAX_SAFE_INTEGER)
    -Number(b.editOrder??Number.MAX_SAFE_INTEGER)||sourceTimelineStart(a)-sourceTimelineStart(b));
}

// Step 1 is the only owner of source selection. Tracking may change positions,
// not scene IDs, source boundaries or the selected incident angle.
export function fixedSceneQueue(candidates) {
  const scenes = candidates.filter(scene => scene.selectionLocked === true)
    .sort((a, b) => sourceTimelineStart(a) - sourceTimelineStart(b))
    .map((scene, index) => ({ id: String(scene.id), index,
      storyId: String(scene.storyId || scene.id), eventType: scene.eventType,
      startTime: Number(scene.startTime), endTime: Number(scene.endTime) }));
  if (!scenes.length || new Set(scenes.map(scene => scene.id)).size !== scenes.length
    || scenes.some(scene => !scene.id || !Number.isFinite(scene.startTime)
      || !Number.isFinite(scene.endTime) || scene.endTime <= scene.startTime))
    throw new Error('The split scene queue requires unique IDs and complete source intervals.');
  return { version: FIXED_SCENE_QUEUE_VERSION, selectionPolicy: LIVE_FIRST_SELECTION_POLICY,
    trackingOrder: 'one_scene_at_a_time', scenes };
}

export function assertFixedSceneQueue(queue, candidates, { requirePassed = false } = {}) {
  const actual = candidates.filter(scene => scene.selectionLocked === true);
  const byId = new Map(actual.map(scene => [String(scene.id), scene]));
  const expected = new Set(queue.scenes.map(scene => scene.id));
  if (byId.size !== actual.length || actual.length !== expected.size
    || actual.some(scene => !expected.has(String(scene.id))))
    throw new Error('Tracking changed the split scene list. Restore the saved queue; do not select another angle.');
  const pending = [];
  for (const slot of queue.scenes) {
    const scene = byId.get(slot.id);
    if (!scene || Math.abs(Number(scene.startTime) - slot.startTime) > 1e-6
      || Math.abs(Number(scene.endTime) - slot.endTime) > 1e-6)
      throw new Error(`Tracking changed split scene ${slot.id}'s source interval.`);
    if (scene.trackingPassed !== true) pending.push(slot.id);
  }
  if (requirePassed && pending.length) {
    const error=new Error(`The saved split scene queue still needs verified keyframes for: ${pending.join(', ')}. No scene was removed or replaced; narration has not started.`);
    // Every pending crop has already been evaluated. Re-entering the entire
    // phase with the same saved verdict is not a repair and cannot progress.
    error.code='FIXED_SCENE_FRAMING_PENDING';
    throw error;
  }
  return { total: queue.scenes.length, passed: queue.scenes.length - pending.length, pending };
}
