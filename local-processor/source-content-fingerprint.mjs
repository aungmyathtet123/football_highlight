import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";

const inProcess = new Map();
export async function sourceContentFingerprint(path) {
  const info = await stat(path, { bigint: true });
  const key = `${path}:${info.size}:${info.mtimeNs}`;
  if (!inProcess.has(key)) {
    const pending = (async () => {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      return { size: Number(info.size), sha256: hash.digest("hex") };
    })();
    inProcess.set(key, pending);
    pending.catch(() => inProcess.delete(key));
    if (inProcess.size > 16) inProcess.delete(inProcess.keys().next().value);
  }
  return inProcess.get(key);
}
