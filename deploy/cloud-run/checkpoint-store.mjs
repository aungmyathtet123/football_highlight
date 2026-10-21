import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

export const CHECKPOINT_VERSION = 1;

export async function createCheckpointArchive({ dataRoot, jobId, archivePath, stage, progress }) {
  validateJobId(jobId);
  const stagingRoot = await mkdtemp(join(tmpdir(), `touchline-checkpoint-${jobId.slice(0, 8)}-`));
  try {
    const files = [];
    const jobSource = join(dataRoot, "jobs", `${jobId}.json`);
    const jobDestination = join(stagingRoot, "jobs", `${jobId}.json`);
    if (!await copyStableFile(jobSource, jobDestination)) throw new Error("The local job record was not stable enough to checkpoint.");
    files.push(relative(stagingRoot, jobDestination).replaceAll("\\", "/"));

    const outputSource = join(dataRoot, "outputs", jobId);
    const outputDestination = join(stagingRoot, "outputs", jobId);
    files.push(...await copyStableTree(outputSource, outputDestination, stagingRoot));

    // Scene JSON alone is not enough to resume a partially tracked video:
    // raw YOLO observations are kept in SQLite and were previously omitted.
    // Scope them to this job and use SQLite's online backup API so a checkpoint
    // taken during active tracking is transactionally consistent even in WAL mode.
    const cacheSource = join(dataRoot, "tracking-cache", jobId);
    const cacheDestination = join(stagingRoot, "tracking-cache", jobId);
    files.push(...await copyStableTree(cacheSource, cacheDestination, stagingRoot, { skipSqlite: true }));
    const observationsSource = join(cacheSource, "observations.sqlite");
    const observationsDestination = join(cacheDestination, "observations.sqlite");
    if (await isFile(observationsSource)) {
      await mkdir(dirname(observationsDestination), { recursive: true });
      await snapshotSqlite(observationsSource, observationsDestination);
      files.push(relative(stagingRoot, observationsDestination).replaceAll("\\", "/"));
    }

    const manifest = {
      version: CHECKPOINT_VERSION,
      jobId,
      savedAt: new Date().toISOString(),
      stage: String(stage || ""),
      progress: Number(progress || 0),
      files: files.sort(),
    };
    await writeFile(join(stagingRoot, "checkpoint-manifest.json"), JSON.stringify(manifest, null, 2));
    await mkdir(dirname(archivePath), { recursive: true });
    await run("tar", ["-cf", archivePath, "-C", stagingRoot, "."]);
    return manifest;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function restoreCheckpointArchive({ dataRoot, jobId, archivePath }) {
  validateJobId(jobId);
  const restoreRoot = await mkdtemp(join(tmpdir(), `touchline-restore-${jobId.slice(0, 8)}-`));
  try {
    await run("tar", ["-xf", archivePath, "-C", restoreRoot, "--no-same-owner", "--no-same-permissions"]);
    const manifest = JSON.parse(await readFile(join(restoreRoot, "checkpoint-manifest.json"), "utf8"));
    if (manifest.version !== CHECKPOINT_VERSION || manifest.jobId !== jobId || !Array.isArray(manifest.files)) {
      throw new Error("The saved processing checkpoint is incompatible or belongs to another job.");
    }
    for (const entry of manifest.files) {
      const safeEntry = safeRelativePath(entry);
      const source = resolve(restoreRoot, safeEntry);
      const destination = resolve(dataRoot, safeEntry);
      assertInside(restoreRoot, source);
      assertInside(dataRoot, destination);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
    JSON.parse(await readFile(join(dataRoot, "jobs", `${jobId}.json`), "utf8"));
    return manifest;
  } finally {
    await rm(restoreRoot, { recursive: true, force: true });
  }
}

async function copyStableTree(sourceRoot, destinationRoot, stagingRoot, { skipSqlite = false } = {}) {
  const files = [];
  let entries;
  try { entries = await readdir(sourceRoot, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return files; throw error; }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || isTransient(entry.name) || (skipSqlite && /\.sqlite(?:-wal|-shm)?$/i.test(entry.name))) continue;
    const source = join(sourceRoot, entry.name);
    const destination = join(destinationRoot, entry.name);
    if (entry.isDirectory()) {
      files.push(...await copyStableTree(source, destination, stagingRoot, { skipSqlite }));
    } else if (entry.isFile() && await copyStableFile(source, destination)) {
      files.push(relative(stagingRoot, destination).replaceAll("\\", "/"));
    }
  }
  return files;
}

async function isFile(path) {
  try { return (await stat(path)).isFile(); }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function snapshotSqlite(source, destination) {
  const python = process.env.TRACKING_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const script = "import sqlite3,sys; src=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True,timeout=120); dst=sqlite3.connect(sys.argv[2]); src.backup(dst,pages=128,sleep=0.1); dst.close(); src.close()";
  await run(python, ["-c", script, source, destination]);
}

async function copyStableFile(source, destination) {
  let before;
  try { before = await stat(source); }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  if (!before.isFile()) return false;
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const after = await stat(source);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    await rm(destination, { force: true });
    return false;
  }
  return true;
}

function isTransient(name) {
  return /(?:\.tmp|\.part|\.partial|\.pending\.mp4)$/i.test(name) || name === "final.mp4";
}

function safeRelativePath(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error("Unsafe checkpoint path.");
  return normalized;
}

function assertInside(root, target) {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) throw new Error("Checkpoint path escaped its workspace.");
}

function validateJobId(jobId) {
  if (!/^[a-f0-9-]{36}$/i.test(String(jobId || ""))) throw new Error("A valid checkpoint job ID is required.");
}

async function run(command, args) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", rejectRun);
    child.once("exit", code => code === 0 ? resolveRun() : rejectRun(new Error(`${command} exited with code ${code}: ${stderr.trim()}`)));
  });
}
