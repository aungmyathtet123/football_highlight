// Fail over transport failures only. A negative visual verdict, malformed JSON,
// or failed scene contract is NOT a reason to shop for a more permissive model.
const supported = new Set(['gemini-3.1-pro-preview', 'gemini-3.8-flash', 'gemini-3.5-flash']);
const responseProvenance = new WeakMap();
const parseModels = value => String(value || '').split(',').map(x => x.trim()).filter(Boolean);

export function geminiFailoverModels(primary, env = process.env, label = '') {
  if (env.GEMINI_MODEL_FAILOVER === 'false' || !supported.has(primary)) return [primary];
  // Precise framing retains its explicit qualified pool. Match the workload
  // as well as the configured primary: a separate crop-review model must not
  // accidentally inherit the general-purpose model pool. No Lite fallback.
  const framing = primary === (env.GEMINI_KEYFRAME_MODEL || env.GEMINI_MODEL)
    || primary === env.GEMINI_FRAMING_REVIEW_MODEL
    || /hybrid rendered crop|hybrid crop outcome|(?:video|visual) keyframes/i.test(label);
  const backups = framing ? parseModels(env.GEMINI_FRAMING_FAILOVER_MODELS ?? 'gemini-3.5-flash,gemini-3.1-pro-preview')
    : parseModels(env.GEMINI_FAILOVER_MODELS ?? 'gemini-3.5-flash,gemini-3.8-flash,gemini-3.1-pro-preview');
  return [...new Set([primary, ...backups.filter(model => supported.has(model)
    && (!framing || model!=='gemini-3.8-flash'))])];
}

export function chooseGeminiFailoverModel(models, status, now = Date.now(), excluded = new Set()) {
  const eligible = models.filter(model => !excluded.has(model));
  if (!eligible.length) throw new Error('No eligible Gemini model remains for this request');
  const deadlines = eligible.map(model => ({model, at: Number(status(model)?.nextRequestAt) || 0}));
  return deadlines.find(row => row.at <= now)?.model
    || deadlines.reduce((first, row) => row.at < first.at ? row : first).model;
}

export function geminiFailoverCooldown(delayMs, hasBackup) {
  // Circuit breaker on the rejected MODEL, not a fixed delay on healthy calls.
  // Avoid probing the same busy endpoint again while its backup is working.
  return Math.max(Number(delayMs) || 0, hasBackup ? 60000 : 0);
}

export function geminiGenerationProvenance(primary, actual, response) {
  return {requestedModel: primary, actualModel: actual,
    ...(response?.modelVersion ? {modelVersion: response.modelVersion} : {}),
    switched: primary !== actual};
}

export function recordGeminiGeneration(response, primary, actual) {
  // Provider SDK response objects may be frozen or expose readonly properties.
  // Keep attribution outside them, then persist it in our own evidence packet.
  responseProvenance.set(response, geminiGenerationProvenance(primary,actual,response));
}

export function geminiResponseProvenance(response) {
  return responseProvenance.get(response);
}

export function mergeGeminiModelCooldowns(...sources) {
  const merged=Object.create(null);
  for(const source of sources)for(const [model,wait] of Object.entries(source||{})) {
    if(wait?.model!==model || !Number.isFinite(Date.parse(wait.retryAt)))continue;
    if(!merged[model] || Date.parse(wait.retryAt)>Date.parse(merged[model].retryAt))merged[model]=wait;
  }
  return merged;
}
