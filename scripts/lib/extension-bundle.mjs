import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const apiRoot = "src/FlightRecorder.Api";
const webRoot = "src/FlightRecorder.Web";
const extensionRoot = "extensions/flight-recorder";

export const REQUIRED_CONTEXT_FILES = Object.freeze([
  ".dockerignore",
  "Dockerfile",
  "LICENSE",
  "NuGet.Config",
  "package-lock.json",
  "package.json",
  "scripts/build-web.mjs",
  `${apiRoot}/FlightRecorder.Api.csproj`,
  `${apiRoot}/Program.cs`,
  `${apiRoot}/WeatherForecast.cs`,
  `${apiRoot}/appsettings.json`,
  `${webRoot}/app.js`,
  `${webRoot}/index.html`,
  `${webRoot}/model.js`,
  `${webRoot}/styles.css`
]);
const requiredContext = new Set(REQUIRED_CONTEXT_FILES);
const excludedSegments = new Set([
  "bin", "obj", "wwwroot", "node_modules", "data", "traces", "logs",
  "artifacts", "coverage", "dist", "build", "testresults"
]);
const extensionFiles = new Set([
  "package.json", "extension.cjs", "webview.cjs", "setup.cjs", "docker-process.cjs",
  "local-recorder.cjs", "mcp.cjs", "README.md", "LICENSE", "media/setup.md"
]);
const requiredExtensionFiles = ["extension.cjs", "webview.cjs", "README.md", "LICENSE"];

function isSafeRelativePath(value) {
  return typeof value === "string" && value.length > 0
    && !/[\\:<>"|?*\u0000-\u001f\u007f]/u.test(value)
    && value.split("/").every(segment =>
      segment !== "" && segment !== "." && segment !== ".."
      && !/[. ]$/u.test(segment)
      && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment));
}

/** Filter names before lstat/open: excluded configuration and trace contents are never read. */
export function isAllowedContextPath(relativePath) {
  if (!isSafeRelativePath(relativePath)) return false;
  if (requiredContext.has(relativePath)) return true;
  const segments = relativePath.split("/");
  if (segments.some(segment => segment.startsWith(".") || excludedSegments.has(segment.toLowerCase()))) return false;
  return /^src\/FlightRecorder\.Api\/(?:Controllers|Models|Services|Tools)\/(?:[^/]+\/)*[^/]+\.cs$/u.test(relativePath)
    || /^src\/FlightRecorder\.Web\/[^/]+\.(?:js|css|html)$/u.test(relativePath);
}

async function gitOutput(repositoryRoot, args) {
  const { stdout } = await exec("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
  return stdout;
}

/** Use the index as an additional boundary, never as the allowlist itself. */
export async function collectContextPaths(repositoryRoot) {
  const tracked = await gitOutput(repositoryRoot, [
    "ls-files", "--cached", "-z", "--",
    ...REQUIRED_CONTEXT_FILES, apiRoot, webRoot
  ]);
  const selected = [...new Set(tracked.split("\0").filter(isAllowedContextPath))].sort();
  const names = new Set(selected);
  for (const required of REQUIRED_CONTEXT_FILES) {
    if (!names.has(required)) throw new Error(`Missing required tracked recorder input: ${required}`);
  }
  return selected;
}

export async function readSourceRevision(repositoryRoot) {
  return (await gitOutput(repositoryRoot, ["rev-parse", "--verify", "HEAD"])).trim();
}

async function readRegularFile(repositoryRoot, relativePath) {
  if (!isSafeRelativePath(relativePath)) throw new Error(`Unsafe bundle path: ${relativePath}`);
  let current = repositoryRoot;
  let info = await lstat(current);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Bundle source root must be a regular directory, not a symlink");
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Bundle input must not be a symbolic link: ${relativePath}`);
    if (index < segments.length - 1 ? !info.isDirectory() : !info.isFile()) {
      throw new Error(`Bundle input must contain directories and a regular file only: ${relativePath}`);
    }
  }
  // Reject final-component link substitution where O_NOFOLLOW is available, and
  // compare the opened file with lstat before reading any contents on every host.
  const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new Error(`Bundle input changed during staging: ${relativePath}`);
    }
    return { bytes: await handle.readFile(), mode: info.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

async function writeStagedFile(directory, relativePath, source) {
  if (!isSafeRelativePath(relativePath)) throw new Error(`Unsafe staging path: ${relativePath}`);
  const destination = path.join(directory, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, source.bytes, { flag: "wx", mode: source.mode });
}

function validateExtensionManifest(manifest) {
  if (manifest.name !== "flight-recorder"
    || typeof manifest.version !== "string"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(manifest.version)) {
    throw new Error("Invalid Flight Recorder extension name or version");
  }
  if (!Array.isArray(manifest.files) || !manifest.files.includes("recorder/**")) {
    throw new Error("Extension distribution must declare recorder/** in package.json files");
  }
  for (const name of manifest.files) {
    if (name !== "recorder/**" && !extensionFiles.has(name)) {
      throw new Error(`Unsupported extension distribution entry: ${name}`);
    }
  }
  for (const required of requiredExtensionFiles) {
    if (!manifest.files.includes(required)) throw new Error(`Missing extension distribution entry: ${required}`);
  }
}

/**
 * Build an isolated distribution and keep it alive only for the supplied action.
 * readRevision is injectable for index-only test fixtures; production always uses HEAD.
 * No generated recorder directory or copied license is written into the checkout.
 */
export async function withExtensionStage({
  repositoryRoot,
  temporaryDirectory = tmpdir(),
  readRevision = readSourceRevision
}, action) {
  repositoryRoot = path.resolve(repositoryRoot);
  const stagingDirectory = await mkdtemp(path.join(path.resolve(temporaryDirectory), "flight-recorder-vsix-"));
  try {
    const extensionDirectory = path.join(stagingDirectory, "extension");
    const extensionSource = await readRegularFile(repositoryRoot, `${extensionRoot}/package.json`);
    const extensionManifest = JSON.parse(extensionSource.bytes.toString("utf8"));
    validateExtensionManifest(extensionManifest);
    const sourceRevision = await readRevision(repositoryRoot);
    if (typeof sourceRevision !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sourceRevision)) {
      throw new Error("Recorder sourceRevision must be a full Git commit hash");
    }
    const contextPaths = await collectContextPaths(repositoryRoot);
    await writeStagedFile(extensionDirectory, "package.json", extensionSource);
    for (const name of [...new Set(extensionManifest.files)].sort()) {
      if (name === "package.json" || name === "recorder/**") continue;
      const source = await readRegularFile(repositoryRoot, name === "LICENSE" ? "LICENSE" : `${extensionRoot}/${name}`);
      await writeStagedFile(extensionDirectory, name, source);
    }

    const contextDirectory = path.join(extensionDirectory, "recorder", "context");
    const files = [];
    for (const relativePath of contextPaths) {
      const source = await readRegularFile(repositoryRoot, relativePath);
      await writeStagedFile(contextDirectory, relativePath, source);
      files.push({ path: relativePath, sha256: createHash("sha256").update(source.bytes).digest("hex") });
    }
    const bundleManifest = {
      schemaVersion: 1,
      extensionVersion: extensionManifest.version,
      sourceRevision,
      contentHash: createHash("sha256").update(JSON.stringify(files), "utf8").digest("hex"),
      files
    };
    await writeStagedFile(extensionDirectory, "recorder/manifest.json", {
      bytes: Buffer.from(`${JSON.stringify(bundleManifest, null, 2)}\n`, "utf8"),
      mode: 0o644
    });
    return await action({ stagingDirectory, extensionDirectory, extensionManifest, bundleManifest });
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}
