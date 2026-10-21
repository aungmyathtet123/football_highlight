// Preserve what Google actually says. A bare RESOURCE_EXHAUSTED response does
// not identify RPM, TPM, daily quota, spend cap or shared-capacity exhaustion.
// Never persist raw provider messages, keys, account IDs or video payloads.
export function geminiLimitEvidence(error) {
  let payload;
  try {payload=JSON.parse(String(error?.message||''));} catch { /* Plain SDK error. */ }
  const body=error?.error||payload?.error||payload||error;
  const details=Array.isArray(body?.details)?body.details:[];
  const quota=details.find(item=>String(item?.['@type']||'').endsWith('QuotaFailure'));
  const info=details.find(item=>String(item?.['@type']||'').endsWith('ErrorInfo'));
  const safe=value=>typeof value==='string'&&/^[a-zA-Z0-9_.:/{}-]{1,200}$/.test(value)?value:undefined;
  const reason=safe(info?.reason);
  const metadata=info?.metadata||{};
  const quotaMetric=safe(metadata.quota_metric||metadata.quotaMetric);
  const quotaLimit=safe(metadata.quota_limit||metadata.quotaLimit);
  const status=Number(error?.status||error?.response?.status||body?.code||error?.code)||null;
  const hasQuota=Boolean(quota||quotaMetric||quotaLimit||reason&&/QUOTA|RATE_LIMIT|SPEND_LIMIT/.test(reason));
  const hasCapacity=Boolean(reason&&/CAPACITY|SERVER_OVERLOADED/.test(reason));
  return {status,kind:hasQuota?'quota':hasCapacity?'capacity':'unspecified',
    ...(reason?{reason}:{}),...(quotaMetric?{quotaMetric}:{}),...(quotaLimit?{quotaLimit}:{}),
    quotaViolationCount:quota?.violations?.length||0};
}

export function geminiResourceExhausted(error) {
  const status=geminiLimitEvidence(error).status;
  // An auth/schema error mentioning quota is not a retryable 429. Numeric
  // prompt/config values containing "429" are not HTTP status codes either.
  if(status!==null)return status===429;
  return /\b429\b|\bRESOURCE_EXHAUSTED\b|quota (?:exceeded|exhausted)|rate limit(?:ed| exceeded)?/i
    .test(String(error?.message||error));
}

export function geminiLimitMessage(evidence) {
  return evidence?.kind==='quota'?'Google reported a Gemini quota limit'
    :evidence?.kind==='capacity'?'Google reported busy Gemini capacity'
    :'Google temporarily rejected the Gemini request (429; quota or capacity reason not supplied)';
}
