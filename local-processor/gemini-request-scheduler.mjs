function defaultSleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

export function retryAfterMilliseconds(error, now = Date.now()) {
  const headers = error?.response?.headers || error?.headers;
  const value = headerValue(headers, "retry-after");
  if (value !== undefined && value !== null && String(value).trim()) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(String(value));
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const message = String(error?.message || error || "");
  const duration = message.match(/(?:retryDelay|retry after)[^0-9]*(\d+(?:\.\d+)?)\s*s/i);
  return duration ? Math.round(Number(duration[1]) * 1000) : undefined;
}

export function quotaRetryDelay(attempt, {
  baseDelayMs = 60_000,
  maximumDelayMs = 300_000,
  retryAfterMs,
  random = Math.random,
} = {}) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return Math.max(1_000, Math.round(retryAfterMs));
  const exponential = Math.min(maximumDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
  const jitter = 0.9 + Math.max(0, Math.min(1, Number(random()))) * 0.2;
  return Math.max(1_000, Math.round(exponential * jitter));
}

export function createGeminiRequestGate({
  minimumIntervalMs = 12_000,
  now = Date.now,
  sleep = defaultSleep,
} = {}) {
  let tail = Promise.resolve();
  let nextRequestAt = 0;
  let queued = 0;
  const schedule = task => {
    queued += 1;
    const execute = async () => {
      const delay = Math.max(0, nextRequestAt - now());
      if (delay) await sleep(delay);
      try {
        return await task();
      } finally {
        nextRequestAt = now() + Math.max(0, Number(minimumIntervalMs) || 0);
        queued = Math.max(0, queued - 1);
      }
    };
    const result = tail.then(execute, execute);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  return {
    schedule,
    status: () => ({ queued, nextRequestAt }),
  };
}
