import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { GoogleGenAI } from '@google/genai';
import { reviewHybridCrop } from '../local-processor/hybrid-framing.mjs';
import { parseGeminiJson } from '../local-processor/gemini-json-policy.mjs';

const [sourcePath, momentPath, evidencePath, directory] = process.argv.slice(2);
if (!sourcePath || !momentPath || !evidencePath || !directory) {
  throw new Error('Usage: node tools/review-keyframe-canary.mjs SCENE MOMENT EVIDENCE OUTPUT_DIRECTORY');
}
await mkdir(directory, { recursive: true });
const scene = JSON.parse(await readFile(momentPath, 'utf8')).moments[0];
const evidence = JSON.parse(await readFile(evidencePath, 'utf8')).moments[scene.id];
const sourceFingerprint = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
const ai = new GoogleGenAI({ vertexai: true, project: 'football-506506', location: 'global',
  httpOptions: { timeout: 600000 } });

async function run(executable, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${executable} exited ${code}`)));
  });
}

const result = await reviewHybridCrop({
  sourcePath, sourceFingerprint, scene, evidence, media: { width: 1920, height: 1080 },
  ratio: 9 / 16, directory, ffmpeg: 'ffmpeg', run, model: 'gemini-3.8-flash', videoOnly: true,
  outcomeModel: process.env.GEMINI_OUTCOME_REVIEW_MODEL || 'gemini-3.1-pro-preview',
  generate: async request => {
    const response = await ai.models.generateContent(request);
    if (!response.text) throw new Error('Gemini crop review returned no text.');
    return parseGeminiJson(response.text);
  },
});
await writeFile(`${directory}/review-result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  geometry: result.geometryReview, finalCropVerified: result.finalCropVerified,
  review: result.renderReview,
}, null, 2));
