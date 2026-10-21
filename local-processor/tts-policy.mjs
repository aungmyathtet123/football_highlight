// Provider content ceilings are bytes, not characters. Split only the voice
// request, never the locked visual edit or the approved narrative order.
export function splitNarrationForTts(text, maximumBytes = 3500) {
  const narration = String(text || '').trim().replace(/\s+/gu, ' ');
  if (!narration) return [];
  if (!Number.isInteger(maximumBytes) || maximumBytes < 4) throw new Error('Invalid TTS byte budget.');
  const chunks = [];
  let current = '';
  for (const sentence of narration.split(/(?<=[.!?])\s+/u)) {
    const units = Buffer.byteLength(sentence, 'utf8') <= maximumBytes ? [sentence] : sentence.split(' ');
    for (const unit of units) {
      if (Buffer.byteLength(unit, 'utf8') > maximumBytes)
        throw new Error('Narration contains a single word larger than the TTS request limit. Rewrite that word before recording.');
      const next = current ? `${current} ${unit}` : unit;
      if (Buffer.byteLength(next, 'utf8') > maximumBytes) { chunks.push(current); current = unit; }
      else current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function transientTtsError(error) {
  const message = String(error?.message || error);
  if (/billing|payment|API (?:has not been used|is disabled)|SERVICE_DISABLED|PERMISSION_DENIED|UNAUTHENTICATED|INVALID_ARGUMENT/i.test(message)) return false;
  const code = Number(error?.code ?? error?.status);
  return [4, 8, 10, 13, 14, 429, 500, 502, 503, 504].includes(code)
    || /RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|UNAVAILABLE|ECONNRESET|ETIMEDOUT|socket hang up|temporarily|no audio data/i.test(message);
}

export function ttsRetryDelay(attempt) {
  return Math.min(60000, 10000 * 2 ** Math.max(0, attempt - 1));
}
