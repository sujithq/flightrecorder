"use strict";

const nodeFs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const os = require("node:os");
const { randomUUID, createHash } = require("node:crypto");
const { RecorderError, createExecutor, sanitize } = require("./docker-process.cjs");

const OWNER = "io.flightrecorder.installation";
const MANAGED = "io.flightrecorder.managed";
const VERSION = "io.flightrecorder.version";
const HASH = "io.flightrecorder.content-hash";
const PROJECT = "com.docker.compose.project";
const SERVICE = "com.docker.compose.service";
const TOOLS = ["start_flight_run", "record_flight_event", "complete_flight_run",
  "get_flight_trace", "analyze_flight_run", "list_flight_runs"];
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code, message) => { throw new RecorderError(code, message); };
const cancelled = (signal) => { if (signal?.aborted) fail("CANCELLED", "Operation cancelled."); };
const validVersion = (value) => typeof value === "string" && value.length <= 64 &&
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(value);
const validHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
// Must stay aligned with scripts/lib/extension-bundle.mjs. It is not shipped as a
// dependency: the installed runtime needs neither the repository nor host Node.
const REQUIRED_CONTEXT_FILES = [
  ".dockerignore", "Dockerfile", "LICENSE", "NuGet.Config", "package-lock.json", "package.json",
  "scripts/build-web.mjs", "src/FlightRecorder.Api/FlightRecorder.Api.csproj",
  "src/FlightRecorder.Api/Program.cs", "src/FlightRecorder.Api/WeatherForecast.cs",
  "src/FlightRecorder.Api/appsettings.json", "src/FlightRecorder.Web/app.js",
  "src/FlightRecorder.Web/index.html", "src/FlightRecorder.Web/model.js", "src/FlightRecorder.Web/styles.css"
];

function validatePort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail("PORT_IN_USE", "Choose an integer loopback port from 1024 through 65535.");
  return port;
}

function validateOrigin(value) {
  let url;
  try { url = new URL(value); } catch { fail("NOT_READY", "Recorder URL must be an absolute loopback HTTP URL."); }
  if (!["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    fail("NOT_READY", "Recorder URL must be a loopback HTTP origin without credentials, a path, query, or fragment.");
  }
  return url.origin;
}

function localEndpoint(endpoint) {
  if (typeof endpoint !== "string") return false;
  if (/^unix:\/\/\/[^?#\r\n]+$/.test(endpoint)) return true;
  if (/^npipe:\/\/\/\/\.\/pipe\/[^\\/?#\r\n]+$/i.test(endpoint)) return true;
  try {
    const url = new URL(endpoint);
    return url.protocol === "tcp:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !!url.port && !url.username && !url.password && !url.search && !url.hash && ["", "/"].includes(url.pathname);
  } catch { return false; }
}

function cleanEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(COMPOSE_|BUILDX_|BUILDKIT_)/i.test(key) && !/^DOCKER_(HOST|CONTEXT)$/i.test(key)));
}

// Kept deliberately small and independent of workspace files or Git.
function allowedBundlePath(file) {
  if (typeof file !== "string" || file.includes("\\") || !file || file.startsWith("/") ||
      file.split("/").some((part) => !part || part === "." || part === ".." ||
        /[<>:"|?*\x00-\x1f\x7f]/.test(part) || /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return false;
  if (REQUIRED_CONTEXT_FILES.includes(file)) return true;
  if (file.split("/").some((part) => part.startsWith(".") ||
    /^(bin|obj|wwwroot|node_modules|data|traces|logs|artifacts|coverage|dist|build|testresults)$/i.test(part))) return false;
  return /^src\/FlightRecorder\.Api\/(?:Controllers|Models|Services|Tools)\/(?:[^/]+\/)*[^/]+\.cs$/.test(file) ||
    /^src\/FlightRecorder\.Web\/[^/]+\.(?:js|css|html)$/.test(file);
}

async function regularFile(fs, root, relative) {
  let location = root;
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail("BUNDLE_INVALID", "Bundle context must be a regular directory.");
  const segments = relative.split("/");
  for (let index = 0; index < segments.length; index++) {
    location = path.join(location, segments[index]);
    const info = await fs.lstat(location);
    if (info.isSymbolicLink() || (index === segments.length - 1 ? !info.isFile() : !info.isDirectory())) {
      fail("BUNDLE_INVALID", "Bundle contains a non-regular file or symbolic link.");
    }
  }
  return location;
}

/** Validate the shipped manifest/context; exported for the packaged-artifact smoke. */
async function validateBundle(bundlePath, version, { fs = nodeFs, signal } = {}) {
  try {
    cancelled(signal);
    const manifestPath = await regularFile(fs, bundlePath, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const keys = Object.keys(manifest).sort().join(",");
    if (keys !== "contentHash,extensionVersion,files,schemaVersion,sourceRevision" ||
        manifest.schemaVersion !== 1 || manifest.extensionVersion !== version || !validVersion(version) ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.sourceRevision) || !validHash(manifest.contentHash) ||
        !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 10_000) {
      fail("BUNDLE_INVALID", "The bundled recorder manifest is invalid or does not match this extension version.");
    }
    const contextPath = path.join(bundlePath, "context");
    let previous = "";
    const seen = new Set();
    for (const entry of manifest.files) {
      cancelled(signal);
      if (!entry || Object.keys(entry).sort().join(",") !== "path,sha256" ||
          !allowedBundlePath(entry.path) || !validHash(entry.sha256) || entry.path <= previous ||
          seen.has(entry.path.toLowerCase())) fail("BUNDLE_INVALID", "The bundle file list is not a sorted, safe allowlist.");
      previous = entry.path;
      seen.add(entry.path.toLowerCase());
      const file = await regularFile(fs, contextPath, entry.path);
      if (hash(await fs.readFile(file)) !== entry.sha256) fail("BUNDLE_INVALID", "A bundled recorder file failed its SHA-256 check.");
    }
    if (hash(JSON.stringify(manifest.files)) !== manifest.contentHash) fail("BUNDLE_INVALID", "Bundle content hash does not match its manifest.");
    for (const required of REQUIRED_CONTEXT_FILES) {
      if (!seen.has(required.toLowerCase())) fail("BUNDLE_INVALID", "The bundle is missing a required build input.");
    }
    // Reject extras without reading their contents. Docker must see only verified inputs.
    const walk = async (dir, prefix = "") => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        cancelled(signal);
        const name = prefix + entry.name;
        if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(path.join(dir, entry.name), `${name}/`);
        else if (!entry.isFile() || entry.isSymbolicLink() || !manifest.files.some((item) => item.path === name)) {
          fail("BUNDLE_INVALID", "Bundle context contains an unlisted file or symbolic link.");
        }
      }
    };
    await walk(contextPath);
    return { manifest, contextPath };
  } catch (error) {
    if (error instanceof RecorderError) throw error;
    fail("BUNDLE_INVALID", "The bundled recorder could not be read. Reinstall the trusted VSIX.");
  }
}

function portAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      if (["EADDRINUSE", "EACCES"].includes(error.code)) resolve(false);
      else reject(new RecorderError("PORT_IN_USE", "Unable to check the selected loopback port."));
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close((error) => error ? reject(error) : resolve(true)));
  });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    // Permission errors and PID reuse are never treated as permission to break a lock.
    return error.code !== "ESRCH";
  }
}

/**
 * All mutations require explicit UI consent/trust gates in the caller.
 * execute is createExecutor's interface; fetch uses the standard Fetch interface.
 * Optional fs (fs/promises), env, portAvailable, processAlive, now and timeouts
 * make tests independent of Docker and HTTP. Construction is side-effect free.
 */
class LocalRecorder {
  constructor({ storagePath, bundlePath, version, log = () => {}, execute = createExecutor(),
    fetch = globalThis.fetch, fs = nodeFs, env = process.env, portAvailable: checkPort = portAvailable,
    processAlive = alive, now = Date.now, commandTimeoutMs = 30_000, buildTimeoutMs = 20 * 60_000,
    readinessTimeoutMs = 60_000, requestTimeoutMs = 5_000, pollIntervalMs = 1_000 } = {}) {
    if (!storagePath || !bundlePath || !validVersion(version)) fail("BUNDLE_INVALID", "Storage, bundle paths and a valid extension version are required.");
    this.storagePath = path.resolve(storagePath);
    this.bundlePath = path.resolve(bundlePath);
    this.version = version;
    this.log = (text) => log(sanitize(text));
    this.execute = execute;
    this.fetch = fetch;
    this.fs = fs;
    this.env = { ...env };
    if (process.platform === "win32") {
      // Windows environment keys are case-insensitive; a spread object is not.
      for (const key of ["DOCKER_CONTEXT", "DOCKER_HOST"]) {
        const entry = Object.entries(env).find(([name]) => name.toUpperCase() === key);
        if (entry) this.env[key] = entry[1];
      }
    }
    this.checkPort = checkPort;
    this.processAlive = processAlive;
    this.now = now;
    this.timeouts = { commandTimeoutMs, buildTimeoutMs, readinessTimeoutMs, requestTimeoutMs, pollIntervalMs };
  }

  async _command(args, { signal, binding, timeoutMs, stream = false, includeStderr = false, code = "DOCKER_UNAVAILABLE" } = {}) {
    cancelled(signal);
    // Pin the verified endpoint, not a mutable context alias. Context remains part
    // of the ownership record, but editing it cannot redirect an in-flight command.
    const prefix = binding ? ["--host", binding.endpoint] : [];
    const env = binding ? cleanEnvironment(this.env) : { ...this.env };
    try {
      const result = await this.execute("docker", [...prefix, ...args], {
        cwd: os.tmpdir(), env, signal, timeoutMs: timeoutMs ?? this.timeouts.commandTimeoutMs,
        onOutput: stream ? this.log : undefined
      });
      cancelled(signal);
      return (includeStderr ? `${result.stdout}\n${result.stderr}` : result.stdout).trim();
    } catch (error) {
      if (error.code === "CANCELLED") throw error;
      if (error.code === "ENOENT" || error.code === "DOCKER_MISSING") fail("DOCKER_MISSING", "Docker is not installed or is not available on PATH.");
      const diagnostic = sanitize(`${error.message || ""}\n${error.stderr || ""}`);
      if (stream) this.log(diagnostic);
      if (/address already in use|port is already allocated|failed to bind host port/i.test(diagnostic)) {
        fail("PORT_IN_USE", "The selected loopback port is already in use. Reuse a verified recorder or choose another port.");
      }
      fail(code, `${code === "BUILD_FAILED" ? "Recorder image build failed" : code === "START_FAILED" ? "Recorder container operation failed" :
        code === "COMPOSE_MISSING" ? "Docker Compose plugin version 2 or newer is required" : "Docker is unavailable"}; check Docker and the diagnostic output.`);
    }
  }

  async preflight({ signal } = {}) {
    await this._command(["--version"], { signal });
    const compose = await this._command(["compose", "version", "--short"], { signal, code: "COMPOSE_MISSING" });
    const composeVersion = /^v?(\d+)\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(compose);
    const composeMajor = Number(composeVersion?.[1]);
    if (!Number.isSafeInteger(composeMajor) || composeMajor < 2) {
      fail("COMPOSE_MISSING", "Docker Compose plugin version 2 or newer is required.");
    }
    let context = this.env.DOCKER_CONTEXT?.trim() || null;
    let endpoint;
    if (!context && this.env.DOCKER_HOST?.trim()) endpoint = this.env.DOCKER_HOST.trim();
    else {
      context ||= await this._command(["context", "show"], { signal });
      const value = await this._command(["context", "inspect", context, "--format", "{{json .Endpoints.docker.Host}}"], { signal });
      try { endpoint = JSON.parse(value); } catch { fail("DOCKER_UNAVAILABLE", "Docker context endpoint could not be verified."); }
    }
    if (!localEndpoint(endpoint)) fail("REMOTE_DOCKER", "Only a local Docker socket, named pipe, or loopback TCP endpoint is supported. No context was changed.");
    const binding = { context, endpoint };
    const raw = await this._command(["info", "--format", '{"OSType":"{{.OSType}}","ID":"{{.ID}}"}'], { signal, binding });
    let info;
    try { info = JSON.parse(raw); } catch { fail("DOCKER_UNAVAILABLE", "Docker daemon information could not be verified."); }
    if (info.OSType !== "linux") fail("UNSUPPORTED_ENGINE", "Switch Docker to a Linux-container engine before local setup.");
    if (typeof info.ID !== "string" || !info.ID) fail("DOCKER_UNAVAILABLE", "Docker daemon identity could not be verified.");
    return { ...binding, daemonId: info.ID, engine: "linux", composeVersion: compose };
  }

  async _json(file, optional = false) {
    try {
      const root = await this.fs.lstat(this.storagePath);
      if (!root.isDirectory() || root.isSymbolicLink()) fail("NOT_OWNED", "Managed storage is not a regular directory.");
      const location = path.join(this.storagePath, file);
      const stat = await this.fs.lstat(location);
      if (!stat.isFile() || stat.isSymbolicLink()) fail("NOT_OWNED", "Managed installation metadata is not a regular file.");
      return JSON.parse(await this.fs.readFile(location, "utf8"));
    } catch (error) {
      if (optional && error.code === "ENOENT") return null;
      if (error instanceof RecorderError) throw error;
      fail("NOT_OWNED", "Managed installation metadata could not be verified.");
    }
  }

  async _atomic(file, value, raw = false) {
    const temporary = path.join(this.storagePath, `.write-${randomUUID()}`);
    try {
      await this.fs.writeFile(temporary, raw ? value : JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
      await this.fs.rename(temporary, path.join(this.storagePath, file));
    } finally { await this.fs.rm(temporary, { force: true }); }
  }

  async _lock(signal, action) {
    try { return await this._locked(signal, action); } catch (error) {
      if (error instanceof RecorderError) throw error;
      this.log(`Managed storage operation failed: ${error.code || "filesystem error"}.`);
      fail("NOT_OWNED", "Managed storage could not be accessed safely. Check storage permissions and available disk space.");
    }
  }

  async _locked(signal, action) {
    cancelled(signal);
    await this.fs.mkdir(this.storagePath, { recursive: true, mode: 0o700 });
    const stat = await this.fs.lstat(this.storagePath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("NOT_OWNED", "Managed storage must be a regular local directory.");
    const token = randomUUID();
    const candidate = path.join(this.storagePath, `.lock-candidate-${token}`);
    const lock = path.join(this.storagePath, ".operation-lock");
    const owner = { token, pid: process.pid, host: os.hostname(), createdAt: this.now() };
    let acquired = false;
    try {
      await this.fs.mkdir(candidate);
      await this.fs.writeFile(path.join(candidate, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await this.fs.rename(candidate, lock); acquired = true; break; } catch (error) {
          if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code)) throw error;
          let previous;
          try { previous = JSON.parse(await this.fs.readFile(path.join(lock, "owner.json"), "utf8")); }
          catch { fail("BUSY", "Another recorder operation holds an unverifiable lock. Do not remove a live operation's lock."); }
          if (!/^[a-f0-9-]{36}$/.test(previous.token) || !Number.isSafeInteger(previous.pid) || previous.pid <= 0 ||
              previous.host !== os.hostname() || !Number.isFinite(previous.createdAt) ||
              this.now() - previous.createdAt < 30_000 || this.processAlive(previous.pid)) {
            fail("BUSY", "Another recorder operation is active in this installation.");
          }
          // Keep the nonempty tombstone. A competing stale recoverer cannot rename
          // a newly acquired lock over it (POSIX and Windows both refuse that).
          try { await this.fs.rename(lock, path.join(this.storagePath, `.stale-lock-${previous.token}`)); }
          catch { fail("BUSY", "Another window is recovering the recorder operation lock."); }
        }
      }
      if (!acquired) fail("BUSY", "Unable to acquire the recorder operation lock.");
      cancelled(signal);
      return await action();
    } finally {
      if (acquired) await this.fs.rm(lock, { recursive: true, force: true });
      await this.fs.rm(candidate, { recursive: true, force: true });
    }
  }

  _identityValid(identity) {
    return identity?.schemaVersion === 1 && /^[a-f0-9]{32}$/.test(identity.installId) &&
      identity.projectName === `fr-${identity.installId}` && identity.volumeName === `fr-${identity.installId}-data` &&
      localEndpoint(identity.docker?.endpoint) && typeof identity.docker?.daemonId === "string";
  }

  async _installation(binding, required = true) {
    const identity = await this._json("installation.json", true);
    if (!identity) {
      if (required) fail("NOT_INSTALLED", "Set up the local recorder first.");
      return null;
    }
    if (!this._identityValid(identity)) fail("NOT_OWNED", "The installation ownership record is invalid.");
    if (binding && ["context", "endpoint", "daemonId"].some((key) => identity.docker[key] !== binding[key])) {
      fail("NOT_OWNED", "The effective Docker context or daemon differs from this installation. No resources were changed.");
    }
    return identity;
  }

  _labels(identity, config) {
    return { [OWNER]: identity.installId, [MANAGED]: "true",
      ...(config ? { [VERSION]: config.version, [HASH]: config.contentHash } : {}) };
  }

  _configValid(config) {
    return config && validVersion(config.version) && validHash(config.contentHash) &&
      Number.isInteger(config.port) && config.port >= 1024 && config.port <= 65535 && typeof config.restart === "boolean";
  }

  _paths(identity, config) {
    const directory = path.join(this.storagePath, "versions", `${config.version}-${config.contentHash}`);
    return {
      directory, contextPath: path.join(directory, "context"), composePath: path.join(directory, "compose.json"),
      image: `flightrecorder-${identity.installId}:${config.version.replace(/\+/g, "_")}-${config.contentHash.slice(0, 16)}`
    };
  }

  _compose(identity, config) {
    const { contextPath, image } = this._paths(identity, config);
    return {
      name: identity.projectName,
      services: { recorder: {
        build: { context: contextPath.replace(/\$/g, "$$$$"), dockerfile: "Dockerfile" },
        image, labels: this._labels(identity, config), restart: config.restart ? "unless-stopped" : "no",
        ports: [{ target: 8080, published: String(config.port), host_ip: "127.0.0.1", protocol: "tcp" }],
        volumes: [{ type: "volume", source: "data", target: "/data" }],
        environment: { FlightRecorder__EnableDemo: "false", FlightRecorder__PublicBaseUrl: `http://127.0.0.1:${config.port}`,
          FlightRecorder__Storage__DataDirectory: "/data", FlightRecorder__ReleaseVersion: config.version }
      } },
      volumes: { data: { name: identity.volumeName, labels: this._labels(identity) } }
    };
  }

  async _stage(identity, config, bundle, signal) {
    const { directory, contextPath } = this._paths(identity, config);
    await this.fs.mkdir(path.dirname(directory), { recursive: true });
    const parent = await this.fs.lstat(path.dirname(directory));
    if (!parent.isDirectory() || parent.isSymbolicLink()) fail("NOT_OWNED", "Versioned storage must not be a symbolic link.");
    const staging = path.join(this.storagePath, "versions", `.stage-${randomUUID()}`);
    await this.fs.mkdir(path.join(staging, "context"), { recursive: true });
    try {
      for (const entry of bundle.manifest.files) {
        cancelled(signal);
        const source = await regularFile(this.fs, bundle.contextPath, entry.path);
        const bytes = await this.fs.readFile(source);
        if (hash(bytes) !== entry.sha256) fail("BUNDLE_INVALID", "Bundle changed while staging.");
        const destination = path.join(staging, "context", ...entry.path.split("/"));
        await this.fs.mkdir(path.dirname(destination), { recursive: true });
        await this.fs.writeFile(destination, bytes, { flag: "wx" });
        // Do not let a restrictive host umask make copied appsettings/web assets
        // unreadable to the existing Dockerfile's non-root runtime user.
        await this.fs.chmod(destination, 0o644);
      }
      await this.fs.writeFile(path.join(staging, "manifest.json"), JSON.stringify(bundle.manifest));
      try { await this.fs.rename(staging, directory); } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
        // Existing versioned contexts are reused only after the same full validation.
        const existing = await validateBundle(directory, config.version, { fs: this.fs, signal });
        if (existing.manifest.contentHash !== config.contentHash) fail("BUNDLE_INVALID", "Staged context does not match the requested bundle.");
      }
      await this._writeCompose(identity, config);
      return contextPath;
    } finally { await this.fs.rm(staging, { recursive: true, force: true }); }
  }

  async _writeCompose(identity, config) {
    const { directory } = this._paths(identity, config);
    for (const dir of [path.dirname(directory), directory]) {
      const info = await this.fs.lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) fail("NOT_OWNED", "Versioned storage must be a regular directory.");
    }
    // Re-render rather than trusting an old Compose file or any workspace config.
    await this._atomic(path.relative(this.storagePath, path.join(directory, "compose.json")), this._compose(identity, config));
    await this._atomic(path.relative(this.storagePath, path.join(directory, "empty.env")), "", true);
  }

  async _composeCommand(identity, config, args, signal, code) {
    const { directory, composePath } = this._paths(identity, config);
    return this._command(["compose", "--project-name", identity.projectName, "--project-directory", directory,
      "--env-file", path.join(directory, "empty.env"), "--file", composePath, ...args], {
      binding: identity.docker, signal, code, stream: true,
      timeoutMs: args[0] === "build" ? this.timeouts.buildTimeoutMs : this.timeouts.commandTimeoutMs
    });
  }

  async _volume(identity, signal) {
    const names = await this._command(["volume", "ls", "--filter", `name=^${identity.volumeName}$`, "--format", "{{.Name}}"],
      { binding: identity.docker, signal });
    if (!names) return;
    if (names !== identity.volumeName) fail("NOT_OWNED", "Volume identity could not be verified.");
    const result = await this._inspect(["volume", "inspect", identity.volumeName], identity, signal);
    if (result.length !== 1 || result[0].Name !== identity.volumeName ||
        result[0].Labels?.[OWNER] !== identity.installId || result[0].Labels?.[MANAGED] !== "true") {
      fail("NOT_OWNED", "The persistent volume is not owned by this installation.");
    }
  }

  async _inspect(args, identity, signal) {
    const raw = await this._command(args, { binding: identity.docker, signal });
    try {
      const result = JSON.parse(raw);
      if (!Array.isArray(result)) throw new Error();
      return result;
    } catch { fail("DOCKER_UNAVAILABLE", "Docker resource state could not be verified."); }
  }

  async _container(identity, signal) {
    const ids = await this._command(["ps", "--all", "--filter", `label=${PROJECT}=${identity.projectName}`, "--format", "{{.ID}}"],
      { binding: identity.docker, signal });
    if (!ids) return null;
    if (!/^[a-f0-9]{12,64}$/.test(ids)) fail("NOT_OWNED", "The installation project contains unexpected or multiple containers.");
    const rows = await this._inspect(["inspect", ids], identity, signal);
    const container = rows[0];
    const labels = container?.Config?.Labels;
    if (rows.length !== 1 || !/^[a-f0-9]{12,64}$/.test(container?.Id) ||
        labels?.[OWNER] !== identity.installId || labels?.[MANAGED] !== "true" ||
        labels?.[PROJECT] !== identity.projectName || labels?.[SERVICE] !== "recorder" ||
        !validVersion(labels?.[VERSION]) || !validHash(labels?.[HASH])) fail("NOT_OWNED", "Container ownership could not be verified.");
    const bindings = container.HostConfig?.PortBindings?.["8080/tcp"];
    const port = Number(bindings?.[0]?.HostPort);
    if (bindings?.length !== 1 || bindings[0].HostIp !== "127.0.0.1" || !Number.isInteger(port) || port < 1024 || port > 65535 ||
        Object.keys(container.HostConfig.PortBindings).length !== 1 ||
        container.Mounts?.length !== 1 ||
        !container.Mounts?.some((mount) => mount.Type === "volume" && mount.Name === identity.volumeName && mount.Destination === "/data" && mount.RW) ||
        !["no", "unless-stopped"].includes(container.HostConfig?.RestartPolicy?.Name) ||
        !container.Config.User || ["root", "0"].includes(container.Config.User.split(":")[0])) {
      fail("NOT_OWNED", "Owned container configuration is unsafe or differs from the managed deployment.");
    }
    container.recorderConfig = { version: labels[VERSION], contentHash: labels[HASH], port,
      restart: container.HostConfig.RestartPolicy.Name === "unless-stopped" };
    if (container.Config.Image !== this._paths(identity, container.recorderConfig).image) fail("NOT_OWNED", "Container image identity does not match the installation.");
    return container;
  }

  _state(identity, config, container) {
    const actual = container?.recorderConfig || config;
    const resources = identity && actual ? this._paths(identity, actual) : null;
    const state = !actual ? "not-installed" : container?.State?.Running ?
      (container.State.Status === "running" && container.State.Health?.Status !== "unhealthy" ? "running" : "error") :
      (container && !["exited", "created"].includes(container.State?.Status) ? "error" : "stopped");
    return {
      state, origin: actual ? `http://127.0.0.1:${actual.port}` : null, version: actual?.version ?? null,
      restart: actual?.restart ?? false, owned: !!identity, ready: false,
      ...(identity ? { projectName: identity.projectName, volumeName: identity.volumeName,
        installationId: identity.installId, storagePath: this.storagePath } : {}),
      ...(actual ? { port: actual.port, contentHash: actual.contentHash, updateAvailable: actual.version !== this.version } : {}),
      // Scoped metadata for diagnostics and isolated smoke-test cleanup. The
      // runtime exposes no destructive cleanup or volume-deletion operation.
      ...(resources ? { composePath: resources.composePath, image: resources.image } : {}),
      ...(container ? { containerId: container.Id, containerStatus: container.State?.Status } : {})
    };
  }

  async _savedConfig() {
    const config = await this._json("config.json", true);
    if (config && !this._configValid(config)) fail("NOT_OWNED", "Managed recorder configuration is invalid.");
    return config;
  }

  async status({ signal } = {}) {
    const identity = await this._installation(null, false);
    if (!identity) return this._state(null, null, null);
    const binding = await this.preflight({ signal });
    await this._installation(binding);
    const config = await this._savedConfig();
    const container = await this._container(identity, signal);
    await this._volume(identity, signal);
    const result = this._state(identity, config, container);
    if (result.state === "running") {
      try { await this.probe(result.origin, { signal }); result.ready = true; }
      catch (error) {
        if (error.code === "CANCELLED") throw error;
        result.state = "error";
        result.error = { code: error.code || "NOT_READY", message: error.message };
      }
    }
    return result;
  }

  async _ready(identity, config, signal) {
    const deadline = this.now() + this.timeouts.readinessTimeoutMs;
    let lastFailure = "";
    let attempt = 0;
    do {
      cancelled(signal);
      const container = await this._container(identity, signal);
      const matches = (value) => value && ["version", "contentHash", "port", "restart"].every((key) =>
        value.recorderConfig[key] === config[key]);
      if (container?.State?.Running && container.State.Status === "running" &&
          container.State.Health?.Status !== "unhealthy" && matches(container)) {
        try {
          await this.probe(`http://127.0.0.1:${container.recorderConfig.port}`, { signal });
          // A healthy response from some other process is not proof this container survived.
          const confirmed = await this._container(identity, signal);
          if (confirmed?.Id === container.Id && confirmed.State?.Running && confirmed.State.Status === "running" &&
              confirmed.State.Health?.Status !== "unhealthy" && matches(confirmed)) {
            const result = { ...this._state(identity, config, confirmed), ready: true };
            await this._atomic("config.json", confirmed.recorderConfig);
            await this._atomic("state.json", result);
            return result;
          }
        } catch (error) {
          if (error.code !== "NOT_READY") throw error;
          if (lastFailure !== error.message) this.log(`Readiness: ${error.message}`);
          lastFailure = error.message;
        }
      }
      if (this.now() >= deadline) break;
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new RecorderError("CANCELLED", "Operation cancelled.")); };
        const delay = Math.min(this.timeouts.pollIntervalMs * (2 ** attempt++), this.timeouts.pollIntervalMs * 4,
          Math.max(0, deadline - this.now()));
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, delay);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    } while (this.now() < deadline);
    fail("NOT_READY", `Recorder did not become ready. ${lastFailure || "Expected owned container state was not confirmed."} Check owned-container logs; no trace data was deleted.`);
  }

  async _start(identity, config, signal) {
    if (!config) fail("NOT_INSTALLED", "Set up the local recorder first.");
    await this._installation(await this.preflight({ signal }));
    const existing = await this._container(identity, signal);
    config = existing?.recorderConfig || config;
    await this._volume(identity, signal);
    if (existing?.State?.Running) return this._ready(identity, config, signal);
    if (!(await this.checkPort(config.port))) fail("PORT_IN_USE", "The selected loopback port is already in use.");
    const bundle = await validateBundle(this._paths(identity, config).directory, config.version, { fs: this.fs, signal });
    if (bundle.manifest.contentHash !== config.contentHash) fail("BUNDLE_INVALID", "Installed build context no longer matches the installation.");
    await this._writeCompose(identity, config);
    await this._composeCommand(identity, config, ["up", "--detach", "--no-build", "--pull", "never", "recorder"], signal, "START_FAILED");
    return this._ready(identity, config, signal);
  }

  async setup({ port = 5080, restart = false, signal } = {}) {
    validatePort(port);
    if (typeof restart !== "boolean") fail("START_FAILED", "Restart preference must be a boolean.");
    return this._lock(signal, async () => {
      const binding = await this.preflight({ signal });
      let identity = await this._installation(binding, false);
      const saved = identity ? await this._savedConfig() : null;
      const existing = identity ? await this._container(identity, signal) : null;
      const config = existing?.recorderConfig || saved;
      // Setup is idempotent, not an implicit upgrade or restart-policy change.
      if (config) return this._start(identity, config, signal);
      const bundle = await validateBundle(this.bundlePath, this.version, { fs: this.fs, signal });
      if (!identity) {
        const installId = randomUUID().replace(/-/g, "");
        identity = { schemaVersion: 1, installId, projectName: `fr-${installId}`, volumeName: `fr-${installId}-data`,
          docker: { context: binding.context, endpoint: binding.endpoint, daemonId: binding.daemonId } };
        await this._atomic("installation.json", identity);
      }
      await this._container(identity, signal);
      await this._volume(identity, signal);
      if (!(await this.checkPort(port))) fail("PORT_IN_USE", "The selected loopback port is already in use.");
      const next = { version: this.version, contentHash: bundle.manifest.contentHash, port, restart };
      await this._stage(identity, next, bundle, signal);
      await this._composeCommand(identity, next, ["build", "--builder", "default", "recorder"], signal, "BUILD_FAILED");
      return this._start(identity, next, signal);
    });
  }

  async _mutate(signal, action) {
    return this._lock(signal, async () => {
      const identity = await this._installation(await this.preflight({ signal }));
      const saved = await this._savedConfig();
      const existing = await this._container(identity, signal);
      const config = existing?.recorderConfig || saved;
      if (!config) fail("NOT_INSTALLED", "Set up the local recorder first.");
      return action(identity, config);
    });
  }

  async start({ signal } = {}) {
    return this._mutate(signal, (identity, config) => this._start(identity, config, signal));
  }

  async stop({ signal } = {}) {
    return this._mutate(signal, async (identity, config) => {
      const container = await this._container(identity, signal);
      await this._volume(identity, signal);
      if (container?.State?.Running) await this._command(["stop", "--time", "10", container.Id],
        { signal, binding: identity.docker, code: "START_FAILED" });
      const confirmed = await this._container(identity, signal);
      if (confirmed?.State?.Running) fail("START_FAILED", "Docker did not confirm that the recorder stopped.");
      const result = this._state(identity, config, confirmed);
      await this._atomic("config.json", confirmed?.recorderConfig || config);
      await this._atomic("state.json", result);
      return result;
    });
  }

  async restart({ signal } = {}) {
    return this._mutate(signal, async (identity, config) => {
      const container = await this._container(identity, signal);
      await this._volume(identity, signal);
      if (!container) return this._start(identity, config, signal);
      if (!container.State?.Running && !(await this.checkPort(container.recorderConfig.port))) fail("PORT_IN_USE", "The selected loopback port is already in use.");
      await this._command(["restart", "--time", "10", container.Id], { signal, binding: identity.docker, code: "START_FAILED" });
      return this._ready(identity, config, signal);
    });
  }

  async rebuild({ signal } = {}) {
    return this._mutate(signal, async (identity, config) => {
      const bundle = await validateBundle(this.bundlePath, this.version, { fs: this.fs, signal });
      await this._container(identity, signal);
      await this._volume(identity, signal);
      const next = { ...config, version: this.version, contentHash: bundle.manifest.contentHash };
      await this._stage(identity, next, bundle, signal);
      await this._composeCommand(identity, next, ["build", "--builder", "default", "recorder"], signal, "BUILD_FAILED");
      // Build failure leaves the current container/config untouched.
      await this._installation(await this.preflight({ signal }));
      const container = await this._container(identity, signal);
      await this._volume(identity, signal);
      if (!container?.State?.Running && !(await this.checkPort(next.port))) fail("PORT_IN_USE", "The selected loopback port is already in use.");
      await this._composeCommand(identity, next, ["up", "--detach", "--no-build", "--pull", "never", "--force-recreate", "recorder"], signal, "START_FAILED");
      return this._ready(identity, next, signal);
    });
  }

  async setRestart(enabled, { signal } = {}) {
    if (typeof enabled !== "boolean") fail("START_FAILED", "Restart preference must be a boolean.");
    return this._mutate(signal, async (identity, config) => {
      const container = await this._container(identity, signal);
      await this._volume(identity, signal);
      if (container) await this._command(["update", "--restart", enabled ? "unless-stopped" : "no", container.Id],
        { signal, binding: identity.docker, code: "START_FAILED" });
      const confirmed = await this._container(identity, signal);
      if (container && (!confirmed || confirmed.recorderConfig.restart !== enabled)) fail("START_FAILED", "Docker did not confirm the restart-policy change.");
      const next = { ...config, restart: enabled };
      await this._writeCompose(identity, next);
      await this._atomic("config.json", next);
      if (confirmed?.State?.Running) return this._ready(identity, next, signal);
      const result = this._state(identity, next, confirmed);
      await this._atomic("state.json", result);
      return result;
    });
  }

  async logs({ signal } = {}) {
    const identity = await this._installation(await this.preflight({ signal }));
    const container = await this._container(identity, signal);
    if (!container) fail("NOT_INSTALLED", "No owned recorder container exists yet.");
    return sanitize(await this._command(["logs", "--tail", "200", "--timestamps", container.Id], {
      signal, binding: identity.docker, includeStderr: true
    }));
  }

  async _http(url, options, { signal, rpcId } = {}) {
    cancelled(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.timeouts.requestTimeoutMs);
    let reader;
    const cancelReader = () => { reader?.cancel().catch(() => this.log("Readiness stream cancellation did not complete cleanly.")); };
    controller.signal.addEventListener("abort", cancelReader, { once: true });
    try {
      if (signal?.aborted) controller.abort();
      const response = await this.fetch(url, { ...options, redirect: "error", signal: controller.signal });
      if (!response.ok) fail("NOT_READY", "Recorder HTTP readiness check did not succeed.");
      if (options.method === "POST" && rpcId === undefined) {
        await response.body?.cancel();
        return { headers: response.headers };
      }
      const type = response.headers.get("content-type") || "";
      const sse = type.includes("text/event-stream");
      if (rpcId !== undefined && !sse && !type.includes("application/json")) fail("NOT_READY", "Recorder MCP returned an unsupported content type.");
      reader = response.body?.getReader();
      if (!reader) fail("NOT_READY", "Recorder readiness response has no body.");
      const decoder = new TextDecoder();
      let text = "";
      let size = 0;
      let data;
      while (true) {
        if (controller.signal.aborted) fail("NOT_READY", "Recorder readiness request timed out.");
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 2 * 1024 * 1024) fail("NOT_READY", "Recorder readiness response exceeded the size limit.");
        text += decoder.decode(chunk.value, { stream: true });
        if (sse) {
          const events = text.replace(/\r\n/g, "\n").split("\n\n");
          text = events.pop();
          for (const event of events) {
            const payload = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
            if (!payload) continue;
            const parsed = JSON.parse(payload);
            if (parsed.id === rpcId) { data = parsed; break; }
          }
          if (data) break;
        }
      }
      text += decoder.decode();
      if (controller.signal.aborted) fail("NOT_READY", "Recorder readiness request timed out.");
      if (rpcId !== undefined) {
        data ||= sse ? null : JSON.parse(text);
        if (!data || data.jsonrpc !== "2.0" || data.id !== rpcId || data.error || !data.result) fail("NOT_READY", "Recorder MCP response is not a successful JSON-RPC exchange.");
      } else data = type.includes("application/json") ? JSON.parse(text) : text;
      return { data, type, headers: response.headers };
    } catch (error) {
      if (signal?.aborted) fail("CANCELLED", "Operation cancelled.");
      if (error instanceof RecorderError) throw error;
      fail("NOT_READY", "Recorder HTTP/MCP readiness could not be verified.");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", cancelReader);
      if (reader) {
        try { await reader.cancel(); } catch { this.log("Readiness response stream did not close cleanly."); }
      }
    }
  }

  async _closeProbeSession(origin, headers, signal) {
    if (signal?.aborted) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.timeouts.requestTimeoutMs);
    try {
      if (signal?.aborted) controller.abort();
      const response = await this.fetch(`${origin}/mcp`, {
        method: "DELETE", headers, redirect: "error", signal: controller.signal
      });
      await response.body?.cancel();
      if (!response.ok && ![404, 405].includes(response.status)) this.log("The readiness MCP session could not be closed.");
    } catch {
      // Closing our own ephemeral protocol session is cleanup, not a health gate.
      // Unsupported DELETE is permitted by MCP; never inspect/log its response.
      this.log("The readiness MCP session cleanup did not complete.");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  /** Read-only service verification: no tool calls or traces. Only the ephemeral
   * MCP session obtained by this probe is closed, when supported by the server. */
  async probe(origin, { signal } = {}) {
    origin = validateOrigin(origin);
    const viewer = await this._http(`${origin}/`, { method: "GET", headers: { Accept: "text/html" } }, { signal });
    if (!viewer.type.includes("text/html") || typeof viewer.data !== "string" || !/<title>[^<]*Flight Recorder[^<]*<\/title>/i.test(viewer.data)) {
      fail("NOT_READY", "The loopback endpoint did not return the Flight Recorder viewer.");
    }
    const api = await this._http(`${origin}/api/runs`, { method: "GET", headers: { Accept: "application/json" } }, { signal });
    if (!api.type.includes("application/json") || !Array.isArray(api.data) || !api.data.every((run) =>
      run && typeof run.id === "string" && typeof run.entryPointAgent === "string" &&
      (typeof run.status === "string" || typeof run.status === "number") && Number.isInteger(run.eventCount))) {
      fail("NOT_READY", "The loopback endpoint did not return the recorder run-list shape.");
    }
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    const init = await this._http(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: PROTOCOLS[0], capabilities: {}, clientInfo: { name: "flightrecorder-readiness", version: this.version }
      }
    }) }, { signal, rpcId: 1 });
    const protocol = init.data.result.protocolVersion;
    const session = init.headers.get("mcp-session-id");
    if (session) headers["Mcp-Session-Id"] = session;
    try {
      if (!PROTOCOLS.includes(protocol) || !init.data.result.capabilities?.tools || !init.data.result.serverInfo?.name) {
        fail("NOT_READY", "Recorder MCP initialization did not negotiate supported tool discovery.");
      }
      headers["MCP-Protocol-Version"] = protocol;
      await this._http(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify({
        jsonrpc: "2.0", method: "notifications/initialized"
      }) }, { signal });
      const discovered = new Set();
      let cursor;
      for (let page = 0; page < 10; page++) {
        const tools = await this._http(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify({
          jsonrpc: "2.0", id: 2 + page, method: "tools/list", params: cursor ? { cursor } : {}
        }) }, { signal, rpcId: 2 + page });
        if (!Array.isArray(tools.data.result.tools)) fail("NOT_READY", "Recorder MCP tool list is invalid.");
        for (const tool of tools.data.result.tools) {
          if (typeof tool.name !== "string" || tool.inputSchema?.type !== "object") fail("NOT_READY", "Recorder MCP tool definition is invalid.");
          discovered.add(tool.name);
        }
        cursor = tools.data.result.nextCursor;
        if (!cursor) break;
        if (typeof cursor !== "string") fail("NOT_READY", "Recorder MCP pagination cursor is invalid.");
      }
      if (!TOOLS.every((tool) => discovered.has(tool))) fail("NOT_READY", "The endpoint does not expose the expected Flight Recorder MCP tools.");
      return { state: "running", origin, version: init.data.result.serverInfo.version ?? null,
        restart: false, owned: false, ready: true, protocolVersion: protocol };
    } finally {
      if (session) await this._closeProbeSession(origin, headers, signal);
      cancelled(signal);
    }
  }
}

module.exports = { LocalRecorder, RecorderError, validateBundle, validatePort, validateOrigin,
  allowedBundlePath, localEndpoint, REQUIRED_CONTEXT_FILES };
