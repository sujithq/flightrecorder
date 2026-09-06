import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const execute = promisify(execFile);
const defaultRoot = fileURLToPath(new URL("../", import.meta.url));
const manifestPath = "extensions/flight-recorder/package.json";
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const types = new Set(["feat", "fix", "perf", "docs", "refactor", "chore", "build", "ci", "test", "style", "revert"]);

function parts(version) {
  const match = typeof version === "string" && stableVersion.exec(version);
  if (!match || !match.slice(1).every(value => Number.isSafeInteger(Number(value)))) {
    throw new Error("The extension version must be a numeric X.Y.Z version. GitHub's prerelease flag is independent of this number.");
  }
  return match.slice(1).map(Number);
}

function compare(left, right) {
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function releaseBump(type, breaking = false) {
  if (!types.has(type)) throw new Error(`Choose a conventional commit type: ${[...types].join(", ")}.`);
  return breaking ? "major" : type === "feat" ? "minor" : "patch";
}

function increment(version, bump) {
  const values = parts(version);
  const index = ["major", "minor", "patch"].indexOf(bump);
  values[index]++;
  for (let next = index + 1; next < 3; next++) values[next] = 0;
  const result = values.join(".");
  parts(result);
  return result;
}

function manifestVersion(text) {
  const manifest = JSON.parse(text);
  if (manifest.name !== "flight-recorder") throw new Error("Expected the Flight Recorder extension manifest.");
  parts(manifest.version);
  return manifest.version;
}

function repository(directory) {
  const root = resolve(directory);
  const git = async (args, allowed = []) => {
    try {
      return (await execute("git", ["--no-pager", ...args], {
        cwd: root, timeout: 45_000, maxBuffer: 1024 * 1024, windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" }
      })).stdout.trim();
    } catch (error) {
      if (allowed.includes(error.code)) return null;
      // Git diagnostics can contain authenticated remote URLs. Do not echo them.
      throw new Error(`Git ${args[0]} failed (${error.code ?? "unknown status"}). Check Git, repository state, network access and permissions.`);
    }
  };
  return { root, git };
}

async function workingManifest(root) {
  const file = join(root, ...manifestPath.split("/"));
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The extension manifest must be a regular file.");
  const text = await readFile(file, "utf8");
  return { file, text, version: manifestVersion(text) };
}

async function versionTags(git) {
  const output = await git(["tag", "--merged", "HEAD", "--list", "v*"]);
  return output.split(/\r?\n/).filter(tag => stableVersion.test(tag.slice(1)))
    .sort((a, b) => compare(a.slice(1), b.slice(1)));
}

async function assertFullHistory(git) {
  if (await git(["rev-parse", "--is-shallow-repository"]) !== "false") {
    throw new Error("Release preparation requires full Git history. Fetch the missing history and version tags, then retry.");
  }
}

/** Derive a pending version from release history, not from a previous preparation. */
export async function prepareRelease({ type, breaking = false, dryRun = false, repositoryRoot = defaultRoot } = {}) {
  const bump = releaseBump(type, breaking);
  const { root, git } = repository(repositoryRoot);
  await assertFullHistory(git);
  const head = await git(["rev-parse", "--verify", "HEAD"]);
  const current = await workingManifest(root);
  const committed = manifestVersion(await git(["show", `HEAD:${manifestPath}`]));
  const tags = await versionTags(git);
  const baseTag = tags.at(-1);
  const baseline = baseTag ? baseTag.slice(1) : committed;
  if (compare(current.version, baseline) < 0 || compare(current.version, committed) < 0) {
    throw new Error("The working extension version is below committed/released history. Resolve the version mismatch before preparing a release.");
  }
  const required = increment(baseline, bump);
  const version = compare(current.version, required) < 0 ? required : current.version;
  const tag = `v${version}`;
  if (await git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], [1])) {
    throw new Error(`${tag} already exists outside the selected release baseline. Reconcile your version tags before proceeding.`);
  }
  const changed = version !== current.version;
  if (changed && !dryRun) {
    const pattern = /^([ \t]*"version"[ \t]*:[ \t]*")([^"]+)(")/gm;
    const matches = [...current.text.matchAll(pattern)];
    if (matches.length !== 1 || matches[0][2] !== current.version) {
      throw new Error("Cannot update the top-level version surgically. Keep one standalone version property in the extension manifest.");
    }
    const next = current.text.replace(pattern, (_match, before, _old, after) => `${before}${version}${after}`);
    if (manifestVersion(next) !== version) throw new Error("Prepared manifest version did not validate.");
    if (await git(["rev-parse", "HEAD"]) !== head || await readFile(current.file, "utf8") !== current.text) {
      throw new Error("The checkout changed while preparing the version. Review it and retry.");
    }
    const temporary = join(dirname(current.file), `.release-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, next, { flag: "wx" });
      await rename(temporary, current.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return { baseline, baseTag: baseTag ?? null, previousVersion: current.version, version, tag, bump, changed, dryRun };
}

async function assertReleaseCheckout(git, expectedHead) {
  if (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], [1]) !== "main") {
    throw new Error("Run the release tag task from main after merging your changes; detached HEAD and feature branches are not released.");
  }
  if (await git(["status", "--porcelain", "--untracked-files=normal"])) {
    throw new Error("Commit or otherwise resolve all staged, unstaged, and untracked changes before creating a release tag. Nothing was staged or committed.");
  }
  const head = await git(["rev-parse", "--verify", "HEAD"]);
  if (expectedHead && head !== expectedHead) throw new Error("HEAD changed during release validation. Retry from the intended commit.");
  return head;
}

async function pushDestination(git) {
  const urls = (await git(["remote", "get-url", "--push", "--all", "origin"])).split(/\r?\n/).filter(Boolean);
  if (urls.length !== 1) throw new Error("origin must have exactly one push destination. No tag was pushed.");
  return urls[0];
}

async function remoteRefs(git, destination, tag) {
  const output = await git(["ls-remote", destination, "refs/heads/main", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  return new Map(output.split(/\r?\n/).filter(Boolean).map(line => {
    const [sha, ref] = line.split(/\s+/);
    return [ref, sha];
  }));
}

/** Explicit post-commit action: publish one immutable annotated tag, never a branch. */
export async function tagRelease({ dryRun = false, repositoryRoot = defaultRoot } = {}) {
  const { root, git } = repository(repositoryRoot);
  await assertFullHistory(git);
  const head = await assertReleaseCheckout(git);
  const current = await workingManifest(root);
  const version = manifestVersion(await git(["show", `HEAD:${manifestPath}`]));
  if (current.version !== version) throw new Error("The extension version must be committed before tagging.");
  const tag = `v${version}`;
  const ref = `refs/tags/${tag}`;
  const previous = (await versionTags(git)).filter(value => value !== tag).at(-1);
  if (previous && compare(version, previous.slice(1)) <= 0) {
    throw new Error(`Committed version ${version} is not newer than ${previous}. Prepare and commit the next version first.`);
  }
  const local = await git(["rev-parse", "--verify", "--quiet", ref], [1]);
  if (local) {
    if (await git(["rev-parse", `${ref}^{commit}`]) !== head) {
      throw new Error(`${tag} already points to another commit. Existing tags are never moved or replaced.`);
    }
    if (await git(["cat-file", "-t", ref]) !== "tag") {
      throw new Error(`${tag} is a lightweight tag. Review it manually; this task creates annotated tags only.`);
    }
  }
  const destination = await pushDestination(git);
  const refs = await remoteRefs(git, destination, tag);
  if (refs.get("refs/heads/main") !== head) {
    throw new Error("HEAD must match origin/main at the push destination. Push your committed main branch (or synchronize it) first, then rerun. This task never pushes branches.");
  }
  const remote = refs.get(`${ref}^{}`) ?? refs.get(ref);
  if (remote) {
    if (remote !== head) throw new Error(`${tag} already exists remotely at another commit. Nothing was changed; choose a new version.`);
    return { version, tag, head, state: "already-pushed", dryRun };
  }
  if (dryRun) return { version, tag, head, state: local ? "would-push" : "would-create-and-push", dryRun };
  await assertReleaseCheckout(git, head);
  if (await pushDestination(git) !== destination) throw new Error("origin changed during validation. No tag was pushed.");
  if (!local) await git(["tag", "-a", tag, "-m", `Release ${tag}`, head]);
  const tagObject = await git(["rev-parse", "--verify", ref]);
  if (await git(["cat-file", "-t", tagObject]) !== "tag" ||
      await git(["rev-parse", `${tagObject}^{commit}`]) !== head) throw new Error("The local tag changed. Nothing was pushed.");
  try {
    await git(["push", "--no-follow-tags", "--recurse-submodules=no", destination, `${tagObject}:${ref}`]);
  } catch (error) {
    throw new Error(`${error.message} The local ${tag} tag was retained; rerun the task after fixing the problem. No tag was force-pushed or deleted.`);
  }
  const confirmed = await remoteRefs(git, destination, tag);
  if ((confirmed.get(`${ref}^{}`) ?? confirmed.get(ref)) !== head) {
    throw new Error(`Push returned without confirming ${tag} at the expected commit. Inspect the remote before retrying.`);
  }
  return { version, tag, head, state: "pushed", dryRun };
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    type: { type: "string" }, breaking: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false }, help: { type: "boolean", default: false }
  } });
  if (values.help) {
    console.log("Usage:\n  npm run release:prepare -- --type feat|fix|docs|chore|... [--breaking] [--dry-run]\n  npm run release:tag -- [--dry-run]\nPrepare only edits the extension version; it never stages or commits. Tag requires clean main already pushed to origin/main.");
    return;
  }
  if (positionals.length !== 1 || !["prepare", "tag"].includes(positionals[0])) throw new Error("Choose prepare or tag. Use --help for usage.");
  if (positionals[0] === "tag" && (values.type || values.breaking)) throw new Error("Tagging uses the committed version, not --type or --breaking.");
  const result = positionals[0] === "prepare"
    ? await prepareRelease({ type: values.type, breaking: values.breaking, dryRun: values["dry-run"] })
    : await tagRelease({ dryRun: values["dry-run"] });
  console.log(JSON.stringify(result, null, 2));
  if (positionals[0] === "prepare" && !values["dry-run"]) {
    console.log("Include (or re-stage) extensions/flight-recorder/package.json in your commit. No files were staged, committed, or pushed.");
  } else if (result.state === "pushed") {
    console.log("The version tag is pushed. The Draft release workflow must still pass; inspect its draft before publishing.");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
