import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { prepareRelease, releaseBump, tagRelease } from "../../scripts/release.mjs";

const execute = promisify(execFile);
const manifest = "extensions/flight-recorder/package.json";
const repositoryRoot = new URL("../../", import.meta.url);

async function fixture(t, { version = "0.2.1", tagged = true } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "recorder release test "));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, "checkout");
  const remote = join(temporary, "remote.git");
  await mkdir(root);
  const git = async (...args) => (await execute("git", args, {
    cwd: root, timeout: 15000, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  })).stdout.trim();
  await git("init", "--quiet", "--initial-branch=main");
  await git("config", "user.name", "Release Test");
  await git("config", "user.email", "release-test@example.invalid");
  await git("config", "commit.gpgSign", "false");
  await git("config", "tag.gpgSign", "false");
  await git("config", "core.autocrlf", "false");
  await mkdir(join(temporary, "empty-hooks"));
  await git("config", "core.hooksPath", join(temporary, "empty-hooks"));
  await git("init", "--quiet", "--bare", "--initial-branch=main", remote);
  await git("remote", "add", "origin", remote);
  await mkdir(dirname(join(root, manifest)), { recursive: true });
  await writeFile(join(root, manifest), `{\r\n  "name": "flight-recorder",\r\n  "version": "${version}",\r\n  "engines": { "vscode": "^1.101.0" }\r\n}\r\n`);
  await writeFile(join(root, "package.json"), '{"name":"private-root","version":"0.1.0","private":true}\n');
  await git("add", ".");
  await git("commit", "--quiet", "-m", "chore: initial fixture");
  const initial = await git("rev-parse", "HEAD");
  if (tagged) await git("tag", "-a", `v${version}`, "-m", `Release v${version}`);
  await git("push", "--quiet", "origin", "main", "--tags");
  const prepare = options => prepareRelease({ repositoryRoot: root, ...options });
  const tag = options => tagRelease({ repositoryRoot: root, ...options });
  const current = async () => JSON.parse(await readFile(join(root, manifest), "utf8")).version;
  async function commitVersion(type = "fix", push = true) {
    await prepare({ type });
    await git("add", manifest);
    await git("commit", "--quiet", "-m", `${type}: synthetic change`);
    if (push) await git("push", "--quiet", "origin", "main");
  }
  return { root, remote, temporary, initial, git, prepare, tag, current, commitVersion };
}

test("conventional type mapping includes documentation releases and explicit breaking changes", () => {
  assert.equal(releaseBump("feat"), "minor");
  for (const type of ["fix", "docs", "chore", "ci", "perf", "refactor", "test", "build", "style", "revert"]) {
    assert.equal(releaseBump(type), "patch");
    assert.equal(releaseBump(type, true), "major");
  }
  assert.equal(releaseBump("feat", true), "major");
  assert.throws(() => releaseBump(undefined), /conventional commit type/);
  assert.throws(() => releaseBump("feature"), /conventional commit type/);
});

test("preparation changes only the extension version and asking again is idempotent", async t => {
  const f = await fixture(t);
  const before = await readFile(join(f.root, manifest), "utf8");
  const rootBefore = await readFile(join(f.root, "package.json"), "utf8");
  const first = await f.prepare({ type: "docs" });
  assert.equal(first.baseline, "0.2.1");
  assert.equal(first.version, "0.2.2");
  assert.equal(first.changed, true);
  assert.equal(await readFile(join(f.root, manifest), "utf8"), before.replace('"0.2.1"', '"0.2.2"'));
  const repeated = await f.prepare({ type: "docs" });
  assert.equal(repeated.version, "0.2.2");
  assert.equal(repeated.changed, false);
  assert.equal(await f.git("diff", "--cached", "--name-only"), "");
  assert.equal(await f.git("rev-parse", "HEAD"), f.initial);
  assert.equal(await f.git("tag", "--list"), "v0.2.1");
  assert.equal(await readFile(join(f.root, "package.json"), "utf8"), rootBefore);
  assert.deepEqual((await readdir(dirname(join(f.root, manifest)))).filter(file => file.startsWith(".release-")), []);
});

test("pending versions escalate severity but never compound or downgrade", async t => {
  const f = await fixture(t);
  assert.equal((await f.prepare({ type: "fix" })).version, "0.2.2");
  assert.equal((await f.prepare({ type: "feat" })).version, "0.3.0");
  assert.equal((await f.prepare({ type: "docs" })).version, "0.3.0");
  assert.equal((await f.prepare({ type: "feat", breaking: true })).version, "1.0.0");
  assert.equal((await f.prepare({ type: "feat", breaking: true })).changed, false);
});

test("a manually prepared higher version and other manifest edits are preserved", async t => {
  const f = await fixture(t);
  const path = join(f.root, manifest);
  const edited = (await readFile(path, "utf8")).replace('"0.2.1"', '"2.0.0"').replace("^1.101.0", "^1.102.0");
  await writeFile(path, edited);
  assert.equal((await f.prepare({ type: "fix" })).version, "2.0.0");
  assert.equal(await readFile(path, "utf8"), edited);
});

test("a partially staged manifest stays staged as-is while the working version is prepared", async t => {
  const f = await fixture(t);
  const path = join(f.root, manifest);
  const staged = (await readFile(path, "utf8")).replace("^1.101.0", "^1.102.0");
  await writeFile(path, staged);
  await f.git("add", manifest);
  await writeFile(path, staged.replace("^1.102.0", "^1.103.0"));
  await f.prepare({ type: "fix" });
  assert.equal(await f.git("show", `:${manifest}`), staged.trim());
  assert.equal(await readFile(path, "utf8"), staged.replace('"0.2.1"', '"0.2.2"').replace("^1.102.0", "^1.103.0"));
});

test("no-tag repositories use committed version without repeating an uncommitted bump", async t => {
  const f = await fixture(t, { tagged: false });
  assert.equal((await f.prepare({ type: "fix" })).baseTag, null);
  assert.equal((await f.prepare({ type: "fix" })).version, "0.2.2");
  assert.equal(await f.git("tag", "--list"), "");
});

test("multiple commits before releasing preserve the already-prepared version", async t => {
  const f = await fixture(t);
  await f.commitVersion("feat");
  assert.equal((await f.prepare({ type: "fix" })).version, "0.3.0");
  assert.equal((await f.prepare({ type: "feat" })).changed, false);
});

test("numeric tag ordering is used, not lexical or date ordering", async t => {
  const f = await fixture(t, { version: "0.10.0", tagged: false });
  await f.git("tag", "v0.9.0");
  await f.git("tag", "v0.10.0");
  await f.git("tag", "unrelated");
  assert.equal((await f.prepare({ type: "fix" })).version, "0.10.1");
});

test("dry-run preparation performs no edits, commits or tags", async t => {
  const f = await fixture(t);
  const planned = await f.prepare({ type: "feat", dryRun: true });
  assert.equal(planned.version, "0.3.0");
  assert.equal(planned.changed, true);
  assert.equal(await f.current(), "0.2.1");
  assert.equal(await f.git("status", "--porcelain"), "");
});

test("invalid or downgraded versions fail without writing", async t => {
  const f = await fixture(t);
  for (const version of ["0.2.1-beta.1", "01.2.1", "0.2.0", "9007199254740992.0.0"]) {
    const text = JSON.stringify({ name: "flight-recorder", version }, null, 2);
    await writeFile(join(f.root, manifest), text);
    await assert.rejects(f.prepare({ type: "fix" }), /numeric|below committed/);
    assert.equal(await readFile(join(f.root, manifest), "utf8"), text);
  }
});

test("a colliding tag from another branch must not be silently replaced", async t => {
  const f = await fixture(t);
  await f.git("switch", "--quiet", "-c", "another-release");
  await f.git("commit", "--quiet", "--allow-empty", "-m", "test: separate release");
  await f.git("tag", "v0.2.2");
  await f.git("switch", "--quiet", "main");
  await assert.rejects(f.prepare({ type: "fix" }), /already exists outside/);
  assert.equal(await f.current(), "0.2.1");
});

test("tagging requires all staged, unstaged and untracked changes to be resolved", async t => {
  const f = await fixture(t);
  await f.prepare({ type: "fix" });
  await assert.rejects(f.tag(), /staged, unstaged, and untracked/);
  await f.git("add", manifest);
  await assert.rejects(f.tag(), /staged, unstaged, and untracked/);
  await f.git("commit", "--quiet", "-m", "fix: release fixture");
  await f.git("push", "--quiet", "origin", "main");
  await writeFile(join(f.root, "untracked.txt"), "uncommitted");
  await assert.rejects(f.tag(), /staged, unstaged, and untracked/);
  assert.equal(await f.git("tag", "--list", "v0.2.2"), "");
});

test("unpublished commits and non-main checkouts cannot release", async t => {
  const f = await fixture(t);
  await f.commitVersion("fix", false);
  await assert.rejects(f.tag(), /Push your committed main branch/);
  assert.equal(await f.git("tag", "--list", "v0.2.2"), "");
  await f.git("switch", "--quiet", "-c", "feature");
  await assert.rejects(f.tag(), /from main/);
  await f.git("switch", "--quiet", "--detach");
  await assert.rejects(f.tag(), /from main/);
});

test("tag dry-run queries the remote but creates or pushes no tag", async t => {
  const f = await fixture(t);
  await f.commitVersion();
  const plan = await f.tag({ dryRun: true });
  assert.equal(plan.state, "would-create-and-push");
  assert.equal(plan.tag, "v0.2.2");
  assert.equal(await f.git("tag", "--list", plan.tag), "");
  assert.equal(await f.git("ls-remote", "origin", `refs/tags/${plan.tag}`), "");
});

test("tag task pushes exactly an annotated committed-version tag and retries are no-ops", async t => {
  const f = await fixture(t);
  await f.commitVersion();
  const head = await f.git("rev-parse", "HEAD");
  const before = await f.git("ls-remote", "origin", "refs/heads/main");
  await f.git("tag", "-a", "unrelated-extra", "-m", "Unrelated local tag");
  await f.git("config", "push.followTags", "true");
  const result = await f.tag();
  assert.equal(result.state, "pushed");
  assert.equal(result.head, head);
  assert.equal(await f.git("cat-file", "-t", "refs/tags/v0.2.2"), "tag");
  assert.equal(await f.git("rev-parse", "v0.2.2^{commit}"), head);
  assert.ok((await f.git("ls-remote", "origin", "refs/tags/v0.2.2^{}")).startsWith(head));
  assert.equal(await f.git("ls-remote", "origin", "refs/heads/main"), before);
  assert.equal(await f.git("ls-remote", "origin", "refs/tags/unrelated-extra"), "");
  assert.equal((await f.tag()).state, "already-pushed");
  assert.equal((await f.prepare({ type: "fix" })).version, "0.2.3");
});

test("local tags for another commit and lightweight tags are not changed", async t => {
  const f = await fixture(t);
  await f.commitVersion();
  await f.git("tag", "-a", "v0.2.2", "-m", "conflict", f.initial);
  await assert.rejects(f.tag(), /another commit/);
  assert.equal(await f.git("rev-parse", "v0.2.2^{commit}"), f.initial);
  // This deletes only a synthetic fixture tag so the second rejection can be tested.
  await f.git("tag", "-d", "v0.2.2");
  await f.git("tag", "v0.2.2");
  await assert.rejects(f.tag(), /lightweight/);
  assert.equal(await f.git("cat-file", "-t", "v0.2.2"), "commit");
  assert.equal(await f.git("ls-remote", "origin", "refs/tags/v0.2.2"), "");
});

test("remote-only conflicting tags are detected before local tag creation", async t => {
  const f = await fixture(t);
  await f.commitVersion();
  await f.git("--git-dir", f.remote, "tag", "v0.2.2", f.initial);
  await assert.rejects(f.tag(), /exists remotely at another commit/);
  assert.equal(await f.git("tag", "--list", "v0.2.2"), "");
});

test("an already-published remote tag is a no-op even if missing locally", async t => {
  const f = await fixture(t);
  await f.commitVersion();
  await f.git("--git-dir", f.remote, "tag", "v0.2.2", "main");
  assert.equal((await f.tag()).state, "already-pushed");
  assert.equal(await f.git("tag", "--list", "v0.2.2"), "");
});

test("a failed push retains the local tag and can safely be retried", async t => {
  const f = await fixture(t);
  await f.commitVersion();
  const lockedRef = join(f.remote, "refs", "tags", "v0.2.2.lock");
  await writeFile(lockedRef, "synthetic remote ref lock");
  await assert.rejects(f.tag(), /local v0.2.2 tag was retained/);
  assert.equal(await f.git("cat-file", "-t", "v0.2.2"), "tag");
  assert.equal(await f.git("ls-remote", "origin", "refs/tags/v0.2.2"), "");
  await rm(lockedRef);
  assert.equal((await f.tag()).state, "pushed");
});

test("checks follow the actual push destination rather than the fetch URL", async t => {
  const f = await fixture(t);
  await f.commitVersion();
  const other = join(f.temporary, "different remote.git");
  await f.git("init", "--quiet", "--bare", "--initial-branch=main", other);
  await f.git("remote", "set-url", "--push", "origin", other);
  await assert.rejects(f.tag(), /HEAD must match origin\/main at the push destination/);
  assert.equal(await f.git("tag", "--list", "v0.2.2"), "");
  await f.git("remote", "set-url", "--add", "--push", "origin", f.remote);
  await assert.rejects(f.tag(), /exactly one push destination/);
});

test("an unreachable remote fails explicitly without creating a local tag", async t => {
  const f = await fixture(t);
  await f.commitVersion();
  await f.git("remote", "set-url", "origin", join(f.temporary, "missing.git"));
  await assert.rejects(f.tag(), /Git ls-remote failed/);
  assert.equal(await f.git("tag", "--list", "v0.2.2"), "");
});

test("npm commands and VS Code tasks agree and retain the browser-test task", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", repositoryRoot), "utf8"));
  const tasks = JSON.parse(await readFile(new URL(".vscode/tasks.json", repositoryRoot), "utf8"));
  assert.equal(pkg.scripts["release:prepare"], "node scripts/release.mjs prepare");
  assert.equal(pkg.scripts["release:tag"], "node scripts/release.mjs tag");
  assert.ok(tasks.tasks.some(task => task.label === "Flight Recorder: Browser Tests"));
  for (const [label, action] of [["Prepare Release Version", "prepare"], ["Check Release Tag (Dry Run)", "tag"],
    ["Create and Push Release Tag", "tag"]]) {
    const task = tasks.tasks.find(value => value.label === `Flight Recorder: ${label}`);
    assert.ok(task);
    assert.equal(task.type, "process");
    assert.equal(task.command, "node");
    assert.equal(task.args[1], action);
    assert.equal(task.options.cwd, "${workspaceFolder}");
    assert.equal(task.runOptions?.runOn, undefined, "Release tasks must not run when a folder opens");
  }
});
