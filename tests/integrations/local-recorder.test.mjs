import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { LocalRecorder, RecorderError, validateBundle, allowedBundlePath, localEndpoint, validateOrigin } =
  require("../../extensions/flight-recorder/local-recorder.cjs");
const { createExecutor } = require("../../extensions/flight-recorder/docker-process.cjs");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const version = "0.1.1";
const toolNames = ["start_flight_run", "record_flight_event", "complete_flight_run",
  "get_flight_trace", "analyze_flight_run", "list_flight_runs"];
const requiredFiles = ["Dockerfile", ".dockerignore", "NuGet.Config", "package.json", "package-lock.json",
  "LICENSE", "scripts/build-web.mjs", "src/FlightRecorder.Api/FlightRecorder.Api.csproj",
  "src/FlightRecorder.Api/Program.cs", "src/FlightRecorder.Api/WeatherForecast.cs",
  "src/FlightRecorder.Api/appsettings.json", "src/FlightRecorder.Web/index.html",
  "src/FlightRecorder.Web/app.js", "src/FlightRecorder.Web/model.js", "src/FlightRecorder.Web/styles.css"];
const errorCode = (code) => (error) => error instanceof RecorderError && error.code === code;

async function makeBundle(directory, { bundleVersion = version, revision = "a".repeat(40), marker = "" } = {}) {
  const files = [];
  for (const file of [...requiredFiles].sort()) {
    const bytes = Buffer.from(`${file}:${marker}\n`);
    const destination = path.join(directory, "context", file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    files.push({ path: file, sha256: digest(bytes) });
  }
  const manifest = { schemaVersion: 1, extensionVersion: bundleVersion, sourceRevision: revision,
    contentHash: digest(JSON.stringify(files)), files };
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}

function httpMock({ sse = false, bad = null, rows = [], paginate = false } = {}) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, ...options, headers: { ...options.headers } });
    assert.equal(options.redirect, "error");
    if (url.endsWith("/api/runs")) return Response.json(bad === "api" ? { runs: [] } : rows);
    if (url.endsWith("/")) return new Response(bad === "viewer" ? "<html>other service</html>" :
      "<html><title>Agent Flight Recorder</title><div id=app></div></html>", { headers: { "content-type": "text/html" } });
    assert.ok(url.endsWith("/mcp"));
    if (options.method === "DELETE") {
      assert.equal(options.headers["Mcp-Session-Id"], "test-session");
      return new Response(null, { status: 204 });
    }
    assert.equal(options.method, "POST", "readiness must never GET /mcp");
    const request = JSON.parse(options.body);
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = request.method === "initialize" ? {
      protocolVersion: bad === "protocol" ? "1999-01-01" : "2025-03-26",
      capabilities: { tools: {} }, serverInfo: { name: "flightrecorder", version }
    } : {
      tools: (bad === "tools" ? ["other_tool"] : paginate ?
        (request.params.cursor ? toolNames.slice(3) : toolNames.slice(0, 3)) : toolNames)
        .map((name) => ({ name, inputSchema: { type: "object" } })),
      ...(paginate && !request.params.cursor ? { nextCursor: "page-two" } : {})
    };
    const response = { jsonrpc: "2.0", id: bad === "rpc" ? 999 : request.id, result };
    if (sse) {
      // Deliberately leave the SSE stream open: stop after the matching reply.
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`: heartbeat\r\nevent: message\r\ndata: ${JSON.stringify(response)}\r\n\r\n`));
      } }), { headers: { "content-type": "text/event-stream", "mcp-session-id": "test-session" } });
    }
    return Response.json(response, { headers: { "mcp-session-id": "test-session" } });
  };
  return { fetch, calls };
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "recorder test ü $-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = path.join(root, "installed extension", "recorder");
  const storagePath = path.join(root, "global storage");
  const manifest = await makeBundle(bundlePath);
  const http = httpMock(options.http);
  const calls = [];
  const diagnostic = [];
  const docker = { container: null, volume: null, builds: 0, starts: 0, stops: 0, endpoint: "unix:///var/run/docker.sock",
    context: "desktop-linux", daemonId: "test-linux-daemon", engine: "linux", composeVersion: "2.39.1", fail: null };
  const execute = async (file, input, commandOptions) => {
    assert.equal(file, "docker", "end users never invoke host Git, Node, npm or .NET");
    const args = ["--context", "--host"].includes(input[0]) ? input.slice(2) : input;
    calls.push({ file, args: [...args], input: [...input], options: commandOptions });
    if (docker.fail) await docker.fail(args, commandOptions);
    if (commandOptions.signal?.aborted) throw new RecorderError("CANCELLED", "test cancellation");
    let stdout = "";
    if (args[0] === "--version") stdout = "Docker version 28.3.2";
    else if (args[0] === "compose" && args[1] === "version") stdout = docker.composeVersion;
    else if (args[0] === "context" && args[1] === "show") stdout = docker.context;
    else if (args[0] === "context" && args[1] === "inspect") stdout = JSON.stringify(docker.endpoint);
    else if (args[0] === "info") stdout = JSON.stringify({ OSType: docker.engine, ID: docker.daemonId });
    else if (args[0] === "ps") stdout = docker.container?.Id || "";
    else if (args[0] === "inspect") stdout = JSON.stringify([docker.container]);
    else if (args[0] === "volume" && args[1] === "ls") stdout = docker.volume?.Name || "";
    else if (args[0] === "volume" && args[1] === "inspect") stdout = JSON.stringify([docker.volume]);
    else if (args[0] === "compose") {
      const composePath = args[args.indexOf("--file") + 1];
      assert.ok(path.isAbsolute(composePath));
      const compose = JSON.parse(await readFile(composePath, "utf8"));
      const service = compose.services.recorder;
      const operation = args[args.indexOf("--file") + 2];
      if (operation === "build") {
        docker.builds++;
        commandOptions.onOutput?.("build completed");
      } else if (operation === "up") {
        assert.ok(args.includes("--no-build"));
        assert.equal(args[args.indexOf("--pull") + 1], "never");
        docker.starts++;
        docker.volume ||= { Name: compose.volumes.data.name, Labels: compose.volumes.data.labels };
        docker.container = {
          Id: docker.starts.toString(16).padStart(64, "a"), State: { Running: true, Status: "running" },
          Config: { Image: service.image, User: "1654", Labels: { ...service.labels,
            "com.docker.compose.project": compose.name, "com.docker.compose.service": "recorder" } },
          HostConfig: { RestartPolicy: { Name: service.restart },
            PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: service.ports[0].published }] } },
          Mounts: [{ Type: "volume", Name: compose.volumes.data.name, Destination: "/data", RW: true }]
        };
      } else assert.fail(`Unexpected Compose mutation ${operation}`);
    } else if (args[0] === "stop") {
      docker.stops++;
      docker.container.State = { Running: false, Status: "exited" };
    } else if (args[0] === "restart") docker.container.State = { Running: true, Status: "running" };
    else if (args[0] === "update") docker.container.HostConfig.RestartPolicy.Name = args[2];
    else if (args[0] === "logs") stdout = "safe message\npassword=do-not-log\n";
    else assert.fail(`Unexpected Docker command ${JSON.stringify(args)}`);
    return { stdout, stderr: "" };
  };
  const defaults = { storagePath, bundlePath, version, execute, fetch: http.fetch, env: {},
    log: (line) => diagnostic.push(line), portAvailable: async () => true,
    readinessTimeoutMs: 10, requestTimeoutMs: 50, pollIntervalMs: 1 };
  const runtime = new LocalRecorder({ ...defaults, ...options.runtime });
  return { root, storagePath, bundlePath, manifest, http, calls, docker, diagnostic, runtime,
    makeRuntime: (extra = {}) => new LocalRecorder({ ...defaults, ...extra }) };
}

test("constructor and not-installed status are side-effect free", async (t) => {
  const f = await fixture(t);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.runtime.status()).state, "not-installed");
  assert.equal(f.calls.length, 0);
  await assert.rejects(readdir(f.storagePath), { code: "ENOENT" });
});

test("preflight detects executable/Compose/daemon/engine and remote endpoints", async (t) => {
  for (const [name, configure, code] of [
    ["executable", (d) => { d.fail = (args) => { if (args[0] === "--version") throw Object.assign(new Error(), { code: "ENOENT" }); }; }, "DOCKER_MISSING"],
    ["compose absent", (d) => { d.fail = (args) => { if (args[0] === "compose") throw new Error("not a command"); }; }, "COMPOSE_MISSING"],
    ["compose v1", (d) => { d.composeVersion = "1.29.2"; }, "COMPOSE_MISSING"],
    ["stopped daemon", (d) => { d.fail = (args) => { if (args[0] === "info") throw new Error("cannot connect"); }; }, "DOCKER_UNAVAILABLE"],
    ["Windows daemon", (d) => { d.engine = "windows"; }, "UNSUPPORTED_ENGINE"],
    ["SSH", (d) => { d.endpoint = "ssh://remote.example"; }, "REMOTE_DOCKER"],
    ["TCP", (d) => { d.endpoint = "tcp://remote.example:2375"; }, "REMOTE_DOCKER"]
  ]) await t.test(name, async (t) => {
    const f = await fixture(t);
    configure(f.docker);
    await assert.rejects(f.runtime.preflight(), errorCode(code));
    if (code === "REMOTE_DOCKER") assert.ok(!f.calls.some((c) => c.args[0] === "info"), "do not contact remote daemon");
    assert.ok(!f.calls.some((c) => c.args[0] === "build" || c.args.includes("up")));
  });
});

test("preflight honors DOCKER_CONTEXT precedence and DOCKER_HOST with local sockets", async (t) => {
  const f = await fixture(t);
  f.docker.endpoint = "npipe:////./pipe/dockerDesktopLinuxEngine";
  const context = await f.makeRuntime({ env: { DOCKER_CONTEXT: "selected", DOCKER_HOST: "ssh://ignored" } }).preflight();
  assert.equal(context.context, "selected");
  assert.equal(context.endpoint, f.docker.endpoint);
  f.calls.length = 0;
  const host = await f.makeRuntime({ env: { DOCKER_HOST: "unix:///run/user/1000/docker.sock" } }).preflight();
  assert.equal(host.context, null);
  assert.equal(host.endpoint, "unix:///run/user/1000/docker.sock");
  assert.ok(!f.calls.some((c) => c.args[0] === "context"));
  assert.ok(f.calls.some((c) => c.input[0] === "--host"));
  for (const endpoint of ["unix:///var/run/docker.sock", "npipe:////./pipe/docker_engine", "tcp://127.0.0.1:2375", "tcp://[::1]:2375"])
    assert.ok(localEndpoint(endpoint));
  for (const endpoint of ["ssh://localhost", "npipe:////remote/pipe/docker", "tcp://localhost.evil:2375", "tcp://name:password@localhost:2375"])
    assert.ok(!localEndpoint(endpoint));
});

test("preflight accepts Compose plugin major versions >=2, including Docker Desktop 5.3.1", async (t) => {
  const f = await fixture(t);
  for (const value of ["2.0.0", "v2.39.1-desktop.1", "3.0.0", "5.3.1", "v5.3.1", "5.3.1-rc.1+desktop.1"]) {
    f.docker.composeVersion = value;
    assert.equal((await f.runtime.preflight()).composeVersion, value);
  }
  for (const value of ["1.29.2", "v0.9.0", "unknown", "5.x.1", "5.3.1 trailing output", "99999999999999999999.0.0"]) {
    f.docker.composeVersion = value;
    await assert.rejects(f.runtime.preflight(), errorCode("COMPOSE_MISSING"), value);
  }
  assert.ok(!f.calls.some((call) => ["up", "build", "stop", "update", "restart"].some((arg) => call.args.includes(arg))));
});

test("bundle hash, version, exact manifest and portable path rules fail closed", async (t) => {
  for (const mode of ["version", "manifest hash", "file hash", "traversal", "case duplicate", "extra file", "extra key", "unsorted", "missing input"]) {
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      const manifest = structuredClone(f.manifest);
      if (mode === "version") manifest.extensionVersion = "9.0.0";
      if (mode === "manifest hash") manifest.contentHash = "f".repeat(64);
      if (mode === "file hash") await writeFile(path.join(f.bundlePath, "context", "Dockerfile"), "tampered");
      if (mode === "traversal") manifest.files[0].path = "../outside";
      if (mode === "case duplicate") manifest.files.push({ path: "dockerfile", sha256: "a".repeat(64) });
      if (mode === "extra file") await writeFile(path.join(f.bundlePath, "context", ".env"), "must never read this");
      if (mode === "extra key") manifest.workspace = "do not use";
      if (mode === "unsorted") manifest.files.reverse();
      if (mode === "missing input") manifest.files = manifest.files.filter((entry) => entry.path !== "Dockerfile");
      if (["traversal", "case duplicate", "unsorted", "missing input"].includes(mode)) manifest.contentHash = digest(JSON.stringify(manifest.files));
      await writeFile(path.join(f.bundlePath, "manifest.json"), JSON.stringify(manifest));
      await assert.rejects(validateBundle(f.bundlePath, version), errorCode("BUNDLE_INVALID"));
    });
  }
  for (const file of ["../Dockerfile", "C:/Dockerfile", "src\\FlightRecorder.Api\\Program.cs",
    "src/FlightRecorder.Api/obj/secret.cs", "src/FlightRecorder.Api/appsettings.Development.json",
    "src/FlightRecorder.Api/.env", "src/FlightRecorder.Web/../secret.js", "src/FlightRecorder.Web/private.js:secret",
    "src/FlightRecorder.Web/node_modules/a.js", "src/FlightRecorder.Api/bin/A.cs"])
    assert.equal(allowedBundlePath(file), false, file);
});

test("bundle rejects symlink directories without copying external contents", async (t) => {
  const f = await fixture(t);
  const web = path.join(f.bundlePath, "context", "src", "FlightRecorder.Web");
  const outside = path.join(f.root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "index.html"), "external");
  await rm(web, { recursive: true });
  await symlink(outside, web, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(validateBundle(f.bundlePath, version), errorCode("BUNDLE_INVALID"));
});

test("runtime and packager retain the same build-input allowlist", async () => {
  const { REQUIRED_CONTEXT_FILES, isAllowedContextPath } = await import("../../scripts/lib/extension-bundle.mjs");
  assert.deepEqual([...requiredFiles].sort(), [...REQUIRED_CONTEXT_FILES].sort());
  for (const file of [...requiredFiles, "src/FlightRecorder.Api/Controllers/RunsController.cs",
    "src/FlightRecorder.Api/Services/Nested/Helper.cs", "src/FlightRecorder.Api/private.cs",
    "src/FlightRecorder.Api/Controllers/bin/A.cs", "src/FlightRecorder.Web/images/private.svg",
    "src/FlightRecorder.Web/data/private.js", "src/FlightRecorder.Api/appsettings.Local.json"]) {
    assert.equal(allowedBundlePath(file), isAllowedContextPath(file), file);
  }
});

test("setup renders isolated Compose and is idempotent across new runtime objects", async (t) => {
  const f = await fixture(t, { runtime: { env: { COMPOSE_FILE: "malicious.yml", COMPOSE_PROJECT_NAME: "other",
    COMPOSE_PROFILES: "extra", BUILDX_BUILDER: "remote", BUILDKIT_HOST: "ssh://remote" } } });
  const first = await f.runtime.setup();
  assert.equal(first.state, "running");
  assert.equal(first.ready, true);
  assert.equal(first.owned, true);
  assert.equal(first.restart, false);
  assert.equal(first.origin, "http://127.0.0.1:5080");
  const second = await f.makeRuntime().setup({ restart: true });
  assert.equal(second.containerId, first.containerId);
  assert.equal(second.restart, false, "repeated setup does not silently alter persisted preference");
  assert.equal(f.docker.builds, 1);
  assert.equal(f.docker.starts, 1);
  const composeCall = f.calls.find((call) => call.args.includes("build"));
  const composePath = composeCall.args[composeCall.args.indexOf("--file") + 1];
  const compose = JSON.parse(await readFile(composePath, "utf8"));
  assert.equal(compose.name, first.projectName);
  assert.equal(compose.volumes.data.name, first.volumeName);
  assert.equal(first.composePath, composePath);
  assert.equal(first.image, compose.services.recorder.image);
  assert.equal(second.composePath, first.composePath);
  assert.equal(second.image, first.image);
  assert.equal(compose.services.recorder.restart, "no");
  assert.equal(compose.services.recorder.ports[0].host_ip, "127.0.0.1");
  assert.equal(compose.services.recorder.environment.FlightRecorder__EnableDemo, "false");
  assert.equal(compose.services.recorder.user, undefined, "Dockerfile's non-root USER remains authoritative");
  assert.ok(path.isAbsolute(compose.services.recorder.build.context));
  assert.ok(compose.services.recorder.build.context.includes("$$"), "Compose literal dollar paths are escaped");
  assert.ok(!Object.keys(composeCall.options.env).some((key) => /^(COMPOSE_|BUILDX_|BUILDKIT_)/.test(key)));
  assert.equal(await readFile(composeCall.args[composeCall.args.indexOf("--env-file") + 1], "utf8"), "");
  assert.equal(JSON.parse(await readFile(path.join(f.storagePath, "state.json"))).state, "running");
  assert.ok(!f.calls.some((c) => c.args.some((arg) => ["prune", "down", "rm", "--volumes", "use"].includes(arg))));
});

test("successful state exposes installation-scoped image and cleanup metadata", async (t) => {
  const one = await fixture(t);
  const two = await fixture(t);
  const first = await one.runtime.setup();
  const second = await two.runtime.setup();
  for (const state of [first, second]) {
    assert.ok(path.isAbsolute(state.composePath));
    assert.equal(state.projectName, `fr-${state.installationId}`);
    assert.equal(state.volumeName, `fr-${state.installationId}-data`);
    assert.equal(state.image, `flightrecorder-${state.installationId}:${state.version}-${state.contentHash.slice(0, 16)}`);
  }
  assert.equal(first.contentHash, second.contentHash);
  assert.notEqual(first.image, second.image, "same version/hash still uses installation-owned tags");
  assert.notEqual(first.projectName, second.projectName);
  assert.notEqual(first.volumeName, second.volumeName);
  const stopped = await one.runtime.stop();
  assert.equal(stopped.composePath, first.composePath);
  assert.equal(stopped.image, first.image);
  assert.equal((await one.makeRuntime().status()).image, first.image);
});

test("port collisions and invalid ports never create or adopt a container", async (t) => {
  const f = await fixture(t);
  for (const port of [0, 80, 1023, 65536, 5080.5, "5080", "5080;echo test"]) {
    await assert.rejects(f.runtime.setup({ port }), errorCode("PORT_IN_USE"));
  }
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.makeRuntime({ portAvailable: async () => false }).setup(), errorCode("PORT_IN_USE"));
  assert.equal(f.docker.builds, 0);
  assert.equal(f.docker.starts, 0);
  f.docker.fail = (args) => {
    if (args.includes("up")) throw Object.assign(new Error("exit 1"), { stderr: "port is already allocated" });
  };
  await assert.rejects(f.runtime.setup(), errorCode("PORT_IN_USE"), "bind race is classified explicitly");
});

test("restart opt-in persists, applies live, Stop stays stopped, and recreation preserves volume", async (t) => {
  const f = await fixture(t);
  const initial = await f.runtime.setup();
  const enabled = await f.runtime.setRestart(true);
  assert.equal(enabled.restart, true);
  assert.equal(f.docker.container.HostConfig.RestartPolicy.Name, "unless-stopped");
  const stopped = await f.runtime.stop();
  assert.equal(stopped.state, "stopped");
  assert.equal((await f.makeRuntime().status()).state, "stopped");
  const stopCount = f.docker.stops;
  await f.runtime.stop();
  assert.equal(f.docker.stops, stopCount);
  await f.makeRuntime().start();
  assert.equal(f.docker.container.HostConfig.RestartPolicy.Name, "unless-stopped");
  const rebuilt = await f.runtime.rebuild();
  assert.equal(rebuilt.volumeName, initial.volumeName);
  assert.equal(rebuilt.projectName, initial.projectName);
  assert.equal(rebuilt.restart, true);
  assert.equal((await f.runtime.setRestart(false)).restart, false);
  assert.equal((await f.runtime.restart()).state, "running");
});

test("failed rebuild preserves current container, config, image and named volume", async (t) => {
  const f = await fixture(t);
  const original = await f.runtime.setup();
  const config = await readFile(path.join(f.storagePath, "config.json"), "utf8");
  await makeBundle(f.bundlePath, { marker: "updated" });
  f.docker.fail = (args) => { if (args.includes("build")) throw new Error("build failed"); };
  await assert.rejects(f.runtime.rebuild(), errorCode("BUILD_FAILED"));
  assert.equal(f.docker.container.Id, original.containerId);
  assert.equal(f.docker.volume.Name, original.volumeName);
  assert.equal(f.docker.container.State.Running, true);
  assert.equal(await readFile(path.join(f.storagePath, "config.json"), "utf8"), config);
  assert.ok(!(await readdir(f.storagePath)).includes(".operation-lock"));
});

test("a changed context after a long build blocks start without contacting its new daemon", async (t) => {
  const f = await fixture(t);
  const execute = f.runtime.execute;
  const runtime = f.makeRuntime({ execute: async (file, args, options) => {
    const result = await execute(file, args, options);
    if (args.includes("build")) f.docker.endpoint = "ssh://another-engine";
    return result;
  } });
  await assert.rejects(runtime.setup(), errorCode("REMOTE_DOCKER"));
  assert.equal(f.docker.starts, 0);
  assert.equal(f.docker.builds, 1);
});

test("failed replacement cannot confirm the wrong image or persist an unconfirmed configuration", async (t) => {
  const f = await fixture(t);
  await f.runtime.setup();
  const before = await readFile(path.join(f.storagePath, "config.json"), "utf8");
  await makeBundle(f.bundlePath, { marker: "next context" });
  const execute = f.runtime.execute;
  const ignoredUp = f.makeRuntime({ execute: async (file, args, options) => args.includes("up") ?
    { stdout: "", stderr: "" } : execute(file, args, options) });
  await assert.rejects(ignoredUp.rebuild(), errorCode("NOT_READY"));
  assert.equal(await readFile(path.join(f.storagePath, "config.json"), "utf8"), before);
  assert.equal(f.docker.starts, 1);
});

test("restart-policy failures and interrupted updates reconcile actual Docker policy", async (t) => {
  const f = await fixture(t);
  await f.runtime.setup();
  const before = await readFile(path.join(f.storagePath, "config.json"), "utf8");
  f.docker.fail = (args) => { if (args[0] === "update") throw new Error("update rejected"); };
  await assert.rejects(f.runtime.setRestart(true), errorCode("START_FAILED"));
  assert.equal(await readFile(path.join(f.storagePath, "config.json"), "utf8"), before);
  f.docker.fail = null;
  const execute = f.runtime.execute;
  const interrupted = f.makeRuntime({ execute: async (file, args, options) => {
    const result = await execute(file, args, options);
    if (args.includes("update")) throw new RecorderError("CANCELLED", "client interrupted after policy applied");
    return result;
  } });
  await assert.rejects(interrupted.setRestart(true), errorCode("CANCELLED"));
  assert.equal((await f.makeRuntime().status()).restart, true);
  await f.makeRuntime().stop();
  const started = await f.makeRuntime().start();
  assert.equal(started.restart, true);
  assert.equal(JSON.parse(await readFile(path.join(f.storagePath, "config.json"))).restart, true);
});

test("unowned containers, unsafe bindings, unowned volumes and changed daemon are never mutated", async (t) => {
  for (const mode of ["container", "port", "volume", "daemon", "context", "root"]) await t.test(mode, async (t) => {
    const f = await fixture(t);
    await f.runtime.setup();
    const before = f.calls.length;
    if (mode === "container") f.docker.container.Config.Labels["io.flightrecorder.installation"] = "someone-else";
    if (mode === "port") f.docker.container.HostConfig.PortBindings["8080/tcp"][0].HostIp = "0.0.0.0";
    if (mode === "volume") f.docker.volume.Labels["io.flightrecorder.installation"] = "someone-else";
    if (mode === "daemon") f.docker.daemonId = "another-daemon";
    if (mode === "context") f.docker.context = "another-context";
    if (mode === "root") f.docker.container.Config.User = "root";
    await assert.rejects(f.runtime.stop(), errorCode("NOT_OWNED"));
    assert.ok(!f.calls.slice(before).some((call) => ["stop", "update", "restart"].includes(call.args[0])));
  });
});

test("cross-window lock rejects a contender and releases after cancellation", async (t) => {
  const f = await fixture(t);
  let reached;
  const building = new Promise((resolve) => { reached = resolve; });
  f.docker.fail = async (args, options) => {
    if (!args.includes("build")) return;
    reached();
    await new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new RecorderError("CANCELLED", "test cancelled")), { once: true });
    });
  };
  const controller = new AbortController();
  const first = f.runtime.setup({ signal: controller.signal });
  await building;
  await assert.rejects(f.makeRuntime().setup(), errorCode("BUSY"));
  controller.abort();
  await assert.rejects(first, errorCode("CANCELLED"));
  assert.ok(!(await readdir(f.storagePath)).includes(".operation-lock"));
  f.docker.fail = null;
  assert.equal((await f.makeRuntime().setup()).state, "running");
});

test("dead-owner locks recover conservatively and leave a race-safe tombstone", async (t) => {
  const f = await fixture(t);
  const lock = path.join(f.storagePath, ".operation-lock");
  const token = "11111111-2222-3333-4444-555555555555";
  await mkdir(lock, { recursive: true });
  await writeFile(path.join(lock, "owner.json"), JSON.stringify({
    token, pid: 999999, host: hostname(), createdAt: Date.now() - 120_000
  }));
  assert.equal((await f.makeRuntime({ processAlive: () => false }).setup()).state, "running");
  assert.ok((await readdir(f.storagePath)).includes(`.stale-lock-${token}`));
  await mkdir(lock);
  await writeFile(path.join(lock, "owner.json"), "invalid");
  await assert.rejects(f.makeRuntime({ processAlive: () => false }).setup(), errorCode("BUSY"));
});

test("status reconciles stale saved success with stopped or unready actual container", async (t) => {
  const f = await fixture(t);
  await f.runtime.setup();
  f.docker.container.State = { Running: false, Status: "exited" };
  assert.equal((await f.makeRuntime().status()).state, "stopped");
  f.docker.container.State = { Running: true, Status: "running" };
  const unready = f.makeRuntime({ fetch: httpMock({ bad: "api" }).fetch });
  const status = await unready.status();
  assert.equal(status.state, "error");
  assert.equal(status.error.code, "NOT_READY");
  await assert.rejects(unready.start(), errorCode("NOT_READY"));
});

test("interrupted up is not mistaken for rollback; a new runtime discovers the owned container", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const execute = f.runtime.execute;
  const runtime = f.makeRuntime({ execute: async (file, args, options) => {
    const result = await execute(file, args, options);
    if (args.includes("up")) {
      controller.abort();
      throw new RecorderError("CANCELLED", "client interrupted after daemon mutation");
    }
    return result;
  } });
  await assert.rejects(runtime.setup({ signal: controller.signal }), errorCode("CANCELLED"));
  assert.equal(f.docker.container.State.Running, true);
  assert.equal((await f.makeRuntime().status()).state, "running");
  assert.equal((await f.makeRuntime().setup()).containerId, f.docker.container.Id);
  assert.equal(f.docker.starts, 1);
});

test("read-only probe negotiates JSON/SSE MCP sessions, pagination, and never invokes tools", async (t) => {
  for (const sse of [false, true]) await t.test(sse ? "SSE" : "JSON", async (t) => {
    const f = await fixture(t, { http: { sse, paginate: true } });
    const result = await f.runtime.probe("http://localhost:5080");
    assert.equal(result.ready, true);
    assert.equal(result.owned, false);
    assert.equal(result.protocolVersion, "2025-03-26");
    assert.equal(f.calls.length, 0);
    const posts = f.http.calls.filter((call) => call.method === "POST");
    assert.deepEqual(posts.map((call) => JSON.parse(call.body).method),
      ["initialize", "notifications/initialized", "tools/list", "tools/list"]);
    for (const call of posts.slice(1)) {
      assert.equal(call.headers["Mcp-Session-Id"], "test-session");
      assert.equal(call.headers["MCP-Protocol-Version"], "2025-03-26");
    }
    assert.equal(f.http.calls.at(-1).method, "DELETE", "only this probe's own temporary MCP session is closed");
    await assert.rejects(readdir(f.storagePath), { code: "ENOENT" });
  });
});

test("probe rejects malformed URLs, false-positive viewer/API/MCP, and request failures", async (t) => {
  for (const url of ["http://remote.example", "http://localhost.evil", "http://user:pass@localhost", "http://localhost/path",
    "http://localhost?x=1", "file:///tmp", "not a url"]) assert.throws(() => validateOrigin(url), errorCode("NOT_READY"));
  for (const bad of ["viewer", "api", "protocol", "rpc", "tools"]) await t.test(bad, async (t) => {
    const f = await fixture(t, { http: { bad } });
    await assert.rejects(f.runtime.probe("http://127.0.0.1:5080"), errorCode("NOT_READY"));
    assert.deepEqual(f.diagnostic, []);
  });
  const f = await fixture(t);
  const timeout = f.makeRuntime({ fetch: async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }) });
  await assert.rejects(timeout.probe("http://127.0.0.1:5080"), errorCode("NOT_READY"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.runtime.probe("http://127.0.0.1:5080", { signal: controller.signal }), errorCode("CANCELLED"));
});

test("SSE replies with wrong ids time out, and API contents never enter diagnostics", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.makeRuntime({ fetch: httpMock({ sse: true, bad: "rpc" }).fetch })
    .probe("http://localhost:5080"), errorCode("NOT_READY"));
  const privateApi = httpMock({ rows: [{ id: "a".repeat(36), entryPointAgent: "test-agent",
    status: "Succeeded", eventCount: 0, request: "private request should not be logged" }] });
  await f.makeRuntime({ fetch: privateApi.fetch }).probe("http://localhost:5080");
  assert.deepEqual(f.diagnostic, []);
});

test("owned logs include both output streams with credentials redacted", async (t) => {
  const f = await fixture(t);
  await f.runtime.setup();
  const execute = f.runtime.execute;
  const runtime = f.makeRuntime({ execute: async (file, args, options) => args.includes("logs") ?
    { stdout: "ordinary output", stderr: "password=topsecret\nordinary error" } : execute(file, args, options) });
  const logs = await runtime.logs();
  assert.match(logs, /ordinary output/);
  assert.match(logs, /ordinary error/);
  assert.ok(!logs.includes("topsecret"));
});

function childMock() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kills = 0;
  child.kill = () => { child.kills++; return true; };
  return child;
}

test("process adapter uses literal argument arrays, no shell, bounded output and redacted lines", async () => {
  const child = childMock();
  const lines = [];
  let spawnOptions;
  let spawnArgs;
  const execute = createExecutor({ spawn: (file, args, options) => {
    assert.equal(file, "docker");
    spawnOptions = options;
    spawnArgs = args;
    return child;
  } });
  const args = ["compose", "--file", "C:\\Users\\example ü\\source $\\compose.json", "--project-name", "a;echo unsafe"];
  const running = execute("docker", args, { timeoutMs: 100, onOutput: (text) => lines.push(text) });
  child.stdout.write("token=very");
  child.stdout.write("private\nsafe line\n");
  child.exitCode = 0;
  child.emit("close", 0);
  const output = await running;
  assert.deepEqual(spawnArgs, args);
  assert.equal(spawnOptions.shell, false);
  assert.deepEqual(spawnOptions.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(child.kills, 0);
  assert.match(output.stdout, /safe line/);
  assert.equal(lines[0], "token=[redacted]");
});

test("process adapter reports cancellation, timeout, stream error and command failure explicitly", async (t) => {
  for (const mode of ["cancel", "timeout", "stdout", "stderr", "exit", "missing", "limit"]) await t.test(mode, async () => {
    const child = childMock();
    const controller = new AbortController();
    const execute = createExecutor({ spawn: () => child, maxOutputBytes: 30 });
    const promise = execute("docker", ["info"], { signal: controller.signal, timeoutMs: 10 });
    if (mode === "cancel") controller.abort();
    if (mode === "stdout" || mode === "stderr") child[mode].emit("error", new Error("pipe failed"));
    if (mode === "exit") child.emit("close", 7);
    if (mode === "missing") child.emit("error", Object.assign(new Error(), { code: "ENOENT" }));
    if (mode === "limit") child.stdout.write("x".repeat(100));
    await assert.rejects(promise, errorCode(mode === "cancel" ? "CANCELLED" :
      mode === "timeout" ? "COMMAND_TIMEOUT" : mode === "missing" ? "DOCKER_MISSING" : "COMMAND_FAILED"));
    assert.equal(child.kills, ["cancel", "timeout", "stdout", "stderr", "limit"].includes(mode) ? 1 : 0);
  });
});
