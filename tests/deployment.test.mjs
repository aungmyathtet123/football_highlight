import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("production output links use the configured public origin", async () => {
  const server = await read("local-processor/server.mjs");
  assert.match(server, /process\.env\.PUBLIC_BASE_URL/);
  assert.equal(
    (server.match(/outputUrl: publicOutputUrl\(id\)/g) || []).length,
    4,
    "every completion path must emit a public URL",
  );
  assert.doesNotMatch(server, /outputUrl: `http:\/\/127\.0\.0\.1/);
});

test("Oracle proxy exposes application routes but keeps worker ports private", async () => {
  const caddy = await read("deploy/oracle/Caddyfile.in");
  assert.match(caddy, /@processor path \/health \/jobs \/jobs\/\* \/outputs\/\*/);
  assert.match(caddy, /reverse_proxy @processor 127\.0\.0\.1:8787/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:3000/);
  assert.match(caddy, /basic_auth/);
});

test("Linux production environment uses persistent storage and Linux executables", async () => {
  const environment = await read("deploy/oracle/env.production.example");
  assert.match(environment, /^LOCAL_DATA_DIR=\/srv\/touchline-data$/m);
  assert.match(environment, /^TRACKING_PYTHON=\.\/\.venv-tracking\/bin\/python$/m);
  assert.match(environment, /^FFMPEG_PATH=\/usr\/bin\/ffmpeg$/m);
  assert.match(environment, /^SOCCERNET_CALF_ENABLED=false$/m);
});
