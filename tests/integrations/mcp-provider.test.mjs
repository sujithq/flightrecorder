import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mockVscode } from "./helpers/vscode.mjs";

const require = createRequire(import.meta.url);
const { registerMcp, providerId, approvalKey } = require("../../extensions/flight-recorder/mcp.cjs");

function create(options = {}) {
  const mock = mockVscode(options);
  const probes = [];
  let version = "0.2.0";
  const connection = registerMcp(mock.vscode, mock.context, {
    ensureLocal() {
      if (!mock.vscode.workspace.isTrusted || mock.vscode.env.remoteName) throw new Error("Local trusted window required");
    },
    getOrigin: mock.origin,
    getVersion: () => version,
    async probe(origin) { probes.push(origin); if (options.probeError) throw options.probeError; },
    log: text => mock.output.push(text)
  });
  return { ...mock, connection, probes, setVersion(value) { version = value; },
    definitions: () => mock.providers.get(providerId).provideMcpServerDefinitions() };
}

test("MCP activation and discovery do not start a service, probe, write config or grant consent", () => {
  const instance = create();
  assert.deepEqual(instance.definitions(), []);
  assert.deepEqual(instance.probes, []);
  assert.deepEqual(instance.writes, []);
  assert.equal(instance.state.size, 0);
});

test("MCP connection requires explicit consent and verifies before publishing", async () => {
  const instance = create();
  instance.answers.information.push("Connect");
  await instance.connection.connect();
  assert.deepEqual(instance.probes, ["http://localhost:5080"]);
  const [definition] = instance.definitions();
  assert.equal(definition.uri.href, "http://localhost:5080/mcp");
  assert.equal(definition.version, "0.2.0");
  assert.equal(instance.contexts.get("flightRecorder.mcpConnected"), true);
  assert.deepEqual(instance.writes, []);
  assert.equal(instance.changes(), 1);
});

test("skipping connection does not probe or change manual configuration", async () => {
  const instance = create();
  await instance.connection.connect();
  assert.deepEqual(instance.probes, []);
  assert.deepEqual(instance.definitions(), []);
  assert.equal(instance.state.size, 0);
});

test("failed probe does not persist approval or advertise a ready connection", async () => {
  const instance = create({ probeError: new Error("MCP unavailable") });
  instance.answers.information.push("Connect");
  await assert.rejects(instance.connection.connect(), /MCP unavailable/);
  assert.equal(instance.state.has(approvalKey), false);
  assert.deepEqual(instance.definitions(), []);
  assert.equal(instance.contexts.has("flightRecorder.mcpConnected"), false);
});

test("changing endpoint does not transfer consent or probe the new endpoint", async () => {
  const instance = create();
  instance.answers.information.push("Connect");
  await instance.connection.connect();
  instance.changeOrigin("http://localhost:6200");
  assert.deepEqual(instance.definitions(), []);
  assert.deepEqual(instance.probes, ["http://localhost:5080"]);
  assert.ok(instance.output.some(line => line.includes("approve a different MCP endpoint")));
});

test("an explicitly rebuilt managed release refreshes the definition version at the approved endpoint", async () => {
  const instance = create();
  instance.answers.information.push("Connect");
  await instance.connection.connect();
  instance.setVersion("0.3.0");
  instance.connection.refresh();
  assert.equal(instance.definitions()[0].version, "0.3.0");
  assert.equal(instance.probes.length, 1);
});

for (const options of [{ remoteName: "ssh-remote" }, { trusted: false }]) {
  test(`MCP is inactive in ${options.remoteName ?? "untrusted"} sessions`, async () => {
    const instance = create(options);
    instance.state.set(approvalKey, { origin: "http://localhost:5080" });
    assert.deepEqual(instance.definitions(), []);
    await assert.rejects(instance.connection.connect(), /Local trusted window/);
    assert.deepEqual(instance.probes, []);
  });
}

test("disconnect removes only the extension approval and definition", async () => {
  const instance = create();
  instance.answers.information.push("Connect");
  await instance.connection.connect();
  await instance.connection.disconnect();
  assert.deepEqual(instance.definitions(), []);
  assert.equal(instance.contexts.get("flightRecorder.mcpConnected"), false);
  assert.deepEqual(instance.writes, []);
  assert.equal(instance.probes.length, 1);
});

test("invalid configured URLs cannot be published and produce a diagnostic", () => {
  const instance = create({ origin: "https://example.com" });
  instance.state.set(approvalKey, { origin: "https://example.com" });
  assert.deepEqual(instance.definitions(), []);
  assert.ok(instance.output[0].includes("Cannot publish"));
});

test("unavailable MCP APIs produce an actionable error without crashing activation", async () => {
  const mock = mockVscode();
  delete mock.vscode.lm;
  const integration = registerMcp(mock.vscode, mock.context, { ensureLocal() {} });
  await assert.rejects(integration.connect(), /VS Code 1.101/);
  assert.equal(mock.providers.size, 0);
});
