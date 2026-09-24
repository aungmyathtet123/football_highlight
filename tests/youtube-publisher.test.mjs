import test from "node:test";
import assert from "node:assert/strict";
import { buildAuthorizationUrl } from "../local-processor/youtube-publisher.mjs";

test("YouTube authorization requests only upload and channel identity access", () => {
  const url = new URL(buildAuthorizationUrl({
    clientId: "client.apps.googleusercontent.com",
    redirectUri: "http://127.0.0.1:8787/youtube/oauth/callback",
    state: "one-time-state",
  }));
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.match(url.searchParams.get("prompt"), /select_account/);
  assert.match(url.searchParams.get("scope"), /youtube\.upload/);
  assert.match(url.searchParams.get("scope"), /youtube\.readonly/);
  assert.equal(url.searchParams.get("state"), "one-time-state");
});
