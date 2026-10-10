// Explicit lifecycle migration, not a capacity-error fallback. Google recommends
// 3.8 Flash for both retiring Flash versions. Keep other model choices unchanged.
export function currentGeminiModel(model) {
  const id = String(model || '').trim();
  return ['gemini-3.6-flash', 'gemini-3.7-flash'].includes(id)
    ? 'gemini-3.8-flash' : model;
}

export function migrateRetiringGeminiModels(env = process.env) {
  const changes = [];
  for (const key of ['GEMINI_MODEL', 'GEMINI_DISCOVERY_MODEL', 'GEMINI_SCRIPT_MODEL', 'GEMINI_KEYFRAME_MODEL']) {
    const before = env[key];
    const after = currentGeminiModel(before);
    if (before !== after) {
      env[key] = after;
      changes.push({ key, before, after });
    }
  }
  return changes;
}
