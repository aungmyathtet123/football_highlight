export function normalizeEditorialScore(value, fallback = 0) {
  const parsed = Number(value);
  const fallbackNumber = Number(fallback);
  let score = Number.isFinite(parsed) ? parsed : Number.isFinite(fallbackNumber) ? fallbackNumber : 0;
  // Multimodal models commonly return rubric scores on 0-10 even when asked
  // for 0-100. Preserve true percentages above 10 and normalize the smaller scale.
  if (score > 0 && score <= 10) score *= 10;
  return Math.round(Math.min(100, Math.max(0, score)));
}