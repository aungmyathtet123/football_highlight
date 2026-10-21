import {resolve} from 'node:path';

export function parseSourceShotCheckpoint(text) {
  // Node 22 exposes the original JSON lexeme. Recover old Python integer
  // timestamps exactly rather than rounding or inventing new provenance.
  return JSON.parse(text,(_key,value,context)=>Number.isInteger(value) && !Number.isSafeInteger(value)
    && /^\d+$/.test(context?.source||'') ? context.source : value);
}

export function sourceShotCheckpointMatches(saved,sourcePath,info) {
  const signature=saved?.signature?.source;
  if(![3,4].includes(saved?.signature?.version) || saved.signature.detector!=='adaptive+content-27-pyav'
    || !Array.isArray(saved.shots) || !saved.shots.length
    || Number(saved.shots.at(-1)?.endTime||0)<.25 || !Array.isArray(signature)
    || typeof signature[2]!=='string') return false;
  try {
    return resolve(String(signature[0]))===resolve(sourcePath)
      && BigInt(signature[1])===info.size && BigInt(signature[2])===info.mtimeNs;
  } catch { return false; }
}
