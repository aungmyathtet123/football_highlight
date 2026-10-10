const { mkdir, readFile, stat, writeFile } = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { join } = require('node:path');

const bucket = process.env.STORAGE_BUCKET;
const sceneObject = process.env.SCENE_OBJECT;
const momentObject = process.env.MOMENT_OBJECT;
const resultObject = process.env.RESULT_OBJECT;
const variant = process.env.TRACKING_VARIANT || 'hybrid';
if (!bucket || !sceneObject || !momentObject || !resultObject || !['hybrid', 'fast'].includes(variant)) {
  throw new Error('Canary requires private bucket, source, moment, result, and a known tracking variant.');
}

async function accessToken() {
  const response = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  if (!response.ok) throw new Error(`Metadata token request failed: ${response.status}`);
  return (await response.json()).access_token;
}

async function download(objectName, path, token) {
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Could not read canary object ${objectName}: ${response.status}`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
}

async function upload(objectName, path, token) {
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
  const response = await fetch(url, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: await readFile(path),
  });
  if (!response.ok) throw new Error(`Could not save canary result: ${response.status} ${await response.text()}`);
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const process = spawn(command, args, { stdio: 'inherit' });
    process.on('error', reject);
    process.on('exit', code => code === 0 ? resolve() : reject(new Error(`Tracker exited ${code}`)));
  });
}

async function main() {
  const directory = '/tmp/keyframe-canary';
  await mkdir(directory, { recursive: true });
  const source = join(directory, 'scene.mp4');
  const moments = join(directory, 'moments.json');
  const output = join(directory, 'result.json');
  const token = await accessToken();
  await Promise.all([download(sceneObject, source, token), download(momentObject, moments, token)]);
  const personModel = '/app/tools/tracking/football-role-detector.pt';
  const ballModel = variant === 'fast'
    ? '/app/tools/tracking/yolo-football-ball-detection.pt' : personModel;
  for (const path of [personModel, ballModel]) await stat(path);
  const fps = variant === 'fast' ? 12 : 10;
  const args = [
    '/app/local-processor/track-football-v2.py', '--source', source, '--moments', moments,
    '--output', output, '--model', personModel, '--ball-model', ballModel,
    '--sample-fps', String(fps), '--coarse-sample-fps', variant === 'fast' ? '8' : '5',
    '--device', 'cpu', '--cpu-workers', variant === 'fast' ? '1' : '2',
    '--image-size', '960', '--ball-image-size', '1280', '--confidence', '0.08',
    '--ball-confidence', '0.03', '--output-width', '1080', '--output-height', '1920',
    '--window-height', '1920', '--window-top', '0', '--zoom', '1',
    '--tracker', variant === 'fast' ? 'botsort' : 'tracktrack',
    '--camera-motion', 'sparseOptFlow', '--cache-dir', join(directory, 'cache'),
  ];
  await run('/opt/venv/bin/python', args);
  await upload(resultObject, output, token);
  const result = JSON.parse(await readFile(output, 'utf8'));
  console.log(JSON.stringify({ variant, summary: result.summary, object: resultObject }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
