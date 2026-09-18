export async function mapWithConcurrency(items, requestedLimit, mapper) {
  const source = Array.from(items || []);
  if (!source.length) return [];
  const limit = Math.max(1, Math.min(source.length, Math.floor(Number(requestedLimit) || 1)));
  const results = new Array(source.length);
  let cursor = 0;
  async function worker() {
    while (cursor < source.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(source[index], index);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}
