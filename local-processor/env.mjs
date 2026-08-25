import { readFile } from "node:fs/promises";

export async function loadProjectEnv(path) {
  try {
    const contents = await readFile(path, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}