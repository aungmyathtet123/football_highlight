// Google now recommends omitting sampling overrides for all Gemini 3.x models.
// Keep schemas, evidence, effort, deadlines and safety settings unchanged.
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/migrate
export function geminiGenerationConfig(model, config = {}) {
  if (!/^gemini-3(?:\.|-)/.test(String(model))) return config;
  const {temperature, topP, topK, ...compatible} = config;
  const frames=compatible.responseSchema?.properties?.frames;
  if(model==='gemini-3.5-flash' && frames?.items?.properties?.ball?.properties?.top
    && compatible.responseSchema?.properties?.focusNotes) {
    // A real Flash MEDIUM coordinate request spent 30,429 tokens reasoning,
    // leaving only 2,324 tokens of a 32k budget for 80 rows. Reserve enough
    // output space on its FIRST request, instead of rewatching after truncation.
    // This is a ceiling, not a target. Reasoning effort/evidence stay unchanged.
    return {...compatible,maxOutputTokens:Math.max(Number(compatible.maxOutputTokens)||0,65536)};
  }
  return compatible;
}
