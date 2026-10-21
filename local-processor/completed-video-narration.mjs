import { mapWithConcurrency } from './bounded-concurrency.mjs';

export const COMPLETED_VIDEO_NARRATION_VERSION = 1;
const words = text => String(text || '').trim().split(/\s+/u).filter(Boolean).length;

export function normalizeRecapResultEnding(content, matchContext) {
  const beats=content.contentBeats;
  if(!beats?.length || matchContext?.status!=='verified' || !matchContext.finalScore) return content;
  const last=beats.at(-1);
  const falseLink=/\s*[,;]\s*(?:seal(?:s|ed|ing)?|secur(?:es?|ed|ing)|clinch(?:es|ed|ing)?)\s+[^.!?]*(?:draw|result|points|win|victory)[.!?]?$/i;
  const falseSentence=/(?:^|(?<=[.!?])\s+)[^.!?]*\b(?:seal(?:s|ed|ing)?|secur(?:es?|ed|ing)|clinch(?:es|ed|ing)?)\b[^.!?]*(?:draw|result|points|win|victory)[.!?]?$/i;
  if(!falseLink.test(last.narration)&&!falseSentence.test(last.narration)) return content;
  const score=String(matchContext.finalScore).replace(/\s*[–—:]\s*/g,'-');
  if(!/^\d{1,2}\s*-\s*\d{1,2}$/.test(score))return content;
  const narration=falseLink.test(last.narration)
    ? last.narration.replace(falseLink,`. The match ends ${score}.`)
    : last.narration.replace(falseSentence,` The match ends ${score}.`).trim();
  const contentBeats=[...beats.slice(0,-1),{...last,narration}];
  const contentScript=contentBeats.map(beat=>beat.narration).join(' ');
  return {...content,contentBeats,contentScript,wordCount:words(contentScript)};
}

// The rendered cut clock, not an earlier duration estimate, owns narration.
export function renderedNarrationManifest(manifest, renderResult, measuredDuration) {
  const cuts = renderResult.synchronization;
  if (!Array.isArray(cuts) || cuts.length !== manifest.moments.length
    || !(measuredDuration > 0) || Math.abs(measuredDuration - renderResult.timelineDuration) > .12)
    throw new Error('The completed visual render disagrees with its scene clock.');
  const moments = manifest.moments.map((moment, index) => {
    const cut = cuts[index];
    if (cut.momentId !== moment.candidateId || !(cut.visualDuration > 0)
      || Math.abs(cut.visualStart - (index ? cuts[index-1].visualStart + cuts[index-1].visualDuration : 0)) > .002)
      throw new Error('The completed video must retain every locked scene in order.');
    const endTime = index === cuts.length - 1 ? measuredDuration : cut.visualStart + cut.visualDuration;
    return { ...moment, output: { startTime: cut.visualStart, endTime, duration: endTime - cut.visualStart } };
  });
  return { ...manifest, selectedDuration: measuredDuration, moments,
    completedVideoRendered: true, clockSource: 'rendered_video',
    narrationProductionVersion: COMPLETED_VIDEO_NARRATION_VERSION };
}

export function narrationSections(content, manifest) {
  const beats = new Map(content.contentBeats.map(beat => [beat.evidenceNeed, beat]));
  const sections = [];
  for (const scene of manifest.moments) {
    const beat = beats.get(scene.candidateId);
    if (!beat?.narration?.trim()) throw new Error(`Missing narration for rendered scene ${scene.candidateId}.`);
    const previous = sections.at(-1);
    // Only linked reaction support may share a take. Never carry a goal's
    // words into the next unrelated chance to conceal timing drift.
    if (previous && scene.storyId && previous.storyId === scene.storyId
      && ['celebration', 'reaction'].includes(scene.eventType)) {
      previous.ids.push(scene.candidateId);
      previous.narration += ` ${beat.narration.trim()}`;
      previous.endTime = scene.output.endTime;
    } else sections.push({ id: scene.candidateId, ids: [scene.candidateId], storyId: scene.storyId,
      startTime: scene.output.startTime, endTime: scene.output.endTime, narration: beat.narration.trim() });
  }
  return sections.map(section => ({ ...section, duration: section.endTime - section.startTime }));
}

// Word counts guide the first draft; actual audio decides whether it fits.
// A one-word difference must not cause three full-script rewrites.
export function narrationSlotBudgets(contract, measuredRate = 2.6) {
  const rate = Number.isFinite(measuredRate) && measuredRate >= .8 && measuredRate <= 5 ? measuredRate : 2.6;
  return contract.slots.map(slot => ({ candidateId: slot.candidateId,
    startTime: slot.startTime, endTime: slot.endTime,
    suggestedWords: Math.max(2, Math.floor((slot.endTime - slot.startTime) * rate * .90)),
    maximumSuggestedWords: Math.max(3, Math.floor((slot.endTime - slot.startTime) * rate)) }));
}

export async function recordTimedNarration(content, manifest, {
  record, rewrite, onProgress = async () => {}, concurrency = 2,
}) {
  let sections = narrationSections(content, manifest);
  const approved = new Map();
  // These are bounded LOCAL section corrections, never a whole-script/whole-
  // video retry. Valid takes stay cached and the visual master never changes.
  for (let pass = 0; pass < 3; pass++) {
    const pending = sections.filter(section => !approved.has(section.id));
    const takes = await mapWithConcurrency(pending, concurrency, async section => {
      const take = await record(section);
      if (!(take.duration > 0) || !take.path) throw new Error(`Empty voice recording for ${section.id}.`);
      await onProgress({ section, pass, measuredDuration: take.duration });
      return { ...section, ...take };
    });
    const overlong = [];
    for (const take of takes) {
      if (take.duration <= take.endTime - take.startTime - .04) approved.set(take.id, take);
      else overlong.push({ ...take,
        maximumWords: Math.max(1, Math.floor(words(take.narration) / take.duration * (take.endTime - take.startTime - .12) * .90)) });
    }
    if (!overlong.length) return sections.map(section => approved.get(section.id));
    if (pass === 2) {
      const error = new Error(`Only narration sections ${overlong.map(take => take.id).join(', ')} still need shorter wording; completed pictures and other voice takes are saved.`);
      error.code = 'NARRATION_SECTION_TIMING_PENDING';
      throw error;
    }
    const replacements = await rewrite(overlong);
    sections = sections.map(section => {
      if (!overlong.some(take => take.id === section.id)) return section;
      const narration = replacements[section.id];
      if (typeof narration !== 'string' || !narration.trim() || words(narration) >= words(section.narration))
        throw new Error(`The local timing correction must shorten only section ${section.id}.`);
      return { ...section, narration: narration.trim() };
    });
  }
}
