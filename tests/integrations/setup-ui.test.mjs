import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mockVscode } from "./helpers/vscode.mjs";

const require = createRequire(import.meta.url);
const { registerLocalSetup, dockerGuide, validatePort } = require("../../extensions/flight-recorder/setup.cjs");

function create(options = {}) {
  const mock = mockVscode(options);
  const calls = [];
  let opened = 0;
  let installed = options.installed ?? { state: "not-installed", owned: false };
  const runtime = {
    async preflight(args) { calls.push(["preflight", args]); },
    async status(args) { calls.push(["status", args]); return installed; },
    async setup(args) {
      calls.push(["setup", args]);
      installed = { state: "running", owned: true, origin: `http://localhost:${args.port}`, version: "0.2.0", restart: args.restart };
      return installed;
    },
    async probe(origin) { calls.push(["probe", origin]); },
    async start(args) { calls.push(["start", args]); return { ...installed, state: "running" }; },
    async stop(args) { calls.push(["stop", args]); return { ...installed, state: "stopped" }; },
    async restart(args) { calls.push(["restart", args]); return { ...installed, state: "running" }; },
    async rebuild(args) { calls.push(["rebuild", args]); return { ...installed, state: "running", version: "0.2.0" }; },
    async setRestart(enabled) { calls.push(["setRestart", enabled]); return { ...installed, restart: enabled }; },
    async logs() { calls.push(["logs"]); return "Container diagnostic"; }
  };
  Object.assign(runtime, options.runtime);
  registerLocalSetup(mock.vscode, mock.context, {
    getOrigin: mock.origin, platform: options.platform ?? "win32",
    async open() { opened++; },
    createRecorder(config) { calls.push(["construct", config]); return runtime; }
  });
  return { ...mock, calls, runtime, opened: () => opened, invoke: id => mock.handlers.get(`flightRecorder.${id}`)() };
}

const installed = { state: "running", owned: true, origin: "http://localhost:5080", version: "0.2.0", restart: false };
const errorWith = code => Object.assign(new Error(`failure ${code}`), { code });

test("setup registration has no process, filesystem, network, or configuration side effects", () => {
  const instance = create();
  assert.deepEqual(instance.calls, []);
  assert.equal(instance.state.size, 0);
  assert.deepEqual(instance.writes, []);
  assert.equal(instance.opened(), 0);
  assert.ok(instance.handlers.has("flightRecorder.setup"));
});

for (const options of [{ trusted: false }, { remoteName: "wsl" }, { remoteName: "dev-container" }]) {
  test(`setup rejects ${options.remoteName ?? "untrusted"} before constructing the runtime`, async () => {
    const instance = create(options);
    await instance.invoke("setup");
    assert.deepEqual(instance.calls, []);
    assert.ok(instance.messages.some(message => message.kind === "error"));
  });
}

for (const platform of ["win32", "darwin", "linux"]) {
  test(`${platform} prerequisite failure offers official guidance without installing anything`, async () => {
    const instance = create({ platform, runtime: { async preflight() { throw errorWith("DOCKER_MISSING"); } } });
    instance.answers.error.push("Open Docker Guide");
    await instance.invoke("setup");
    assert.deepEqual(instance.external, [dockerGuide(platform)]);
    assert.equal(instance.calls.filter(([name]) => name === "setup").length, 0);
    assert.equal(instance.contexts.has("flightRecorder.ready"), false);
  });
}

test("setup cancellation at confirmation does not build or save settings", async () => {
  const instance = create();
  instance.answers.input.push("5080");
  instance.answers.pick.push({ enabled: false });
  await instance.invoke("setup");
  assert.equal(instance.calls.some(([name]) => name === "setup"), false);
  assert.equal(instance.state.size, 0);
  assert.deepEqual(instance.writes, []);
});

for (const restart of [false, true]) {
  test(`setup passes explicit restart=${restart} and completes after runtime readiness`, async () => {
    const instance = create();
    instance.answers.input.push("5080");
    instance.answers.pick.push({ enabled: restart });
    instance.answers.information.push("Build and Start", "Open Recorder");
    await instance.invoke("setup");
    const args = instance.calls.find(([name]) => name === "setup")[1];
    assert.equal(args.port, 5080);
    assert.equal(args.restart, restart);
    assert.ok(args.signal instanceof AbortSignal);
    assert.equal(instance.contexts.get("flightRecorder.ready"), true);
    assert.equal(instance.opened(), 1);
    assert.deepEqual(instance.writes, []);
    assert.equal(instance.state.get("localRecorder.current").managed, true);
  });
}

test("an explicit saved server URL is preserved when switching is declined", async () => {
  const instance = create({ origin: "http://localhost:5205" });
  instance.answers.input.push("5081");
  instance.answers.pick.push({ enabled: false });
  instance.answers.information.push("Build and Start");
  await instance.invoke("setup");
  assert.equal(instance.origin(), "http://localhost:5205");
  assert.deepEqual(instance.writes, []);
  assert.equal(instance.opened(), 0);
});

test("an approved alternate port updates only the machine server URL", async () => {
  const instance = create();
  instance.answers.input.push("5081");
  instance.answers.pick.push({ enabled: false });
  instance.answers.information.push("Build and Start", "Use This Recorder", "Open Recorder");
  await instance.invoke("setup");
  assert.equal(instance.origin(), "http://localhost:5081");
  assert.deepEqual(instance.writes, [{ key: "serverUrl", value: "http://localhost:5081", target: 1 }]);
  assert.equal(instance.opened(), 1);
});

test("an existing owned installation is explicitly started without resetting its preferences", async () => {
  const instance = create({ installed: { ...installed, restart: true } });
  instance.answers.information.push("Start Existing", "Open Recorder");
  await instance.invoke("setup");
  assert.ok(instance.calls.some(([name]) => name === "start"));
  assert.equal(instance.calls.some(([name]) => name === "setup" || name === "setRestart"), false);
});

test("a port collision can reuse a verified external recorder without gaining management rights", async () => {
  const instance = create({ runtime: { async setup() { throw errorWith("PORT_IN_USE"); } } });
  instance.answers.input.push("5080");
  instance.answers.pick.push({ enabled: false });
  instance.answers.information.push("Build and Start", "Open Recorder");
  instance.answers.warning.push("Use Existing Recorder");
  await instance.invoke("setup");
  assert.ok(instance.calls.some(([name]) => name === "probe"));
  assert.equal(instance.state.get("localRecorder.current").managed, false);
  await instance.invoke("stop");
  assert.equal(instance.calls.some(([name]) => name === "stop"), false);
});

test("management refuses to operate when the user selected a different external origin", async () => {
  const instance = create({ installed, origin: "http://localhost:5205" });
  await instance.invoke("restart");
  assert.equal(instance.calls.some(([name]) => name === "restart"), false);
  assert.ok(instance.messages.some(message => message.kind === "error" && message.args[0].includes("not this extension")));
});

test("explicit external reuse is not mistaken for management permission by leftover installation metadata", async () => {
  const instance = create({ installed });
  instance.state.set("localRecorder.current", { origin: installed.origin, managed: false });
  await instance.invoke("stop");
  assert.equal(instance.calls.some(([name]) => name === "stop"), false);
  assert.ok(instance.messages.some(message => message.kind === "error" && message.args[0].includes("externally managed")));
});

test("an explicit stop preserves data and clears only readiness context", async () => {
  const instance = create({ installed });
  await instance.invoke("stop");
  assert.ok(instance.calls.some(([name]) => name === "stop"));
  assert.equal(instance.contexts.get("flightRecorder.ready"), false);
  assert.equal(instance.calls.some(([name]) => name === "rebuild"), false);
});

test("changing restart policy is explicit and does not configure OS startup", async () => {
  const instance = create({ installed });
  instance.answers.pick.push({ enabled: true });
  await instance.invoke("configureRestart");
  assert.deepEqual(instance.calls.find(([name]) => name === "setRestart"), ["setRestart", true]);
  assert.deepEqual(instance.external, []);
  assert.ok(instance.messages.some(message => String(message.args[0]).includes("OS startup settings were not changed")));
});

test("cancelled operations do not claim setup succeeded", async () => {
  const instance = create({ runtime: { async preflight({ signal }) {
    assert.equal(signal.aborted, true);
    throw errorWith("CANCELLED");
  } } });
  instance.setCancelled(true);
  await instance.invoke("setup");
  assert.equal(instance.opened(), 0);
  assert.equal(instance.contexts.has("flightRecorder.ready"), false);
  assert.ok(instance.messages.some(message => String(message.args[0]).includes("cancelled")));
});

test("build/readiness failures remain errors without publishing ready state", async () => {
  const instance = create({ runtime: { async setup() { throw errorWith("NOT_READY"); } } });
  instance.answers.input.push("5080");
  instance.answers.pick.push({ enabled: false });
  instance.answers.information.push("Build and Start");
  await instance.invoke("setup");
  assert.equal(instance.opened(), 0);
  assert.equal(instance.contexts.has("flightRecorder.ready"), false);
  assert.ok(instance.messages.some(message => message.kind === "error"));
});

test("port input rejects shell fragments, floats, privileged ports and overflow", () => {
  for (const value of ["0", "80", "5080;echo test", "1e4", "5080.0", "65536", "-1", " 5080"]) {
    assert.equal(typeof validatePort(value), "string");
  }
  for (const value of ["1024", "5080", "65535"]) assert.equal(validatePort(value), undefined);
});
