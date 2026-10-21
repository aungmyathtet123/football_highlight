import {Agent, getGlobalDispatcher, setGlobalDispatcher} from 'undici';

export function isGeminiOrigin(origin) {
  try {
    const host=new URL(String(origin)).hostname;
    return host==='aiplatform.googleapis.com' || host==='generativelanguage.googleapis.com'
      || host.endsWith('-aiplatform.googleapis.com')
      || /^aiplatform\.(us|eu)\.rep\.googleapis\.com$/.test(host);
  } catch { return false; }
}

export function createGeminiDispatcher(previous, gemini, timeoutMs=650000) {
  return {
    dispatch(options, handler) {
      if (!isGeminiOrigin(options.origin)) return previous.dispatch(options,handler);
      // Node fetch can supply its own 300-second timeout, overriding Agent
      // defaults. Set it on each Gemini dispatch, not on private SDK Symbols.
      // The caller's AbortSignal still enforces every shorter request deadline.
      return gemini.dispatch({...options,headersTimeout:timeoutMs,bodyTimeout:timeoutMs},handler);
    },
    async close() {await Promise.all([gemini.close(),previous.close()]);},
    async destroy(error) {await Promise.all([gemini.destroy(error),previous.destroy(error)]);},
  };
}

let installed=false;
export function installGeminiTransport() {
  if (installed) return;
  const previous=getGlobalDispatcher();
  const gemini=new Agent({headersTimeout:650000,bodyTimeout:650000});
  setGlobalDispatcher(createGeminiDispatcher(previous,gemini));
  installed=true;
}
