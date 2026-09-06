import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { validateServerUrl, withRun, panelHtml } = require("../../extensions/flight-recorder/webview.cjs");

test("extension accepts only loopback server origins without embedded credentials", () => {
  for (const url of ["http://localhost:5205", "http://127.0.0.1:5080", "https://[::1]:7249"]) {
    assert.ok(validateServerUrl(url));
  }
  for (const url of ["https://example.com", "http://localhost.example.com", "file:///tmp/test",
    "http://localhost:5205/path", "http://localhost/?token=test", "http://user:test@localhost", "http://localhost/#test"]) {
    assert.throws(() => validateServerUrl(url));
  }
});

test("run links require a UUID and preserve the server origin", () => {
  const runId = "11111111-2222-3333-4444-555555555555";
  assert.equal(withRun("http://localhost:5205", runId).href, `http://localhost:5205/?run=${runId}`);
  assert.throws(() => withRun("http://localhost:5205", '"><script>'));
});

test("webview denies host scripts and local files while allowing only its recorder frame", () => {
  const html = panelHtml("http://localhost:5205/?run=test&view=graph", "random-nonce");
  assert.ok(html.includes("default-src 'none'; frame-src http://localhost:5205;"));
  assert.ok(html.includes('sandbox="allow-scripts allow-same-origin allow-downloads"'));
  assert.ok(html.includes("run=test&amp;view=graph"));
  assert.ok(!html.includes("unsafe-inline"));
  assert.ok(!html.includes("<script"));
  assert.throws(() => panelHtml("javascript:alert(1)", "nonce"));
  assert.throws(() => panelHtml("http://external.example", "nonce"));
  assert.throws(() => panelHtml("http://localhost:5205", "'; script-src *"));
  assert.ok(panelHtml("https://forwarded.example/?run=test", "nonce").includes("frame-src https://forwarded.example"));
});