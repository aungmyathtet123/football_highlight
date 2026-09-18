import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Touchline AI upload studio", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>New football edit · Touchline AI<\/title>/i);
  assert.match(html, /Create a football edit/);
  assert.match(html, /Drop your match footage here/);
  assert.match(html, /Full-video analysis/);
  assert.match(html, /Analyze football video/);
  assert.match(html, /Adaptive highlight length/);
  assert.match(html, /Recap request/);
  assert.match(html, /Create a 2-minute recap covering every goal/);
  assert.doesNotMatch(html, /Rennes|PSG|Ferran|2-2/i);
  assert.match(html, /Based on source duration/);
  assert.match(html, /16:9 original football analysis/);
  assert.match(html, /cannot guarantee fair use or prevent claims/);
  assert.match(html, /Broadcast commentary and source music are always removed/);
  assert.doesNotMatch(html, /60–70s|70–80s|80–90s/);
  assert.match(html, /Logo \/ watermark masking/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Starter Project/i);
});
