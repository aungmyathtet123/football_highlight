import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCheckpointArchive, restoreCheckpointArchive } from "../deploy/cloud-run/checkpoint-store.mjs";

test("cloud checkpoint archives restore reusable analysis and tracking evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "touchline-checkpoint-test-"));
  const jobId = "11111111-2222-4333-8444-555555555555";
  const dataRoot = join(root, "data");
  const archivePath = join(root, "checkpoint.tar");
  try {
    await mkdir(join(dataRoot, "jobs"), { recursive: true });
    await mkdir(join(dataRoot, "outputs", jobId, "tracking"), { recursive: true });
    await writeFile(join(dataRoot, "jobs", `${jobId}.json`), JSON.stringify({ id: jobId, stage: "tracking", progress: 33, sourceKey: join(dataRoot, "uploads", jobId, "source.mp4") }));
    await writeFile(join(dataRoot, "outputs", jobId, "step1-scene-manifest.json"), "selected-scenes");
    await writeFile(join(dataRoot, "outputs", jobId, "tracking", "tracking.json"), "tracked-evidence");
    const batchDirectory = join(dataRoot, "outputs", jobId, "tracking", "gemini");
    await mkdir(batchDirectory, { recursive: true });
    await writeFile(join(batchDirectory, "scene.batch-0-64.json"), JSON.stringify({ frames: [{ index: 64 }] }));
    await writeFile(join(batchDirectory,"scene.video-v1-0.json"),JSON.stringify({version:1,fps:8,frames:[{index:0,time:0}]}));
    await writeFile(join(batchDirectory,"scene.crop-review-v2-preview.json"),JSON.stringify({passed:false,issues:['ball outside crop']}));
    await mkdir(join(batchDirectory,'scene.tmp'),{recursive:true});
    await writeFile(join(batchDirectory,'scene.tmp','source.mp4'),'disposable preview source');
    await writeFile(join(batchDirectory, "scene.batch-0-128.json.tmp"), "unfinished response");
    await mkdir(join(dataRoot, "tracking-cache", jobId, "scenes"), { recursive: true });
    await writeFile(join(dataRoot, "tracking-cache", jobId, "scenes", "scene-a.json"), JSON.stringify({ sampledFrames: 42 }));
    await mkdir(join(dataRoot, "tracking-cache", "another-job", "scenes"), { recursive: true });
    await writeFile(join(dataRoot, "tracking-cache", "another-job", "scenes", "private.json"), "unrelated job");
    const observationPath = join(dataRoot, "tracking-cache", jobId, "observations.sqlite");
    const python = process.platform === "win32" ? "python" : (process.env.TRACKING_PYTHON || "python3");
    execFileSync(python, ["-c", "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('create table observations (frame integer primary key, payload text)'); db.execute('insert into observations values (?,?)',(42,'saved detection')); db.commit(); db.close()", observationPath]);
    await writeFile(join(dataRoot, "outputs", jobId, "unfinished.tmp"), "partial");
    await writeFile(join(dataRoot, "outputs", jobId, "scene.pending.mp4"), "partial encoding");
    await writeFile(join(dataRoot, "outputs", jobId, "scene.mp4"), "completed separate scene");
    await writeFile(join(dataRoot, "outputs", jobId, "final.mp4"), "large-final-output");

    const manifest = await createCheckpointArchive({ dataRoot, jobId, archivePath, stage: "tracking", progress: 33 });
    assert.equal(manifest.progress, 33);
    assert.ok(manifest.files.some(file => file.endsWith("tracking/tracking.json")));
    assert.ok(manifest.files.some(file => file.endsWith("gemini/scene.batch-0-64.json")));
    assert.ok(manifest.files.some(file=>file.endsWith('gemini/scene.video-v1-0.json')));
    assert.ok(manifest.files.some(file=>file.endsWith('gemini/scene.crop-review-v2-preview.json')));
    assert.ok(!manifest.files.some(file=>file.includes('gemini/scene.tmp/')));
    assert.ok(!manifest.files.some(file => file.endsWith("scene.batch-0-128.json.tmp")));
    assert.ok(manifest.files.some(file => file.endsWith("tracking-cache/" + jobId + "/observations.sqlite")));
    assert.ok(manifest.files.some(file => file.endsWith("tracking-cache/" + jobId + "/scenes/scene-a.json")));
    assert.ok(!manifest.files.some(file => file.includes("another-job")));
    assert.ok(!manifest.files.some(file => file.endsWith("unfinished.tmp")));
    assert.ok(!manifest.files.some(file => file.endsWith("scene.pending.mp4")));
    assert.ok(manifest.files.some(file => file.endsWith("scene.mp4")));
    assert.ok(!manifest.files.some(file => file.endsWith("final.mp4")));

    await rm(join(dataRoot, "jobs"), { recursive: true, force: true });
    await rm(join(dataRoot, "outputs"), { recursive: true, force: true });
    await rm(join(dataRoot, "tracking-cache"), { recursive: true, force: true });
    const restored = await restoreCheckpointArchive({ dataRoot, jobId, archivePath });
    assert.equal(restored.stage, "tracking");
    assert.equal(await readFile(join(dataRoot, "outputs", jobId, "tracking", "tracking.json"), "utf8"), "tracked-evidence");
    assert.deepEqual(JSON.parse(await readFile(join(batchDirectory, "scene.batch-0-64.json"), "utf8")), { frames: [{ index: 64 }] });
    assert.deepEqual(JSON.parse(await readFile(join(batchDirectory,'scene.video-v1-0.json'),'utf8')),
      {version:1,fps:8,frames:[{index:0,time:0}]});
    assert.deepEqual(JSON.parse(await readFile(join(batchDirectory,'scene.crop-review-v2-preview.json'),'utf8')),
      {passed:false,issues:['ball outside crop']});
    await assert.rejects(stat(join(batchDirectory,'scene.tmp','source.mp4')),/ENOENT/);
    assert.equal(JSON.parse(await readFile(join(dataRoot, "tracking-cache", jobId, "scenes", "scene-a.json"), "utf8")).sampledFrames, 42);
    assert.equal(execFileSync(python, ["-c", "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(db.execute('select payload from observations where frame=42').fetchone()[0]); db.close()", observationPath], { encoding: "utf8" }).trim(), "saved detection");
    await assert.rejects(stat(join(dataRoot, "outputs", jobId, "final.mp4")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cloud checkpoint captures committed WAL observations while tracking is still open", async () => {
  const root = await mkdtemp(join(tmpdir(), "touchline-live-cache-test-"));
  const jobId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const dataRoot = join(root, "data");
  const database = join(dataRoot, "tracking-cache", jobId, "observations.sqlite");
  const archivePath = join(root, "live.tar");
  const python = process.platform === "win32" ? "python" : (process.env.TRACKING_PYTHON || "python3");
  let writer;
  try {
    await mkdir(join(dataRoot, "jobs"), { recursive: true });
    await mkdir(join(dataRoot, "tracking-cache", jobId), { recursive: true });
    await writeFile(join(dataRoot, "jobs", `${jobId}.json`), JSON.stringify({ id: jobId, stage: "tracking" }));
    writer = spawn(python, ["-u", "-c", "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('pragma journal_mode=WAL'); db.execute('create table observations (frame integer primary key, payload text)'); db.execute('insert into observations values (?,?)',(88,'live WAL detection')); db.commit(); print('READY',flush=True); sys.stdin.readline(); db.close()", database], { stdio: ["pipe", "pipe", "pipe"] });
    const [ready] = await once(writer.stdout, "data");
    assert.match(String(ready), /READY/);
    const manifest = await createCheckpointArchive({ dataRoot, jobId, archivePath, stage: "tracking", progress: 33 });
    assert.ok(manifest.files.some(file => file.endsWith("observations.sqlite")));
    writer.stdin.end("\n");
    await once(writer, "exit");
    writer = null;
    await rm(join(dataRoot, "tracking-cache"), { recursive: true, force: true });
    await restoreCheckpointArchive({ dataRoot, jobId, archivePath });
    assert.equal(execFileSync(python, ["-c", "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(db.execute('select payload from observations where frame=88').fetchone()[0]); db.close()", database], { encoding: "utf8" }).trim(), "live WAL detection");
  } finally {
    writer?.kill();
    await rm(root, { recursive: true, force: true });
  }
});
