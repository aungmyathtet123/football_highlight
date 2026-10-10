export const DEFAULT_LOCAL_WEB_PORT = 3002;

export function localStudioPort(env = process.env) {
  const value = String(env.LOCAL_WEB_PORT ?? '').trim();
  if (!value) return DEFAULT_LOCAL_WEB_PORT;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('LOCAL_WEB_PORT must be an integer between 1 and 65535.');
  }
  return Number(value);
}

export function localStudioOrigins(env = process.env) {
  const port = localStudioPort(env);
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

export function localStudioReturnOrigin(env = process.env) {
  return env.SITE_URL || `http://127.0.0.1:${localStudioPort(env)}`;
}
