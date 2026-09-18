import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const retryableRenameCodes = new Set(["EPERM", "EACCES", "EBUSY"]);

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function createSerializedJsonStore(directory, {
  write = writeFile,
  move = rename,
  remove = rm,
  sleep = delay,
  attempts = 8,
  processId = process.pid,
  uniqueId = randomUUID,
} = {}) {
  const pendingByKey = new Map();

  async function moveWithRetry(temporaryPath, destinationPath) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await move(temporaryPath, destinationPath);
        return;
      } catch (error) {
        if (!retryableRenameCodes.has(error?.code) || attempt >= attempts) throw error;
        await sleep(Math.min(1000, 25 * (2 ** (attempt - 1))));
      }
    }
  }

  return async function saveJson(key, value) {
    const previous = pendingByKey.get(key) || Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const destinationPath = join(directory, `${key}.json`);
      const temporaryPath = `${destinationPath}.${processId}.${uniqueId()}.tmp`;
      try {
        await write(temporaryPath, JSON.stringify(value, null, 2));
        await moveWithRetry(temporaryPath, destinationPath);
      } finally {
        await remove(temporaryPath, { force: true }).catch(() => undefined);
      }
    });
    pendingByKey.set(key, current);
    try {
      await current;
    } finally {
      if (pendingByKey.get(key) === current) pendingByKey.delete(key);
    }
  };
}
