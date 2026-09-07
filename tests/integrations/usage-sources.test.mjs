import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import sources from "../../extensions/flight-recorder/usage-sources.cjs";

const { discoverSources, readSource, listDatabaseSessions, SourceError } = sources;
const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), `.usage-sources-fixtures-${randomUUID()}`);
await fs.mkdir(fixtureRoot);
after(() => fs.rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const sessionId = "11111111-2222-3333-4444-555555555555";
const anotherSession = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const time = "2026-09-06T12:00:00.000Z";
const privateText = "PRIVATE PROMPT AND RESPONSE NEVER EXPORT";
const hex = /^[0-9a-f]{64}$/;
const request = (result = {}, extra = {}) => ({
  requestId: "private-request-id", message: { text: privateText },
  response: [{ kind: "markdownContent", content: { value: privateText } }],
  result, modelId: "gpt-5", timestamp: 1788696000000, ...extra
});
const chat = (...requests) => ({ version: 3, sessionId: "private-session-id", customTitle: privateText, requests });
const event = (type, data, extra = {}) => ({ id: randomUUID(), type, timestamp: time, data, ...extra });
const jsonl = events => events.map(value => JSON.stringify(value)).join("\n") + "\n";

async function fixture(value, extension = ".json", kind = "vscode-chat") {
  const file = path.join(fixtureRoot, `${randomUUID()}${extension}`);
  await fs.writeFile(file, typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  return { kind, path: file };
}

function errorCode(code) {
  return error => {
    assert.ok(error instanceof SourceError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /PRIVATE|private-request|SQLITE_ERROR|SELECT .* FROM|fixtures-/);
    return true;
  };
}

function assertPrivate(snapshot) {
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /PRIVATE|private-request-id|private-session-id|fixtures-|tool-secret|prompt|response|sessionId|path":/);
  assert.match(snapshot.sourceId, hex);
  assert.match(snapshot.revision, hex);
  for (const observation of snapshot.observations) {
    assert.match(observation.id, hex);
    assert.ok(["measured", "estimated", "unavailable"].includes(observation.quality));
    for (const [name, value] of Object.entries(observation)) {
      if (name.endsWith("Tokens") || name === "nanoAiu") {
        assert.ok(Number.isSafeInteger(value) && value >= 0);
        assert.ok(value <= (name === "nanoAiu" ? Number.MAX_SAFE_INTEGER : 2147483647));
      }
    }
  }
}

test("Windows temporary short paths resolve to the same source identity as canonical paths", {
  skip: process.platform !== "win32"
}, async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "recorder-path-"));
  try {
    const file = path.join(directory, "session.json");
    await fs.writeFile(file, JSON.stringify(chat(request({ usage: { promptTokens: 1, completionTokens: 0 } }))));
    const short = await readSource({ kind: "vscode-chat", path: file });
    const canonical = await readSource({ kind: "vscode-chat", path: await fs.realpath(file) });
    assert.equal(short.sourceId, canonical.sourceId);
    assert.equal(short.revision, canonical.revision);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("JSON formats retain measured counts, explicit zero, model and actual timestamp only", async () => {
  for (const result of [
    { usage: { promptTokens: 12, completionTokens: 0 } },
    { promptTokens: 12, outputTokens: 0 },
    { metadata: { promptTokens: 12, outputTokens: 0 } }
  ]) {
    const snapshot = await readSource(await fixture(chat(request(result))));
    assert.equal(snapshot.format, "vscode-json");
    assert.equal(snapshot.observations[0].inputTokens, 12);
    assert.equal(snapshot.observations[0].outputTokens, 0);
    assert.equal(snapshot.observations[0].model, "gpt-5");
    assert.equal(snapshot.observations[0].quality, "measured");
    assert.ok(snapshot.observations[0].timestamp.endsWith("Z"));
    assertPrivate(snapshot);
  }
});

test("missing counters are not zero, missing model/time are not invented", async () => {
  const source = await fixture(chat(request({ usage: { promptTokens: 0, completionTokens: null } }, { modelId: undefined, timestamp: undefined })));
  const measured = (await readSource(source, { allowEstimates: true })).observations[0];
  assert.equal(measured.inputTokens, 0);
  for (const field of ["model", "timestamp", "outputTokens", "estimatedInputTokens", "estimatedOutputTokens"]) {
    assert.equal(Object.hasOwn(measured, field), false);
  }
  const unavailable = await readSource(await fixture(chat(request())));
  assert.equal(unavailable.observations[0].quality, "unavailable");
  assert.equal(Object.hasOwn(unavailable.observations[0], "inputTokens"), false);
  assert.ok(unavailable.warnings.some(warning => warning.includes("no supported measured usage")));
});

test("invalid numeric usage rejects the whole snapshot, including conflicting known formats", async () => {
  for (const value of [-1, 1.5, "2", true, 2147483648, 1e100]) {
    await assert.rejects(readSource(await fixture(chat(request({ usage: { promptTokens: value } })))), errorCode("INVALID_USAGE"));
  }
  await assert.rejects(readSource(await fixture(chat(request({
    usage: { promptTokens: 1 }, promptTokens: 2
  })))), errorCode("INVALID_USAGE"));
  const valid = await readSource(await fixture(chat(request({ promptTokens: 2147483647, outputTokens: 0 }))));
  assert.equal(valid.observations[0].inputTokens, 2147483647);
});

test("character estimates are opt-in and separate from billed counters, omit tools and thinking", async () => {
  const source = await fixture(chat(request({}, {
    message: { text: "12345", parts: [{ text: "duplicate" }] },
    response: [
      { kind: "markdownContent", content: { value: "123456789" }, value: "duplicate" },
      { kind: "toolInvocationSerialized", value: "tool-secret" },
      { kind: "thinking", value: "private-thinking" }
    ]
  })));
  const off = (await readSource(source)).observations[0];
  assert.equal(off.quality, "unavailable");
  assert.equal(off.estimatedInputTokens, undefined);
  const on = await readSource(source, { allowEstimates: true });
  assert.equal(on.observations[0].quality, "estimated");
  assert.equal(on.observations[0].estimatedInputTokens, 2);
  assert.equal(on.observations[0].estimatedOutputTokens, 3);
  assert.equal(on.observations[0].inputTokens, undefined);
  assert.ok(on.warnings.some(warning => warning.includes("not actual model context")));
  assertPrivate(on);
});

test("identities survive updates and file touches; revisions reflect normalized evidence only", async () => {
  const source = await fixture(chat(request({ promptTokens: 2 })));
  const first = await readSource(source);
  await fs.utimes(source.path, new Date(), new Date());
  const repeated = await readSource(source);
  assert.deepEqual(first, repeated);
  await fs.writeFile(source.path, JSON.stringify(chat(request({ promptTokens: 3 }))));
  const updated = await readSource(source);
  assert.equal(first.sourceId, updated.sourceId);
  assert.equal(first.observations[0].id, updated.observations[0].id);
  assert.notEqual(first.revision, updated.revision);
  const separate = await readSource(await fixture(chat(request({ promptTokens: 2 }))));
  assert.notEqual(first.sourceId, separate.sourceId);
  assert.notEqual(first.observations[0].id, separate.observations[0].id);
});

test("stable request index works without IDs; known IDs are independent of order", async () => {
  const source = await fixture(chat(request({ promptTokens: 1 }, { requestId: undefined })));
  const before = await readSource(source);
  await fs.writeFile(source.path, JSON.stringify(chat(request({ promptTokens: 2 }, { requestId: undefined }))));
  const after = await readSource(source);
  assert.equal(before.observations[0].id, after.observations[0].id);
  const a = request({ promptTokens: 2 }, { requestId: "a" });
  const b = request({ promptTokens: 3 }, { requestId: "b" });
  await fs.writeFile(source.path, JSON.stringify(chat(a, b)));
  const ordered = await readSource(source);
  await fs.writeFile(source.path, JSON.stringify(chat(b, a)));
  assert.deepEqual(await readSource(source), ordered);
});

test("delta initial, replace and array append reconstruct only the final usage", async () => {
  const source = await fixture(jsonl([
    { kind: 0, v: { version: 3, requests: [] } },
    { kind: 2, k: ["requests"], v: [request()] },
    { kind: 1, k: ["requests", 0, "result"], v: { usage: { promptTokens: 4, completionTokens: 5 } } },
    { kind: 1, k: ["requests", "0", "result", "usage", "completionTokens"], v: 9 },
    { kind: 2, k: ["requests", 0, "response"], v: [{ kind: "markdownContent", value: privateText }] }
  ]), ".jsonl");
  const snapshot = await readSource(source);
  assert.equal(snapshot.format, "vscode-delta-jsonl");
  assert.equal(snapshot.observations.length, 1);
  assert.equal(snapshot.observations[0].inputTokens, 4);
  assert.equal(snapshot.observations[0].outputTokens, 9);
  assertPrivate(snapshot);
});

test("delta updates reject prototype paths, unsafe values, sparse arrays and invalid types", async () => {
  for (const delta of [
    { kind: 1, k: ["__proto__", "polluted"], v: "yes" },
    { kind: 1, k: ["requests", "constructor", "prototype"], v: "yes" },
    { kind: 1, k: ["requests", -1], v: request() },
    { kind: 1, k: ["requests", "length"], v: 0 },
    { kind: 1, k: ["requests", 2], v: request() },
    { kind: 2, k: ["version"], v: [] },
    { kind: 8, k: ["requests"], v: [] }
  ]) {
    await assert.rejects(readSource(await fixture(jsonl([{ kind: 0, v: { version: 3, requests: [] } }, delta]), ".jsonl")),
      errorCode("UNSUPPORTED_FORMAT"));
  }
  const unsafe = '{"kind":0,"v":{"requests":[],"__proto__":{"polluted":true}}}\n';
  await assert.rejects(readSource(await fixture(unsafe, ".jsonl")), errorCode("UNSUPPORTED_FORMAT"));
  assert.equal({}.polluted, undefined);
  await assert.rejects(readSource(await fixture(jsonl([
    { kind: 0, v: { requests: [] } }, { kind: 1, k: ["requests", 4294967294], v: request() }
  ]), ".jsonl")), errorCode("SOURCE_TOO_LARGE"));
});

test("incomplete final JSONL records never import a partial snapshot", async () => {
  const complete = jsonl([{ kind: 0, v: chat(request({ promptTokens: 10 })) }]);
  const source = await fixture(complete, ".jsonl");
  const previous = await readSource(source);
  await fs.appendFile(source.path, '{"kind":1,"k":["requests"');
  await assert.rejects(readSource(source), errorCode("SOURCE_CHANGED"));
  await fs.writeFile(source.path, complete.trimEnd());
  assert.deepEqual(await readSource(source), previous);
  await fs.writeFile(source.path, complete + "broken\n");
  await assert.rejects(readSource(source), errorCode("UNSUPPORTED_FORMAT"));
});

test("arbitrary JSON/JSONL is not silently accepted as a zero-usage session", async () => {
  for (const [value, extension] of [
    [{ hello: privateText }, ".json"], [{ requests: [1] }, ".json"],
    [{ requests: [{}] }, ".json"], [jsonl([{ type: "unknown", data: {} }]), ".jsonl"],
    [jsonl([{ type: "user.message", data: {} }]), ".jsonl"],
    [jsonl([{ kind: 1, k: ["requests"], v: [] }]), ".jsonl"],
    ["", ".jsonl"], [Buffer.from([0xff]), ".json"]
  ]) await assert.rejects(readSource(await fixture(value, extension)), errorCode("UNSUPPORTED_FORMAT"));
  const empty = await readSource(await fixture({ requests: [] }));
  assert.equal(empty.observations.length, 0);
  assert.ok(empty.warnings.length);
});

test("unsafe models and invalid dates cannot leak content into snapshots", async () => {
  const source = await fixture(chat(request({ promptTokens: 5 }, {
    modelId: "PRIVATE PROMPT AND RESPONSE NEVER EXPORT",
    timestamp: "2026-02-30T12:00:00Z"
  })));
  const snapshot = await readSource(source);
  assert.equal(snapshot.observations[0].model, undefined);
  assert.equal(snapshot.observations[0].timestamp, undefined);
  assert.equal(snapshot.warnings.length, 2);
  assertPrivate(snapshot);
});

test("CLI usage events preserve call/cache counts without adding shutdown totals", async () => {
  const usage = event("assistant.usage", {
    model: "claude-sonnet-4.6", inputTokens: 100, outputTokens: 10,
    cacheReadTokens: 80, cacheWriteTokens: 5, copilotUsage: { totalNanoAiu: 123 },
    prompt: privateText, duration: 999
  }, { id: "private-call-id" });
  const source = await fixture(jsonl([
    event("session.start", { sessionId }), event("user.message", { content: privateText }),
    usage, usage,
    event("session.shutdown", { modelMetrics: { "claude-sonnet-4.6": { usage: { inputTokens: 100, outputTokens: 10 } } } })
  ]), ".jsonl", "copilot-cli");
  const snapshot = await readSource(source);
  assert.equal(snapshot.format, "copilot-cli-events");
  assert.equal(snapshot.observations.length, 1);
  const observed = snapshot.observations[0];
  assert.equal(observed.inputTokens, 100);
  assert.equal(observed.cacheReadTokens, 80);
  assert.equal(observed.cacheWriteTokens, 5);
  assert.equal(observed.nanoAiu, 123);
  assert.equal(observed.duration, undefined);
  assert.ok(snapshot.warnings.some(warning => warning.includes("shutdown totals were not added")));
  assertPrivate(snapshot);
});

test("CLI shutdown fallback keeps latest model totals and separately recorded billing", async () => {
  const source = await fixture(jsonl([
    event("session.shutdown", { modelMetrics: { "gpt-5": { usage: { inputTokens: 9, outputTokens: 2 } } } }),
    event("session.shutdown", { modelMetrics: {
      "gpt-5": { usage: { inputTokens: 12, outputTokens: 0, cacheReadTokens: 8, cacheWriteTokens: 1 } }
    }, totalNanoAiu: 555 })
  ]), ".jsonl", "copilot-cli");
  const snapshot = await readSource(source);
  assert.equal(snapshot.observations.length, 2);
  assert.equal(snapshot.observations.find(item => item.model).inputTokens, 12);
  const billing = snapshot.observations.find(item => item.nanoAiu !== undefined);
  assert.equal(billing.nanoAiu, 555);
  assert.equal(billing.quality, "unavailable");
  assert.equal(billing.model, undefined);
  assert.equal(billing.inputTokens, undefined);
});

test("billing-only quality is unavailable, and CLI billing never crosses into a VS Code source", async () => {
  const source = await fixture(jsonl([
    event("assistant.usage", { model: "gpt-5", copilotUsage: { totalNanoAiu: 7 } })
  ]), ".jsonl", "copilot-cli");
  const billing = await readSource(source);
  assert.equal(billing.observations[0].quality, "unavailable");
  assert.equal(billing.observations[0].nanoAiu, 7);
  const nonCli = await readSource({ ...source, kind: "vscode-chat" });
  assert.equal(nonCli.observations[0].quality, "unavailable");
  assert.equal(nonCli.observations[0].nanoAiu, undefined);
  assert.ok(nonCli.warnings.some(warning => warning.includes("CLI billing fields were omitted")));
});

test("known event transcripts support opt-in estimates but never invent missing input from real output", async () => {
  const events = [
    event("user.message", { content: "12345" }),
    event("assistant.message", { content: "123456789" }),
    event("tool.execution_complete", { result: { content: "tool-secret" } })
  ];
  const source = await fixture(jsonl(events), ".jsonl");
  const snapshot = await readSource(source, { allowEstimates: true });
  assert.equal(snapshot.format, "vscode-event-jsonl");
  assert.equal(snapshot.observations[0].estimatedInputTokens, 2);
  assert.equal(snapshot.observations[0].estimatedOutputTokens, 3);
  events[1].data.outputTokens = 0;
  await fs.writeFile(source.path, jsonl(events));
  const measured = await readSource(source, { allowEstimates: true });
  assert.equal(measured.observations[0].outputTokens, 0);
  assert.equal(measured.observations[0].estimatedInputTokens, undefined);
  assert.equal(measured.observations[0].quality, "measured");
});

test("discovery does no implicit probing and stays within supplied known layouts", async () => {
  assert.deepEqual(await discoverSources({ fs: new Proxy({}, { get() { throw new Error("No filesystem allowed"); } }) }), []);
  const root = path.join(fixtureRoot, randomUUID());
  const user = path.join(root, "User");
  const home = path.join(root, "copilot");
  const paths = [
    path.join(user, "workspaceStorage", "hash", "chatSessions", `${randomUUID()}.json`),
    path.join(user, "workspaceStorage", "hash", "GitHub.copilot-chat", "transcripts", "private-title.jsonl"),
    path.join(user, "globalStorage", "github.copilot", "chatSessions", "transcripts", "item.jsonl"),
    path.join(user, "globalStorage", "emptyWindowChatSessions", "item.json"),
    path.join(home, "session-store.db"),
    path.join(home, "session-state", sessionId, "events.jsonl")
  ];
  for (const file of paths) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "not read"); }
  const outside = path.join(root, "other-user", "chatSessions", "private-title.json");
  await fs.mkdir(path.dirname(outside), { recursive: true });
  await fs.writeFile(outside, "not read");
  const descriptors = await discoverSources({ vscodeUserPath: user, copilotHome: home });
  assert.equal(descriptors.length, paths.length);
  assert.equal(descriptors[0].path, path.join(home, "session-store.db"));
  assert.deepEqual(new Set(descriptors.map(item => item.path)), new Set(paths));
  assert.ok(descriptors.every(item => !item.label.includes("private") && !item.label.includes("not read")));
});

test("missing and denied paths surface safe errors; relative sources are refused", async () => {
  await assert.rejects(readSource({ kind: "vscode-chat", path: path.join(fixtureRoot, "missing.json") }), errorCode("SOURCE_UNAVAILABLE"));
  await assert.rejects(readSource({ kind: "vscode-chat", path: "relative.json" }), errorCode("SOURCE_UNAVAILABLE"));
  const denied = { ...fs, lstat: async () => { throw Object.assign(new Error(privateText), { code: "EACCES" }); } };
  await assert.rejects(discoverSources({ vscodeUserPath: fixtureRoot, fs: denied }), errorCode("SOURCE_UNAVAILABLE"));
  await assert.rejects(readSource(await fixture(chat(request())), { fs: denied }), errorCode("SOURCE_UNAVAILABLE"));
});

test("symlink files and symlink parents are refused without following them", async t => {
  const target = path.join(fixtureRoot, randomUUID());
  const link = path.join(fixtureRoot, randomUUID());
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "session.json"), JSON.stringify(chat(request())));
  try { await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (error.code === "EPERM" || error.code === "ENOTSUP") { t.skip("Host does not permit synthetic symlinks."); return; }
    throw error;
  }
  await assert.rejects(readSource({ kind: "vscode-chat", path: path.join(link, "session.json") }), errorCode("SOURCE_UNAVAILABLE"));
  await assert.rejects(discoverSources({ copilotHome: link }), errorCode("SOURCE_UNAVAILABLE"));
});

test("text, request, nesting and discovery entry limits fail rather than truncate evidence", async () => {
  const large = await fixture("x".repeat(16 * 1024 * 1024 + 1));
  await assert.rejects(readSource(large), errorCode("SOURCE_TOO_LARGE"));
  await assert.rejects(readSource(await fixture(chat(...Array.from({ length: 1001 }, (_, n) => request({}, { requestId: String(n) }))))),
    errorCode("SOURCE_TOO_LARGE"));
  const deeplyNested = '{"requests":[],"nested":' + "[".repeat(66) + "0" + "]".repeat(66) + "}";
  await assert.rejects(readSource(await fixture(deeplyNested)), errorCode("SOURCE_TOO_LARGE"));
  const fakeFs = { ...fs, opendir: async () => ({
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < 5001; i++) yield { name: String(i), isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true };
    }
  }) };
  await assert.rejects(discoverSources({ copilotHome: fixtureRoot, fs: fakeFs }), errorCode("SOURCE_TOO_LARGE"));
});

test("changed files are rejected before producing evidence", async () => {
  const source = await fixture(chat(request()));
  let count = 0;
  const changingFs = {
    ...fs,
    lstat: async file => {
      const stat = await fs.lstat(file);
      if (file === source.path && ++count >= 3) stat.mtimeMs++;
      return stat;
    }
  };
  await assert.rejects(readSource(source, { fs: changingFs }), errorCode("SOURCE_CHANGED"));
});

let DatabaseSync;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* Older VS Code/Node: covered by actionable fallback test. */ }
const sqliteOptions = { skip: !DatabaseSync && "Built-in node:sqlite is unavailable in this runtime; no dependency installed." };

async function database(schema = "id INTEGER PRIMARY KEY, session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, total_nano_aiu INTEGER") {
  const file = path.join(fixtureRoot, `${randomUUID()}.db`);
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE assistant_usage_events (${schema})`);
  return { db, source: { kind: "copilot-cli", path: file, sessionId } };
}

test("missing built-in SQLite is actionable and never invokes external fallbacks", async () => {
  const source = await fixture("synthetic", ".db", "copilot-cli");
  await assert.rejects(listDatabaseSessions(source.path, { DatabaseSync: null }), error => {
    errorCode("SQLITE_UNAVAILABLE")(error);
    assert.match(error.message, /Update VS Code/);
    assert.match(error.message, /JSON\/JSONL export/);
    return true;
  });
});

test("SQLite session picker queries usage IDs only; reader preserves stable per-call fields", sqliteOptions, async () => {
  const { db, source } = await database();
  try {
    db.exec("CREATE TABLE turns (user_message TEXT); INSERT INTO turns VALUES ('PRIVATE PROMPT')");
    const insert = db.prepare("INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run(1, sessionId, "gpt-5", 100, 0, 90, 4, 123n);
    insert.run(2, anotherSession, "gpt-5", 999, 9, 0, 0, 777n);
    const before = await fs.readFile(source.path);
    const sessions = await listDatabaseSessions(source.path);
    assert.equal(sessions.length, 2);
    assert.ok(sessions.every(item => UUIDlike(item.sessionId) && /^Session [a-f0-9]{8}$/i.test(item.label)));
    const snapshot = await readSource(source);
    assert.equal(snapshot.observations.length, 1);
    assert.equal(snapshot.observations[0].inputTokens, 100);
    assert.equal(snapshot.observations[0].outputTokens, 0);
    assert.equal(snapshot.observations[0].cacheReadTokens, 90);
    assert.equal(snapshot.observations[0].cacheWriteTokens, 4);
    assert.equal(snapshot.observations[0].nanoAiu, 123);
    assert.equal(snapshot.observations[0].timestamp, undefined);
    assert.deepEqual(await fs.readFile(source.path), before);
    const other = await readSource({ ...source, sessionId: anotherSession });
    assert.notEqual(snapshot.sourceId, other.sourceId);
    assertPrivate(snapshot);
  } finally { db.close(); }
});
function UUIDlike(value) { return /^[0-9a-f-]{36}$/i.test(value); }

test("SQLite keyless usage aggregates deterministic model totals and omits incomplete fields", sqliteOptions, async () => {
  const { db, source } = await database("session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, total_nano_aiu INTEGER");
  try {
    const insert = db.prepare("INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?, ?, ?, ?)");
    insert.run(sessionId, "gpt-5", 5, 1, 3, 0, 123n);
    insert.run(sessionId, "gpt-5", 7, 2, 4, 0, 124n);
    insert.run(sessionId, "claude-sonnet-4.6", 9, null, 8, 0, null);
    const snapshot = await readSource(source);
    assert.equal(snapshot.observations.length, 2);
    const gpt = snapshot.observations.find(item => item.model === "gpt-5");
    assert.equal(gpt.inputTokens, 12);
    assert.equal(gpt.outputTokens, 3);
    assert.equal(gpt.cacheReadTokens, 7);
    assert.equal(gpt.nanoAiu, 247);
    const claude = snapshot.observations.find(item => item.model === "claude-sonnet-4.6");
    assert.equal(claude.outputTokens, undefined);
    assert.equal(claude.nanoAiu, undefined);
    db.exec("VACUUM");
    assert.deepEqual(await readSource(source), snapshot);
    insert.run(sessionId, "gpt-5", 1, 1, 0, 0, 1n);
    const updated = await readSource(source);
    assert.notEqual(updated.revision, snapshot.revision);
    assert.equal(updated.observations.find(item => item.model === "gpt-5").id, gpt.id);
  } finally { db.close(); }
});

test("SQLite actual invalid numeric storage and bigint overflows fail safely", sqliteOptions, async () => {
  const { db, source } = await database();
  try {
    const insert = db.prepare("INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const value of [-1, 1.5, "invalid", 2147483648n]) {
      db.exec("DELETE FROM assistant_usage_events");
      insert.run(1, sessionId, "gpt-5", value, 0, 0, 0, 0);
      await assert.rejects(readSource(source), errorCode("INVALID_USAGE"));
    }
    db.exec("DELETE FROM assistant_usage_events");
    insert.run(1, sessionId, "gpt-5", 1, 0, 0, 0, 9007199254740992n);
    await assert.rejects(readSource(source), errorCode("INVALID_USAGE"));
  } finally { db.close(); }
});

test("SQLite aggregate overflow is not rounded or clamped", sqliteOptions, async () => {
  const { db, source } = await database("session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER");
  try {
    const insert = db.prepare("INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?)");
    insert.run(sessionId, "gpt-5", 2147483647, 0);
    insert.run(sessionId, "gpt-5", 1, 0);
    await assert.rejects(readSource(source), errorCode("INVALID_USAGE"));
  } finally { db.close(); }
});

test("SQLite unsupported tables and views are not guessed into zero usage", sqliteOptions, async () => {
  const { db, source } = await database("session_id TEXT, model TEXT, future_tokens INTEGER");
  try {
    await assert.rejects(readSource(source), errorCode("UNSUPPORTED_FORMAT"));
    db.exec("DROP TABLE assistant_usage_events; CREATE VIEW assistant_usage_events AS SELECT 'PRIVATE' AS session_id, 'gpt-5' AS model, 1 AS input_tokens, 1 AS output_tokens");
    await assert.rejects(listDatabaseSessions(source.path), errorCode("UNSUPPORTED_FORMAT"));
  } finally { db.close(); }
});

test("SQLite live WAL changes are read transactionally and read-only", sqliteOptions, async () => {
  const { db, source } = await database();
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    const insert = db.prepare("INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run(1, sessionId, "gpt-5", 10, 1, 0, 0, 1);
    const before = await readSource(source);
    insert.run(2, sessionId, "gpt-5", 20, 2, 0, 0, 2);
    const after = await readSource(source);
    assert.equal(after.observations.length, 2);
    assert.notEqual(before.revision, after.revision);
    assert.ok(after.observations.some(item => item.id === before.observations[0].id));
  } finally { db.close(); }
});

test("database size is capped before SQLite opens the file", async () => {
  const source = await fixture("synthetic", ".db", "copilot-cli");
  const oversized = {
    ...fs,
    lstat: async file => {
      const stat = await fs.lstat(file);
      if (file === source.path) stat.size = 64 * 1024 * 1024 + 1;
      return stat;
    }
  };
  await assert.rejects(listDatabaseSessions(source.path, { fs: oversized, DatabaseSync: null }), errorCode("SOURCE_TOO_LARGE"));
});

test("SQLite backing database and WAL updates during a read require retry", sqliteOptions, async () => {
  const { db, source } = await database();
  try {
    const insert = db.prepare("INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run(1, sessionId, "gpt-5", 10, 1, 0, 0, 1);
    let databaseStats = 0;
    const changingDb = {
      ...fs,
      lstat: async file => {
        if (file === source.path && ++databaseStats === 3) insert.run(2, sessionId, "gpt-5", 20, 2, 0, 0, 2);
        return fs.lstat(file);
      }
    };
    await assert.rejects(readSource(source, { fs: changingDb }), errorCode("SOURCE_CHANGED"));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    insert.run(3, sessionId, "gpt-5", 30, 3, 0, 0, 3);
    let walStats = 0;
    const changingWal = {
      ...fs,
      lstat: async file => {
        if (file === `${source.path}-wal` && ++walStats === 2) insert.run(4, sessionId, "gpt-5", 40, 4, 0, 0, 4);
        return fs.lstat(file);
      }
    };
    await assert.rejects(readSource(source, { fs: changingWal }), errorCode("SOURCE_CHANGED"));
    assert.equal((await readSource(source)).observations.length, 4);
  } finally { db.close(); }
});

test("SQLite uses read-only mode, disabled extensions, and a bounded busy timeout", sqliteOptions, async () => {
  const { db, source } = await database();
  const observed = [];
  class CheckedDatabase {
    constructor(file, options) {
      assert.equal(options.readOnly, true);
      assert.equal(options.allowExtension, false);
      assert.equal(options.timeout, 200);
      const reader = new DatabaseSync(file, options);
      return {
        exec(sql) {
          reader.exec(sql);
          if (sql.includes("busy_timeout")) observed.push(reader.prepare("PRAGMA busy_timeout").get().timeout);
        },
        prepare: reader.prepare.bind(reader),
        close: reader.close.bind(reader)
      };
    }
  }
  try {
    await readSource(source, { DatabaseSync: CheckedDatabase });
    assert.deepEqual(observed, [200]);
    db.exec("BEGIN EXCLUSIVE");
    await assert.rejects(readSource(source), errorCode("SOURCE_CHANGED"));
    db.exec("ROLLBACK");
  } finally { db.close(); }
});
