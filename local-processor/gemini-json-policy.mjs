import {createHash} from 'node:crypto';

// Remove transport wrappers only. Never synthesize fields, close truncated
// JSON, extract an arbitrary embedded object or remap scene IDs. Semantic
// validators still inspect the exact parsed value returned by the model.
export function parseGeminiJson(value) {
  let text = String(value ?? '').trim();
  const fenced = text.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  if (fenced) text = fenced[1].trim();
  return JSON.parse(text);
}

export function geminiInvalidRequestDetails(error,request,label) {
  const status=Number(error?.status||error?.response?.status||error?.code);
  if(status!==400 && !/"code"\s*:\s*400|\bINVALID_ARGUMENT\b/.test(String(error?.message||''))) return null;
  const schema=request.config?.responseJsonSchema??request.config?.responseSchema;
  const serialized=schema?JSON.stringify(schema):'';
  const media=[];
  for(const content of Array.isArray(request.contents)?request.contents:[request.contents]) {
    for(const part of content?.parts||[content]) {
      const value=part?.inlineData||part?.fileData;
      if(value)media.push({mimeType:value.mimeType||'unknown',
        bytes:typeof value.data==='string'?Buffer.from(value.data,'base64').length:null,
        fps:part.videoMetadata?.fps??null});
    }
  }
  // No keys, headers, user text, source URIs or media bytes are persisted.
  return {version:1,status:400,label,model:request.model,media,
    schemaHash:serialized?createHash('sha256').update(serialized).digest('hex'):null,
    schemaCharacters:serialized.length,candidateArrayBounds:schema?.properties?.candidates
      ?{minItems:schema.properties.candidates.minItems??null,maxItems:schema.properties.candidates.maxItems??null}:null};
}

export function geminiOutputTruncated(response) {
  return response?.candidates?.some(candidate => candidate.finishReason === 'MAX_TOKENS') === true;
}
export function geminiJsonRetryConfig(config = {}, response) {
  if (!geminiOutputTruncated(response)) return { ...config, responseMimeType:'application/json', temperature:0 };
  return { ...config, responseMimeType:'application/json', temperature:0,
    maxOutputTokens: Math.min(65536, Math.max(8192, Number(config.maxOutputTokens || 32768) * 2)),
    thinkingConfig: { ...config.thinkingConfig, thinkingLevel:'LOW' } };
}
