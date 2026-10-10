// The editor owns scene IDs, order and timing. The writer owns only the words.
// Never repair an arbitrary draft by assigning its claims to different footage.
export const LOCKED_NARRATION_VERSION = 1;

export function lockedNarrationContract(candidates, manifest) {
  if (!manifest?.authoritativeForNarration || !(manifest.selectedDuration > 0))
    throw new Error('Narration requires a reviewed visual timeline with measured duration.');
  const byId = new Map(candidates.map(scene => [String(scene.id), scene]));
  if (!byId.size || byId.size !== candidates.length || byId.has(''))
    throw new Error('Narration scenes need unique, nonempty IDs.');
  const slots = (manifest.moments || []).filter(moment => byId.has(String(moment.candidateId)))
    .map((moment, index) => ({ candidateId: String(moment.candidateId), beatId: `beat-${index + 1}`,
      role: byId.get(String(moment.candidateId)).role || 'analysis',
      startTime: Number(moment.output?.startTime), endTime: Number(moment.output?.endTime),
      visualClaim: moment.visualClaim, verifiedIdentity: moment.verifiedIdentity || null }));
  if (slots.length !== byId.size || new Set(slots.map(slot => slot.candidateId)).size !== byId.size
    || slots.some((slot, index) => !Number.isFinite(slot.startTime) || !Number.isFinite(slot.endTime)
      || slot.startTime < 0 || slot.endTime <= slot.startTime || slot.endTime > manifest.selectedDuration + .001
      || index > 0 && slot.startTime < slots[index - 1].startTime))
    throw new Error('Narration scene IDs or timing disagree with the reviewed visual timeline.');
  return { version: LOCKED_NARRATION_VERSION, selectedDuration: manifest.selectedDuration, slots };
}

export function lockedNarrationResponseSchema(contract) {
  const sceneSchema = { type: 'object', required: ['narration', 'captionText'],
    properties: { narration: { type: 'string' }, captionText: { type: 'string' } } };
  return { type: 'object', required: ['title', 'editorialThesis', 'storyQuestion', 'storyAnswer', 'sceneNarration'],
    properties: { title: { type: 'string' }, editorialThesis: { type: 'string' }, contentAngle: { type: 'string' },
      storyQuestion: { type: 'string' }, storyAnswer: { type: 'string' },
      sceneNarration: { type: 'object', required: contract.slots.map(slot => slot.candidateId),
        properties: Object.fromEntries(contract.slots.map(slot => [slot.candidateId, sceneSchema])) } } };
}

export function projectLockedNarration(raw, contract) {
  const written = raw?.sceneNarration;
  const expected = new Set(contract.slots.map(slot => slot.candidateId));
  if (!written || typeof written !== 'object' || Array.isArray(written)
    || Object.keys(written).some(id => !expected.has(id))
    || contract.slots.some(slot => !Object.hasOwn(written, slot.candidateId)
      || typeof written[slot.candidateId]?.narration !== 'string' || !written[slot.candidateId].narration.trim()
      || typeof written[slot.candidateId]?.captionText !== 'string'))
    throw new Error('Locked narration must supply nonempty words for every exact reviewed scene, without extra IDs.');
  return { ...raw, contentBeats: contract.slots.map(slot => ({ beatId: slot.beatId,
    evidenceNeed: slot.candidateId, role: slot.role,
    narration: written[slot.candidateId].narration, captionText: written[slot.candidateId].captionText })) };
}
