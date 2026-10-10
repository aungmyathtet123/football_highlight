// Node fetch decodes gzip/deflate/Brotli bodies but leaves the upstream
// compression/length headers intact. Never send those stale headers to a
// browser alongside decoded HTML, JS or CSS.
export function proxyResponseHeaders(headers) {
  const encodings = String(headers.get('content-encoding') || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const decoded = encodings.length > 0 && encodings.every(value => ['gzip', 'deflate', 'br'].includes(value));
  const excluded = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length']);
  if (decoded) excluded.add('content-encoding');
  const result = {};
  headers.forEach((value, name) => { if (!excluded.has(name.toLowerCase())) result[name] = value; });
  return result;
}
