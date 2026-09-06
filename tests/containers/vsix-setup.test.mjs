import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, readdir, mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const execute = promisify(childProcess.execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

async function extractVsix(source, destination) {
  if (process.platform === "win32") {
    await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
      "[System.IO.Compression.ZipFile]::ExtractToDirectory($env:RECORDER_TEST_VSIX, $env:RECORDER_TEST_EXTRACT)"], {
      env: { ...process.env, RECORDER_TEST_VSIX: source, RECORDER_TEST_EXTRACT: destination },
      timeout: 60000
    });
  } else {
    await execute("unzip", ["-q", source, "-d", destination], { timeout: 60000 });
  }
}

async function pathsUnder(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, `Unexpected symlink: ${entry.name}`);
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await pathsUnder(join(directory, entry.name), path));
    else files.push(path);
  }
  return files;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test("the released VSIX builds and runs from its own source without a checkout or host SDK commands", {
  timeout: 1200000
}, async context => {
  const manifest = JSON.parse(await readFile(join(root, "extensions", "flight-recorder", "package.json"), "utf8"));
  const vsix = join(root, "artifacts", `flight-recorder-${manifest.version}.vsix`);
  const checksum = (await readFile(`${vsix}.sha256`, "utf8")).trim().split(/\s+/);
  assert.equal(checksum[0], createHash("sha256").update(await readFile(vsix)).digest("hex"));
  assert.equal(checksum[1], basename(vsix));

  const temporary = await mkdtemp(join(tmpdir(), "flight-recorder-vsix-"));
  const storagePath = join(temporary, "user storage");
  const extraction = join(temporary, "release installation");
  const workspace = join(temporary, "unrelated workspace");
  const originalDirectory = process.cwd();
  const originalSpawn = childProcess.spawn;
  const originalExecFile = childProcess.execFile;
  let cleanup;
  const calls = [];
  const logs = [];
  context.after(async () => {
    childProcess.spawn = originalSpawn;
    childProcess.execFile = originalExecFile;
    process.chdir(originalDirectory);
    if (cleanup) {
      await execute(cleanup.command, [...cleanup.prefix, "down", "--volumes", "--remove-orphans"], {
        cwd: cleanup.cwd, env: cleanup.env, timeout: 60000, maxBuffer: 1024 * 1024
      });
    }
    await rm(temporary, { recursive: true, force: true });
  });
  await mkdir(workspace, { recursive: true });
  await extractVsix(vsix, extraction);
  const extensionPath = join(extraction, "extension");
  const bundled = JSON.parse(await readFile(join(extensionPath, "recorder", "manifest.json"), "utf8"));
  assert.equal(bundled.extensionVersion, manifest.version);
  assert.equal(bundled.schemaVersion, 1);
  assert.match(bundled.sourceRevision, /^[0-9a-f]{40,64}$/);
  const archiveFiles = await pathsUnder(extensionPath);
  for (const path of archiveFiles) {
    assert.doesNotMatch(path, /(^|\/)(?:bin|obj|node_modules|\.git|\.squad|\.env(?:\.[^/]*)?)(?:\/|$)/i);
    assert.doesNotMatch(path, /\.(?:db|sqlite|sqlite3)(?:-|$)/i);
    assert.doesNotMatch(path, /appsettings\.(?:Local|Development)\.json$/i);
  }
  for (const file of ["extension.cjs", "setup.cjs", "mcp.cjs", "docker-process.cjs", "local-recorder.cjs",
    "media/setup.md", "recorder/context/Dockerfile", "recorder/context/NuGet.Config"]) {
    assert.ok(archiveFiles.includes(file), `Missing packaged input: ${file}`);
  }
  assert.equal(await readFile(join(extensionPath, "recorder", "context", "NuGet.Config"), "utf8"),
    await readFile(join(root, "NuGet.Config"), "utf8"));

  // Audit the shipped runtime's real process runner, not a replacement implementation.
  const audit = (command, args, options) => {
    assert.match(basename(command), /^docker(?:\.exe)?$/i, `Installed runtime invoked a host dependency: ${command}`);
    assert.notEqual(options?.shell, true);
    calls.push(args);
    const compose = args.indexOf("compose");
    if (compose < 0 || args[compose + 1] === "version") return;
    const projectIndex = args.indexOf("--project-name");
    const fileIndex = args.indexOf("--file");
    assert.ok(projectIndex > compose && fileIndex > compose, "Managed Compose must have an explicit project and file");
    const file = resolve(args[fileIndex + 1]);
    const localPath = relative(storagePath, file);
    assert.ok(localPath && !localPath.startsWith("..") && !isAbsolute(localPath), "Compose file escaped isolated storage");
    assert.notEqual(args[projectIndex + 1], "flightrecorder");
    const actions = new Set(["build", "up", "ps", "stop", "start", "restart", "logs", "config", "port", "down"]);
    const action = args.findIndex((argument, index) => index > Math.max(projectIndex + 1, fileIndex + 1) && actions.has(argument));
    if (action >= 0) {
      cleanup = { command, prefix: args.slice(0, action), cwd: options?.cwd, env: options?.env,
        project: args[projectIndex + 1] };
    }
  };
  childProcess.spawn = (command, args, options) => {
    audit(command, args, options);
    return originalSpawn(command, args, options);
  };
  childProcess.execFile = (command, args, ...rest) => {
    audit(command, args, typeof rest[0] === "object" ? rest[0] : undefined);
    return originalExecFile(command, args, ...rest);
  };
  const { LocalRecorder } = require(join(extensionPath, "local-recorder.cjs"));
  const options = {
    storagePath, bundlePath: join(extensionPath, "recorder"), version: manifest.version,
    log: text => { logs.push(String(text)); if (logs.length > 40) logs.shift(); }
  };
  process.chdir(workspace);
  const recorder = new LocalRecorder(options);
  const port = await freePort();
  let state;
  try {
    state = await recorder.setup({ port, restart: false });
  } catch (error) {
    context.diagnostic(logs.join("\n"));
    throw error;
  }
  assert.equal(state.state, "running");
  assert.equal(state.owned, true);
  assert.equal(state.restart, false);
  assert.equal(state.version, manifest.version);
  assert.ok(cleanup, "No scoped cleanup target was captured");
  const origin = state.origin;
  await recorder.probe(origin);
  const info = await fetch(`${origin}/api/info`, { signal: AbortSignal.timeout(15000) });
  assert.equal(info.status, 200);
  assert.equal((await info.json()).version, manifest.version);
  const html = await (await fetch(`${origin}/`, { signal: AbortSignal.timeout(15000) })).text();
  const assets = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)].map(match => new URL(match[1], origin));
  assert.ok(assets.some(url => url.pathname.endsWith(".js")));
  assert.ok(assets.some(url => url.pathname.endsWith(".css")));
  for (const asset of assets) {
    assert.equal(asset.origin, new URL(origin).origin);
    const response = await fetch(asset, { redirect: "error", signal: AbortSignal.timeout(15000) });
    assert.ok(response.ok, `Packaged viewer asset failed: ${asset.pathname}`);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  const docker = async (...args) => (await execute("docker", args, { timeout: 60000, maxBuffer: 1024 * 1024 })).stdout.trim();
  const ids = (await docker("ps", "--quiet", "--filter", `label=com.docker.compose.project=${cleanup.project}`)).split(/\r?\n/).filter(Boolean);
  assert.equal(ids.length, 1);
  const containerId = ids[0];
  const policy = () => docker("inspect", "--format", "{{.HostConfig.RestartPolicy.Name}}", containerId);
  assert.equal(await policy(), "no");
  const bindings = JSON.parse(await docker("inspect", "--format", "{{json .HostConfig.PortBindings}}", containerId));
  assert.equal(bindings["8080/tcp"][0].HostIp, "127.0.0.1");
  assert.equal(bindings["8080/tcp"][0].HostPort, String(port));
  assert.ok(!["", "0", "root"].includes(await docker("inspect", "--format", "{{.Config.User}}", containerId)));

  async function api(path, body) {
    const response = await fetch(new URL(`/api/${path}`, origin), {
      method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error", signal: AbortSignal.timeout(15000)
    });
    assert.ok(response.ok, `Synthetic acceptance API ${path} returned ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  }
  const trace = await api("runs", {
    request: "Synthetic packaged VSIX acceptance", entryPointAgent: "vsix-test",
    requestingIdentity: "test", recordingMode: 1
  });
  await api(`runs/${trace.id}/events`, { name: "Packaged build verified", type: 3, status: 1 });
  await api(`runs/${trace.id}/complete`, {});
  const snapshot = await api(`runs/${trace.id}`);
  await recorder.setup({ port, restart: false });
  assert.equal((await docker("ps", "--quiet", "--filter", `label=com.docker.compose.project=${cleanup.project}`)), containerId);
  await recorder.setRestart(true);
  assert.equal(await policy(), "unless-stopped");
  await recorder.stop();
  assert.equal((await recorder.status()).state, "stopped");
  const resumed = new LocalRecorder(options);
  assert.equal((await resumed.start()).restart, true);
  assert.deepEqual(await api(`runs/${trace.id}`), snapshot);
  await resumed.rebuild();
  assert.deepEqual(await api(`runs/${trace.id}`), snapshot);
  assert.equal((await resumed.setRestart(false)).restart, false);
  assert.ok(calls.some(args => args.includes("build")));
  context.diagnostic("The extracted VSIX built and served API/viewer/MCP using only Docker, with scoped resources and preserved synthetic traces.");
  context.diagnostic("Docker build cache is retained; cleanup removes only this isolated test project's containers and volume.");
});
