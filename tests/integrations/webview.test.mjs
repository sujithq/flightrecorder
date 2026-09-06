import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const { validateServerUrl, withRun, panelHtml } = require("../../extensions/flight-recorder/webview.cjs");
const extensionUrl = new URL("../../extensions/flight-recorder/extension.cjs", import.meta.url);
const extensionRequire = createRequire(extensionUrl);

async function runExtensionCommand(command, configuredUrl) {
  const handlers = new Map();
  const requests = [];
  const forwarded = [];
  const panel = { webview: { html: "" }, onDidDispose: () => ({ dispose() {} }), reveal() {}, dispose() {} };
  const vscode = {
    workspace: {
      isTrusted: true,
      getConfiguration(section) {
        assert.equal(section, "flightRecorder");
        return { get(key, fallback) { assert.equal(key, "serverUrl"); return configuredUrl ?? fallback; } };
      }
    },
    Uri: { parse: value => new URL(value) },
    env: { async asExternalUri(uri) { forwarded.push(uri.href); return uri; } },
    ViewColumn: { Active: 1 },
    ThemeIcon: class {},
    Disposable: class { constructor(dispose) { this.dispose = dispose; } },
    window: {
      createWebviewPanel: () => panel,
      async showInformationMessage() {},
      async showErrorMessage(message) { assert.fail(message); }
    },
    commands: { registerCommand(name, handler) { handlers.set(name, handler); return { dispose() {} }; } }
  };
  const extension = { exports: {} };
  runInNewContext(await readFile(extensionUrl, "utf8"), {
    module: extension,
    require: name => name === "vscode" ? vscode : extensionRequire(name),
    URL, AbortSignal,
    fetch: async url => { requests.push(url.href); return Response.json([]); }
  });
  extension.exports.activate({ subscriptions: [] });
  await handlers.get(command)();
  return { requests, forwarded, html: panel.webview.html };
}

test("extension manifest uses Docker port 5080 by default", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../extensions/flight-recorder/package.json", import.meta.url), "utf8"));
  assert.equal(manifest.contributes.configuration.properties["flightRecorder.serverUrl"].default, "http://localhost:5080");
});

test("onboarding walkthrough packages its guide and links only to contributed commands", async () => {
  const root = new URL("../../extensions/flight-recorder/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const commands = new Set(manifest.contributes.commands.map(command => command.command));
  const walkthrough = manifest.contributes.walkthroughs.find(item => item.id === "flightRecorder.localSetup");
  assert.ok(walkthrough);
  assert.equal(new Set(walkthrough.steps.map(step => step.id)).size, walkthrough.steps.length);
  for (const step of walkthrough.steps) {
    assert.ok(manifest.files.includes(step.media.markdown), `Guide is not packaged: ${step.media.markdown}`);
    const guide = await readFile(new URL(step.media.markdown, root), "utf8");
    assert.ok(guide.length > 0);
    for (const match of `${step.description}\n${guide}`.matchAll(/\]\(command:([^)?]+)(?:\?[^)]*)?\)/g)) {
      assert.ok(commands.has(match[1]), `Unknown walkthrough command: ${match[1]}`);
    }
  }
  const firstRun = walkthrough.steps.find(step => step.id === "first-run");
  assert.ok(firstRun, "Onboarding must continue beyond connecting MCP");
  assert.ok(firstRun.description.includes("command:flightRecorder.openRun"));
  assert.deepEqual(firstRun.completionEvents, [], "Opening a picker must not claim a trace was recorded");
  const guide = await readFile(new URL(firstRun.media.markdown, root), "utf8");
  const readme = await readFile(new URL("README.md", root), "utf8");
  const prompt = text => text.replaceAll("\r\n", "\n").match(/```text\n([\s\S]*?)\n```/)?.[1];
  assert.ok(prompt(guide), "The packaged guide must include a copyable first-task prompt");
  assert.equal(prompt(guide), prompt(readme), "README and in-product first-task instructions must agree");
});

for (const command of ["flightRecorder.open", "flightRecorder.openRun"]) {
  test(`${command} uses Docker port 5080 without a configured override`, async () => {
    const result = await runExtensionCommand(command);
    assert.deepEqual(result.forwarded, ["http://localhost:5080/"]);
    assert.deepEqual(result.requests, command === "flightRecorder.openRun" ? ["http://localhost:5080/api/runs"] : []);
    assert.ok(result.html.includes('src="http://localhost:5080/"'));
  });

  test(`${command} preserves an explicit native-server setting`, async () => {
    const result = await runExtensionCommand(command, "http://localhost:5205");
    assert.deepEqual(result.forwarded, ["http://localhost:5205/"]);
    assert.deepEqual(result.requests, command === "flightRecorder.openRun" ? ["http://localhost:5205/api/runs"] : []);
  });
}

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