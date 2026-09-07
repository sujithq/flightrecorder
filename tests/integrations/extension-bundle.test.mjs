import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { collectContextPaths, isAllowedContextPath, withExtensionStage } from "../../scripts/lib/extension-bundle.mjs";
import { packageExtension } from "../../scripts/package-extension.mjs";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const extensionPath = "extensions/flight-recorder";
const apiPath = "src/FlightRecorder.Api";
const webPath = "src/FlightRecorder.Web";
const realExtension = JSON.parse(await readFile(path.join(repositoryRoot, extensionPath, "package.json"), "utf8"));
const revision = (await exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: repositoryRoot })).stdout.trim();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const requiredInputs = [
  ".dockerignore", "Dockerfile", "LICENSE", "NuGet.Config", "package-lock.json", "package.json",
  "scripts/build-web.mjs", `${apiPath}/FlightRecorder.Api.csproj`, `${apiPath}/Program.cs`,
  `${apiPath}/WeatherForecast.cs`, `${apiPath}/appsettings.json`,
  `${webPath}/app.js`, `${webPath}/index.html`, `${webPath}/model.js`, `${webPath}/styles.css`
];
const distributionFiles = [
  "extension.cjs", "webview.cjs", "setup.cjs", "docker-process.cjs", "local-recorder.cjs", "mcp.cjs",
  "usage-collector.cjs", "usage-sources.cjs", "README.md", "LICENSE", "media/setup.md", "recorder/**"
];

async function put(root, relativePath, content = "synthetic excluded test data") {
  const destination = path.join(root, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content);
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "flight-recorder-bundle-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "repository");
  const temporaryDirectory = path.join(directory, "staging");
  const artifactsDirectory = path.join(directory, "artifacts");
  await mkdir(temporaryDirectory, { recursive: true });
  for (const relativePath of requiredInputs) {
    await put(root, relativePath, await readFile(path.join(repositoryRoot, relativePath)));
  }
  for (const group of ["Controllers", "Models", "Services", "Tools"]) {
    await put(root, `${apiPath}/${group}/Example.cs`, "// Synthetic source fixture\n");
  }
  await put(root, `${extensionPath}/package.json`, JSON.stringify({ ...realExtension, files: distributionFiles }));
  for (const name of ["extension.cjs", "webview.cjs", "README.md"]) {
    await put(root, `${extensionPath}/${name}`, await readFile(path.join(repositoryRoot, extensionPath, name)));
  }
  for (const name of ["setup.cjs", "docker-process.cjs", "local-recorder.cjs", "mcp.cjs", "usage-collector.cjs", "usage-sources.cjs"]) {
    await put(root, `${extensionPath}/${name}`, "module.exports = {};\n");
  }
  await put(root, `${extensionPath}/media/setup.md`, "# Synthetic setup guide\n");
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["add", "--force", "--", "."], { cwd: root });
  return {
    root, directory, temporaryDirectory, artifactsDirectory,
    options: {
      repositoryRoot: root, temporaryDirectory, artifactsDirectory,
      // The fixture has an index but deliberately creates no commits.
      readRevision: async () => revision
    }
  };
}

async function regularFiles(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) result.push(...await regularFiles(path.join(root, entry.name), relativePath));
    else {
      assert.equal(entry.isFile(), true);
      result.push(relativePath);
    }
  }
  return result.sort();
}

test("the context allowlist rejects traversal, hidden state and generated files before reading", () => {
  for (const relativePath of requiredInputs) assert.equal(isAllowedContextPath(relativePath), true, relativePath);
  for (const relativePath of [
    "../Dockerfile", "/Dockerfile", "C:/Dockerfile", "src\\FlightRecorder.Api\\Program.cs",
    `${apiPath}/Services/../Program.cs`, `${apiPath}/Services//Example.cs`,
    `${apiPath}/Services/.private/Secret.cs`, `${apiPath}/Services/obj/Generated.cs`,
    `${apiPath}/Controllers/BIN/Generated.cs`, `${apiPath}/Services/wwwroot/Generated.cs`,
    `${apiPath}/Services/node_modules/Example.cs`, `${apiPath}/Services/data/Trace.cs`,
    `${apiPath}/Services/Example.cs:stream`, `${apiPath}/Services/Example.cs\u0000`,
    ...Array.from('<>"|?*', character => `${apiPath}/Services/Bad${character}Name.cs`),
    `${apiPath}/Services/Example.cs.`, `${apiPath}/Properties/launchSettings.json`,
    `${apiPath}/appsettings.Development.json`, `${apiPath}/appsettings.Local.json`,
    `${webPath}/app.js.map`, `${webPath}/.env.js`, `${webPath}/node_modules/secret.js`,
    `${webPath}/traces/session.js`, "scripts/private.mjs", ".env", ".squad/state.json", "data/traces.db"
  ]) assert.equal(isAllowedContextPath(relativePath), false, relativePath);
  assert.equal(isAllowedContextPath(`${apiPath}/Services/Nested/Example.cs`), true);
});

test("tracked bin/obj, traces and local configuration never enter the context", async t => {
  const { root, options } = await fixture(t);
  const excluded = [
    `${apiPath}/bin/Debug/appsettings.json`, `${apiPath}/obj/Generated.cs`,
    `${apiPath}/Services/obj/Generated.cs`, `${apiPath}/wwwroot/assets/app.js`,
    `${apiPath}/appsettings.Development.json`, `${apiPath}/appsettings.Local.json`,
    `${apiPath}/secrets.json`, `${webPath}/app.js.map`, `${webPath}/.env.js`,
    "node_modules/private/index.js", "data/traces.db", ".squad/state.json",
    ".env", ".env.production", "credentials.json"
  ];
  for (const relativePath of excluded) await put(root, relativePath);
  await exec("git", ["add", "--force", "--", ...excluded], { cwd: root });
  const tracked = (await exec("git", ["ls-files", "-z"], { cwd: root })).stdout.split("\0");
  for (const relativePath of excluded) assert.ok(tracked.includes(relativePath), relativePath);
  // Even an allowlisted suffix must be tracked before it is considered source.
  await put(root, `${apiPath}/Services/Untracked.cs`);
  const selected = await collectContextPaths(root);
  for (const relativePath of excluded) assert.equal(selected.includes(relativePath), false, relativePath);
  assert.equal(selected.includes(`${apiPath}/Services/Untracked.cs`), false);
  await withExtensionStage(options, async ({ extensionDirectory, bundleManifest }) => {
    const files = await regularFiles(path.join(extensionDirectory, "recorder/context"));
    assert.deepEqual(files, bundleManifest.files.map(file => file.path));
    for (const relativePath of excluded) assert.equal(files.includes(relativePath), false, relativePath);
  });
});

test("the exact manifest is sorted, version-matched and hashes the copied bytes", async t => {
  const { root, options, temporaryDirectory } = await fixture(t);
  let stagingDirectory;
  await withExtensionStage(options, async stage => {
    stagingDirectory = stage.stagingDirectory;
    const context = path.join(stage.extensionDirectory, "recorder/context");
    const manifest = JSON.parse(await readFile(path.join(stage.extensionDirectory, "recorder/manifest.json"), "utf8"));
    assert.deepEqual(Object.keys(manifest).sort(), ["contentHash", "extensionVersion", "files", "schemaVersion", "sourceRevision"]);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.extensionVersion, realExtension.version);
    assert.equal(manifest.sourceRevision, revision);
    assert.equal(manifest.contentHash, hash(Buffer.from(JSON.stringify(manifest.files), "utf8")));
    assert.deepEqual(manifest.files.map(file => file.path), manifest.files.map(file => file.path).sort());
    assert.deepEqual(await regularFiles(context), manifest.files.map(file => file.path));
    for (const relativePath of requiredInputs) assert.ok(manifest.files.some(file => file.path === relativePath), relativePath);
    for (const file of manifest.files) {
      assert.deepEqual(Object.keys(file).sort(), ["path", "sha256"]);
      const bundled = await readFile(path.join(context, file.path));
      assert.equal(file.sha256, hash(bundled), file.path);
      assert.deepEqual(bundled, await readFile(path.join(root, file.path)), file.path);
    }
    assert.deepEqual(stage.bundleManifest, manifest);
  });
  await assert.rejects(lstat(stagingDirectory), { code: "ENOENT" });
  assert.deepEqual(await readdir(temporaryDirectory), []);
  await assert.rejects(lstat(path.join(root, extensionPath, "recorder")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(root, extensionPath, "LICENSE")), { code: "ENOENT" });
});

test("identical inputs give identical content hashes; a source change changes the hash", async t => {
  const { root, options } = await fixture(t);
  const getManifest = () => withExtensionStage(options, async stage => stage.bundleManifest);
  const first = await getManifest();
  assert.deepEqual(await getManifest(), first);
  await put(root, `${apiPath}/Services/Example.cs`, "// Changed synthetic source\n");
  const changed = await getManifest();
  assert.notEqual(changed.contentHash, first.contentHash);
  assert.equal(changed.sourceRevision, first.sourceRevision);
  assert.equal(changed.extensionVersion, first.extensionVersion);
});

test("missing required Docker build inputs fail and clean temporary staging", async t => {
  const { root, options, temporaryDirectory } = await fixture(t);
  for (const relativePath of requiredInputs) {
    const original = await readFile(path.join(root, relativePath));
    await rm(path.join(root, relativePath));
    await assert.rejects(withExtensionStage(options, () => assert.fail("Must not package incomplete inputs")),
      /required|ENOENT/i, relativePath);
    assert.deepEqual(await readdir(temporaryDirectory), []);
    await put(root, relativePath, original);
  }
  await exec("git", ["rm", "--cached", "--force", "--", "NuGet.Config"], { cwd: root });
  await assert.rejects(withExtensionStage(options, () => assert.fail("Must not package untracked required inputs")),
    /required.*NuGet\.Config/i);
});

test("only named extension distribution files are staged, including new modules and the root license", async t => {
  const { root, options } = await fixture(t);
  await put(root, `${extensionPath}/.env`);
  await put(root, `${extensionPath}/private.cjs`);
  await put(root, `${extensionPath}/media/private.md`);
  await put(root, `${extensionPath}/recorder/context/stale.db`);
  await withExtensionStage(options, async ({ extensionDirectory }) => {
    const names = (await regularFiles(extensionDirectory)).filter(name => !name.startsWith("recorder/"));
    assert.deepEqual(names, ["package.json", ...distributionFiles.filter(name => name !== "recorder/**")].sort());
    for (const name of ["extension.cjs", "webview.cjs", "README.md", "package.json", "local-recorder.cjs"]) {
      assert.deepEqual(await readFile(path.join(extensionDirectory, name)), await readFile(path.join(root, extensionPath, name)));
    }
    assert.deepEqual(await readFile(path.join(extensionDirectory, "LICENSE")), await readFile(path.join(root, "LICENSE")));
  });
});

test("undeclared bundle assets and unsafe distribution declarations fail closed", async t => {
  const { root, options } = await fixture(t);
  for (const files of [
    ["extension.cjs", "webview.cjs", "README.md", "LICENSE"],
    [...distributionFiles, "../.env"],
    [...distributionFiles, "**/*"],
    [...distributionFiles, "private.cjs"]
  ]) {
    await put(root, `${extensionPath}/package.json`, JSON.stringify({ ...realExtension, files }));
    await assert.rejects(withExtensionStage(options, () => assert.fail("Unsafe manifest must be rejected")),
      /distribution|recorder\/\*\*/i);
  }
});

test("selected directory symlinks are rejected without following them", async t => {
  const { root, directory, options, temporaryDirectory } = await fixture(t);
  const source = path.join(root, apiPath, "Services");
  const outside = path.join(directory, "outside");
  await mkdir(outside);
  await put(outside, "Example.cs", "// Must never be followed\n");
  await rm(source, { recursive: true });
  // Junctions exercise the same lstat rejection and work without Windows Developer Mode.
  await symlink(outside, source, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(withExtensionStage(options, () => assert.fail("Must reject a linked source directory")),
    /symbolic link|symlink/i);
  assert.deepEqual(await readdir(temporaryDirectory), []);
});

test("selected file symlinks are rejected while excluded symlinks are not read", async t => {
  const { root, directory, options } = await fixture(t);
  const target = path.join(directory, "outside.txt");
  await writeFile(target, "Synthetic link target");
  const selected = path.join(root, apiPath, "Services", "Example.cs");
  await rm(selected);
  try {
    await symlink(target, selected, "file");
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
      t.skip("File symlinks require Windows Developer Mode or symlink privilege; junction coverage still runs.");
      return;
    }
    throw error;
  }
  await assert.rejects(withExtensionStage(options, () => assert.fail("Must reject a linked source file")),
    /symbolic link|symlink/i);
  await rm(selected);
  await put(root, `${apiPath}/Services/Example.cs`, "// Synthetic source\n");
  await symlink(path.join(directory, "does-not-exist"), path.join(root, ".env"), "file");
  await exec("git", ["add", "--force", "--", ".env"], { cwd: root });
  await withExtensionStage(options, async stage => {
    assert.equal(stage.bundleManifest.files.some(file => file.path === ".env"), false);
  });
});

test("symlinked extension distribution directories are rejected", async t => {
  const { root, directory, options } = await fixture(t);
  const media = path.join(root, extensionPath, "media");
  const outside = path.join(directory, "outside-media");
  await mkdir(outside);
  await put(outside, "setup.md", "# Must never be followed\n");
  await rm(media, { recursive: true });
  await symlink(outside, media, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(withExtensionStage(options, () => assert.fail("Must reject linked distribution directories")),
    /symbolic link|symlink/i);
});

test("excluded linked configuration is not traversed even when its path is tracked", async t => {
  const { root, directory, options } = await fixture(t);
  await put(root, ".env");
  await exec("git", ["add", "--force", "--", ".env"], { cwd: root });
  await rm(path.join(root, ".env"));
  const outside = path.join(directory, "excluded-configuration");
  await mkdir(outside);
  await put(outside, "must-not-read.txt");
  await symlink(outside, path.join(root, ".env"), process.platform === "win32" ? "junction" : "dir");
  await withExtensionStage(options, async stage => {
    assert.equal(stage.bundleManifest.files.some(file => file.path.startsWith(".env")), false);
  });
});

test("a directory cannot masquerade as a selected regular file", async t => {
  const { root, options, temporaryDirectory } = await fixture(t);
  await rm(path.join(root, apiPath, "Program.cs"));
  await mkdir(path.join(root, apiPath, "Program.cs"));
  await assert.rejects(withExtensionStage(options, () => assert.fail("Must require regular files")),
    /regular file/i);
  assert.deepEqual(await readdir(temporaryDirectory), []);
});

test("staged files retain executable permissions on POSIX", { skip: process.platform === "win32" }, async t => {
  const { root, options } = await fixture(t);
  await chmod(path.join(root, extensionPath, "extension.cjs"), 0o755);
  await withExtensionStage(options, async stage => {
    assert.equal((await lstat(path.join(stage.extensionDirectory, "extension.cjs"))).mode & 0o777, 0o755);
  });
});

test("packaging uses isolated staging, dependencies:false and hashes the actual VSIX bytes", async t => {
  const { root, options, temporaryDirectory, artifactsDirectory } = await fixture(t);
  const packaged = Buffer.from("Synthetic VSIX bytes for packaging plumbing");
  let extensionDirectory;
  const result = await packageExtension({
    ...options,
    createVSIX: async configuration => {
      extensionDirectory = configuration.cwd;
      assert.equal(configuration.dependencies, false);
      assert.notEqual(configuration.cwd, path.join(root, extensionPath));
      const manifest = JSON.parse(await readFile(path.join(configuration.cwd, "recorder/manifest.json"), "utf8"));
      assert.equal(manifest.extensionVersion, realExtension.version);
      await writeFile(configuration.packagePath, packaged);
    }
  });
  const artifactName = `flight-recorder-${realExtension.version}.vsix`;
  assert.equal(result.packagePath, path.join(artifactsDirectory, artifactName));
  assert.equal(result.checksumPath, `${result.packagePath}.sha256`);
  assert.equal(result.sha256, hash(packaged));
  assert.deepEqual(await readFile(result.packagePath), packaged);
  assert.equal(await readFile(result.checksumPath, "utf8"), `${hash(packaged)}  ${artifactName}\n`);
  await assert.rejects(lstat(extensionDirectory), { code: "ENOENT" });
  assert.deepEqual(await readdir(temporaryDirectory), []);
  await assert.rejects(lstat(path.join(root, extensionPath, "recorder")), { code: "ENOENT" });
});

test("packaging failure removes partial VSIX/staging and leaves existing artifacts and source intact", async t => {
  const { root, options, temporaryDirectory, artifactsDirectory } = await fixture(t);
  const artifactName = `flight-recorder-${realExtension.version}.vsix`;
  await put(artifactsDirectory, artifactName, "Existing artifact");
  await put(artifactsDirectory, `${artifactName}.sha256`, "Existing checksum");
  let extensionDirectory;
  await assert.rejects(packageExtension({
    ...options,
    createVSIX: async configuration => {
      extensionDirectory = configuration.cwd;
      await writeFile(configuration.packagePath, "Partial artifact");
      throw new Error("Synthetic packaging failure");
    }
  }), /Synthetic packaging failure/);
  await assert.rejects(lstat(extensionDirectory), { code: "ENOENT" });
  assert.deepEqual(await readdir(temporaryDirectory), []);
  assert.equal(await readFile(path.join(artifactsDirectory, artifactName), "utf8"), "Existing artifact");
  assert.equal(await readFile(path.join(artifactsDirectory, `${artifactName}.sha256`), "utf8"), "Existing checksum");
  await assert.rejects(lstat(path.join(root, extensionPath, "recorder")), { code: "ENOENT" });
});

test("revision lookup failure cleans staging and does not invoke VSCE", async t => {
  const { options, temporaryDirectory } = await fixture(t);
  await assert.rejects(packageExtension({
    ...options,
    readRevision: async () => { throw new Error("Synthetic missing Git revision"); },
    createVSIX: () => assert.fail("VSCE must not run without a source revision")
  }), /Synthetic missing Git revision/);
  assert.deepEqual(await readdir(temporaryDirectory), []);
});
