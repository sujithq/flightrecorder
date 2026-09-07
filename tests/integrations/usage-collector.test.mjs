import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mockVscode } from "./helpers/vscode.mjs";

const require = createRequire(import.meta.url);
const { UsageCollection, registerUsageCollection, importBody } = require("../../extensions/flight-recorder/usage-collector.cjs");
const sourceId = "a".repeat(64);
const runId = "11111111-2222-3333-4444-555555555555";
const revision = "b".repeat(64);
const source = { kind: "vscode-chat", path: "C:\\selected\\session.json", label: "Session fixture" };
const snapshot = {
  sourceId, sourceKind: "vscode-chat", format: "vscode-json", revision, warnings: [],
  observations: [{ id: "c".repeat(64), quality: "measured", model: "test-model", inputTokens: 10, outputTokens: 2 }]
};

function runtime(overrides = {}) {
  const requests = [];
  const reads = [];
  const reports = [];
  const errors = [];
  let timer;
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (options.method === "GET") return Response.json({ id: runId, usageImports: [] });
    const body = JSON.parse(options.body);
    return Response.json({ sourceId, revision: body.revision, importedCount: body.observations.length, changed: true });
  };
  const collector = new UsageCollection({
    source, sourceId, runId, origin: "http://localhost:5080",
    readSource: async (...args) => { reads.push(args); return structuredClone(snapshot); },
    fetchImpl, report: value => reports.push(value), onError: error => errors.push(error),
    schedule: callback => { timer = callback; return { unref() {} }; },
    unschedule: () => { timer = undefined; }, ...overrides
  });
  return { collector, requests, reads, reports, errors, tick: () => timer?.(), timer: () => timer };
}

test("collector construction does not discover, read or transmit", () => {
  const f = runtime();
  assert.equal(f.reads.length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.timer(), undefined);
});

test("collector sends only whitelisted metadata and the revision previously read from the run", async () => {
  let body;
  const f = runtime({
    readSource: async () => ({ ...snapshot, rawText: "private transcript",
      observations: snapshot.observations.map(item => ({ ...item, prompt: "private prompt", file: "private file" })) }),
    fetchImpl: async (url, options) => {
      assert.equal(options.redirect, "error");
      assert.equal(new URL(url).hostname, "localhost");
      if (options.method === "GET") return Response.json({ id: runId, usageImports: [{ sourceId, revision: "d".repeat(64) }] });
      body = JSON.parse(options.body);
      return Response.json({ sourceId, revision, importedCount: 1, changed: true });
    }
  });
  await f.collector.start();
  assert.equal(body.expectedRevision, "d".repeat(64));
  assert.equal(body.observations[0].inputTokens, 10);
  assert.doesNotMatch(JSON.stringify(body), /private|selected|session\.json/);
  assert.deepEqual(f.reports[0].qualities, { measured: 1, estimated: 0, unavailable: 0 });
  assert.ok(f.timer());
  await f.collector.stop();
  assert.equal(f.timer(), undefined);
});

test("repeating a snapshot uses server cursors and creates no local append events", async () => {
  let cursor = null;
  let storedEvents = 0;
  const f = runtime({
    fetchImpl: async (_url, options) => {
      if (options.method === "GET") return Response.json({ id: runId, usageImports: cursor ? [{ sourceId, revision: cursor }] : [] });
      const body = JSON.parse(options.body);
      assert.equal(body.expectedRevision, cursor);
      const changed = cursor !== body.revision;
      if (changed) storedEvents++;
      cursor = body.revision;
      return Response.json({ sourceId, revision: cursor, importedCount: 1, changed });
    }
  });
  await f.collector.sync();
  await f.collector.sync();
  assert.equal(storedEvents, 1);
  assert.equal(f.collector.lastResult.changed, false);
});

test("overlapping sync requests share a single read/import and stop waits for pending work", async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let reads = 0;
  const f = runtime({ readSource: async () => { reads++; await barrier; return snapshot; } });
  const a = f.collector.sync();
  const b = f.collector.sync();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  release();
  await Promise.all([a, b]);
  await f.collector.stop();
  assert.equal(f.requests.filter(item => item.options.method === "PUT").length, 1);
  await assert.rejects(f.collector.sync(), /stopped/);
});

test("incomplete source reads and stale revisions pause without hiding failure or retrying", async () => {
  for (const failedRead of [true, false]) {
    const f = runtime({
      readSource: async () => {
        if (failedRead) throw Object.assign(new Error("Source has a partial final record"), { name: "SourceError" });
        return snapshot;
      },
      fetchImpl: async (_url, options) => options.method === "GET"
        ? Response.json({ id: runId }) : Response.json({ private: "do not display" }, { status: 409 })
    });
    await assert.rejects(f.collector.start(), failedRead ? /partial final record/ : /HTTP 409/);
    assert.ok(f.collector.lastError);
    assert.equal(f.timer(), undefined);
    assert.doesNotMatch(f.collector.lastError.message, /do not display/);
  }
});

test("foreign sources, changed source identity, and endpoint/trust revocation prevent import", async () => {
  const foreign = runtime({ fetchImpl: async () => Response.json({
    id: runId, usageImports: [{ sourceId: "d".repeat(64), revision }]
  }) });
  await assert.rejects(foreign.collector.sync(), /another session/);
  assert.equal(foreign.reads.length, 0);
  const changed = runtime({ readSource: async () => ({ ...snapshot, sourceId: "e".repeat(64) }) });
  await assert.rejects(changed.collector.sync(), /identity changed/);
  assert.equal(changed.requests.length, 1);
  const revoked = runtime({ ensureAllowed: () => { throw new Error("Trust revoked"); } });
  await assert.rejects(revoked.collector.sync(), /Trust revoked/);
  assert.equal(revoked.reads.length, 0);
  assert.equal(revoked.requests.length, 0);
});

test("invalid or legacy import acknowledgements never claim success", async () => {
  const f = runtime({ fetchImpl: async (_url, options) => options.method === "GET"
    ? Response.json({ id: runId }) : Response.json({ sourceId, revision, importedCount: 2, changed: true }) });
  await assert.rejects(f.collector.sync(), /acknowledgement/);
  assert.equal(f.reports.length, 0);
});

test("text estimates stay separate from measured fields and empty snapshots do not erase evidence", () => {
  const body = importBody({ ...snapshot, observations: [{
    id: "c".repeat(64), quality: "estimated", estimatedInputTokens: 20, estimatedOutputTokens: 5,
    raw: "Do not send this"
  }] }, null);
  assert.equal(body.observations[0].inputTokens, undefined);
  assert.equal(body.observations[0].estimatedInputTokens, 20);
  assert.equal(body.observations[0].raw, undefined);
  assert.throws(() => importBody({ ...snapshot, observations: [] }, null), /No supported usage/);
});

function ui(options = {}) {
  const mock = mockVscode(options);
  const reads = [];
  const requests = [];
  const timers = new Set();
  let opened;
  const sourceApi = {
    async discoverSources() { reads.push("discover"); return [source]; },
    async readSource() { reads.push("source"); return snapshot; },
    async listDatabaseSessions() { reads.push("db"); return []; }
  };
  const fetchImpl = async (url, request) => {
    requests.push({ path: new URL(url).pathname, ...request });
    if (request.method === "GET" && new URL(url).pathname === "/api/runs") return Response.json([]);
    if (request.method === "GET") return Response.json({ id: runId });
    if (new URL(url).pathname.endsWith("/complete")) return new Response(null, { status: 204 });
    if (request.method === "POST") return Response.json({ id: runId });
    return Response.json({ sourceId, revision, importedCount: 1, changed: true });
  };
  registerUsageCollection(mock.vscode, mock.context, {
    sourceApi, fetchImpl, getOrigin: mock.origin, open: async id => { opened = id; },
    schedule: callback => { timers.add(callback); return callback; },
    unschedule: callback => timers.delete(callback)
  });
  const choose = () => {
    mock.answers.information.push("Choose Session", "Start Collection", "Open Recorder");
    mock.answers.pick.push({ mode: "discover" }, { source }, { allow: false }, { create: true });
  };
  return { ...mock, reads, requests, timers, choose, opened: () => opened,
    invoke: action => mock.handlers.get(`flightRecorder.${action}`)() };
}

test("VSIX activation and cancelled consent do not inspect local storage", async () => {
  const f = ui();
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.requests, []);
  await f.invoke("collectUsage");
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.requests, []);
  assert.equal(f.state.size, 0);
});

for (const options of [{ trusted: false }, { remoteName: "ssh-remote" }]) {
  test(`collection respects ${options.remoteName ?? "untrusted"} window boundaries`, async () => {
    const f = ui(options);
    f.choose();
    await f.invoke("collectUsage");
    assert.deepEqual(f.reads, []);
    assert.deepEqual(f.requests, []);
    assert.ok(f.messages.some(item => item.kind === "error"));
  });
}

test("explicit source/run consent starts collection and stop completes only its dedicated run", async () => {
  const f = ui();
  f.choose();
  await f.invoke("collectUsage");
  assert.deepEqual(f.reads, ["discover", "source", "source"]);
  assert.equal(f.timers.size, 1);
  assert.equal(f.opened(), runId);
  assert.equal(f.state.size, 0, "Paths/bindings are not persisted or synced");
  assert.equal(f.requests.find(item => item.method === "PUT").body.includes(source.path), false);
  await f.invoke("stopUsage");
  assert.equal(f.timers.size, 0);
  assert.equal(f.requests.at(-1).path, `/api/runs/${runId}/complete`);
});

test("no run is created before the final mapping confirmation", async () => {
  const f = ui();
  f.answers.information.push("Choose Session");
  f.answers.pick.push({ mode: "discover" }, { source }, { allow: false }, { create: true });
  await f.invoke("collectUsage");
  assert.ok(f.requests.every(item => item.method === "GET"));
  assert.equal(f.timers.size, 0);
});

test("dispose stops polling without completing the run or retaining the local binding", async () => {
  const f = ui();
  f.choose();
  await f.invoke("collectUsage");
  const count = f.requests.length;
  for (const subscription of f.context.subscriptions) subscription.dispose();
  assert.equal(f.timers.size, 0);
  assert.equal(f.requests.length, count);
});

test("stopping during selection cancels future collection without creating a run", async () => {
  const f = ui();
  let answer;
  f.vscode.window.showInformationMessage = () => new Promise(resolve => { answer = resolve; });
  const selecting = f.invoke("collectUsage");
  await new Promise(resolve => setImmediate(resolve));
  const consent = answer;
  const stopping = f.invoke("stopUsage");
  await new Promise(resolve => setImmediate(resolve));
  answer(undefined);
  await stopping;
  consent("Choose Session");
  await selecting;
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.requests, []);
});

test("revoking trust after fetching the run prevents the subsequent session read", async () => {
  let allowed = true;
  const f = runtime({
    ensureAllowed: () => { if (!allowed) throw new Error("Trust revoked"); },
    fetchImpl: async () => { allowed = false; return Response.json({ id: runId }); }
  });
  await assert.rejects(f.collector.sync(), /Trust revoked/);
  assert.equal(f.reads.length, 0);
});
