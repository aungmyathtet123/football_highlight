import {geminiResourceExhausted} from './gemini-limit-evidence.mjs';

function defaultSleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function withGeminiDeadline(task, milliseconds, label) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => task(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`504 deadline exceeded: ${label} exceeded its ${Math.round(milliseconds / 1000)}-second hard deadline.`);
          // Rejecting a race alone leaves SDK retries and network work alive.
          // Cancel that work before releasing the gate to another request.
          controller.abort(error);
          reject(error);
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function geminiRetryDeadline(baseMilliseconds, timeoutCount = 0) {
  const base = Math.max(1000, Number(baseMilliseconds) || 180000);
  // Retrying an identical long video with the identical expired deadline
  // repeatedly discards useful provider work. Increase only after a deadline,
  // not for quota waits, and keep every individual request bounded.
  return Math.min(600000, Math.round(base * (2 ** Math.min(3, Math.max(0, timeoutCount)))));
}

export function geminiVideoDeadline(baseMilliseconds, durationSeconds) {
  const base = Math.max(1000, Number(baseMilliseconds) || 180000);
  // The SDK sends X-Server-Timeout, so a short first deadline can discard
  // expensive video work on Google's side, not just stop our local waiting.
  const videoBudget = Number(durationSeconds) >= 120 ? 600000
    : Number(durationSeconds) >= 60 ? 360000 : base;
  return Math.min(600000, Math.max(base, videoBudget));
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
  baseDelayMs = 15_000,
  maximumDelayMs = 60_000,
  retryAfterMs,
  random = Math.random,
} = {}) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return Math.max(1_000, Math.round(retryAfterMs));
  const exponential = Math.min(maximumDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
  const jitter = 0.9 + Math.max(0, Math.min(1, Number(random()))) * 0.2;
  return Math.max(1_000, Math.min(maximumDelayMs, Math.round(exponential * jitter)));
}

export function geminiServiceFailure(error) {
  const message=String(error?.message||error),code=String(error?.cause?.code||error?.code||'');
  const status=Number(error?.status||error?.response?.status||error?.code)
    ||Number(message.match(/\b(408|499|500|502|503|504)\b/)?.[1])||null;
  const deadline=status===504||/deadline[_ ]exceeded|deadline expired/i.test(message);
  // Client/auth/schema errors are not an unhealthy service and must not loop.
  if([400,401,403,404,422].includes(status))return null;
  return deadline||[408,499,500,502,503].includes(status)
    ||/temporarily unavailable|internal(?: server)? error|socket hang up|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message)
    ||/ECONNRESET|ETIMEDOUT|EAI_AGAIN/.test(code)
    ?{status,reason:deadline?'timeout':status===499?'cancelled':'service',deadline}:null;
}

export function serviceRetryDelay(attempt,{retryAfterMs,random=Math.random}={}) {
  return quotaRetryDelay(attempt,{baseDelayMs:5000,maximumDelayMs:60000,retryAfterMs,random});
}

export function restoredGeminiRetryDelay(wait, maximumDelayMs, now = Date.now()) {
  if (!wait?.active) return 0;
  const remaining = Date.parse(wait.retryAt) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  // Preserve an explicit provider wait. Old application cooldowns must not
  // resurrect a multi-minute delay after the retry policy has been shortened.
  return Number.isFinite(wait.providerRetryAfterMs) && wait.providerRetryAfterMs >= 0
    ? remaining : Math.min(remaining, maximumDelayMs);
}

export function createGeminiRequestGate({
  maxConcurrent = 1,
  adaptive = true,
  recoverySuccesses = 4,
  overloadDelayMs = 15_000,
  now = Date.now,
  sleep = defaultSleep,
} = {}) {
  // No client-side request-rate pacing. Bound simultaneous work only; a
  // cooldown is created exclusively after a provider error or explicit defer.
  // Old minimumIntervalMs options are intentionally ignored.
  const limit = Math.max(1, Math.min(4, Math.floor(Number(maxConcurrent) || 1)));
  const pending = [];
  let currentLimit = limit;
  let successes = 0;
  let overloads = 0;
  let serviceFailures = 0;
  let serviceStreak = 0;
  let active = 0;
  let nextRequestAt = 0;
  let queued = 0;
  const pump = () => {
    while (pending.length && active < currentLimit) {
      const {task,resolve,reject,rejectOnCooldown}=pending.shift();
      active += 1;
      const execute = async () => {
      // A different in-flight failure may extend the cooldown while we wait.
      // Recheck the deadline rather than waking into another known-busy call.
      try {
        while (nextRequestAt > now()) {
          if(rejectOnCooldown)throw Object.assign(new Error('Model entered cooldown before admission'),
            {code:'GEMINI_MODEL_COOLDOWN'});
          await sleep(nextRequestAt - now());
        }
        const value=await task();
        if(adaptive && ++successes >= recoverySuccesses){currentLimit=Math.min(limit,currentLimit+1);successes=0;serviceStreak=0;}
        resolve(value);
      } catch(error) {
        if(adaptive && geminiResourceExhausted(error)){
          overloads++;successes=0;currentLimit=Math.max(1,Math.floor(currentLimit/2));
          nextRequestAt=Math.max(nextRequestAt,now()+(retryAfterMilliseconds(error,now())??overloadDelayMs));
        }else if(adaptive && geminiServiceFailure(error)){
          serviceFailures++;serviceStreak++;successes=0;currentLimit=Math.max(1,Math.floor(currentLimit/2));
          nextRequestAt=Math.max(nextRequestAt,now()+serviceRetryDelay(serviceStreak,{retryAfterMs:retryAfterMilliseconds(error,now())}));
        }
        reject(error);
      } finally {
        active -= 1;
        queued = Math.max(0, queued - 1);
        pump();
      }
      };
      void execute();
    }
  };
  const schedule = (task,{rejectOnCooldown=false}={}) => {
    queued += 1;
    return new Promise((resolve,reject)=>{pending.push({task,resolve,reject,rejectOnCooldown});pump();});
  };
  return {
    schedule,
    defer: milliseconds => {
      nextRequestAt = Math.max(nextRequestAt, now() + Math.max(0, Number(milliseconds) || 0));
    },
    status: () => ({ queued, active, maxConcurrent: limit, currentConcurrency:currentLimit, overloads, serviceFailures, nextRequestAt }),
  };
}
