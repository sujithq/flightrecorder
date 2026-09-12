import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { SharedCopilotRuntime, profiles, discoverCopilotCli } = require("../../extensions/flight-recorder/shared-runtime.cjs");

class ChatRequestTurn { constructor(prompt) { this.prompt = prompt; } }
class ChatResponseTurn { constructor(text) { this.response = [{ value: { value: text } }]; } }
const vscode = { ChatRequestTurn, ChatResponseTurn };

function harness() {
  const calls = [];
  const sessions = [];
  const captures = [];
  let starts = 0;
  let stops = 0;
  let runNumber = 0;
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method: options.method, body });
    if (path === "/api/runs") {
      runNumber++;
      return Response.json({ id: `11111111-1111-4111-8111-00000000000${runNumber}` });
    }
    if (path.endsWith("/events")) return Response.json({ id: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${calls.length}`, taskId: body.taskId }, { status: 201 });
    return new Response(null, { status: 204 });
  };
  const client = {
    async start() { starts++; },
    async stop() { stops++; return []; },
    async createSession(config) {
      const session = {
        config, disconnected: 0, sent: [],
        async sendAndWait(options) {
          this.sent.push(options);
          return { data: { content: `Response ${sessions.length + 1}` } };
        },
        async disconnect() { this.disconnected++; }
      };
      sessions.push(session);
      return session;
    }
  };
  class CopilotClient {
    constructor(options) { this.options = options; return client; }
  }
  const RuntimeConnection = { forStdio: options => ({ kind: "stdio", ...options }) };
  const attachUsage = (session, options) => {
    const capture = { session, options, detached: 0, async detach() { this.detached++; } };
    captures.push(capture);
    return capture;
  };
  const runtime = new SharedCopilotRuntime({
    vscode, getOrigin: () => "http://localhost:5080", fetchImpl,
    getPrices: () => ({ "gpt-test": { currency: "USD", source: "Synthetic" } }),
    findCli: async () => "C:\\tools\\copilot.exe",
    loadSdk: async () => ({ CopilotClient, RuntimeConnection }), attachUsage
  });
  return { runtime, calls, sessions, captures, counts: () => ({ starts, stops }) };
}

test("multiple participants share one client but isolate sessions, runs, tasks, and instructions", async () => {
  const { runtime, calls, sessions, captures, counts } = harness();
  const outputs = [];
  const stream = { markdown: value => outputs.push(value) };
  const cancellation = { onCancellationRequested: () => ({ dispose() {} }) };
  const context = { history: [new ChatRequestTurn("Earlier"), new ChatResponseTurn("Previous answer")] };

  const first = await runtime.handle("flightRecorder.chat", { prompt: "Question", model: { family: "gpt-test" } }, context, stream, cancellation);
  const second = await runtime.handle("flightRecorder.review", { prompt: "Review this", model: { family: "gpt-test" } }, { history: [] }, stream, cancellation);

  assert.equal(counts().starts, 1);
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0], sessions[1]);
  assert.equal(sessions[0].config.model, "gpt-test");
  assert.match(sessions[0].config.systemMessage.content, /Answer accurately/);
  assert.match(sessions[1].config.systemMessage.content, /Lead with concrete findings/);
  assert.deepEqual(sessions.map(session => session.disconnected), [1, 1]);
  assert.match(sessions[0].sent[0].prompt, /User: Earlier[\s\S]*Assistant: Previous answer[\s\S]*User: Question/);
  assert.deepEqual(outputs, ["Response 2", "Response 3"]);
  assert.equal(captures.length, 2);
  assert.equal(captures.every(capture => capture.options.transport === "otlp" && capture.detached === 1), true);
  assert.equal(captures.every(capture => capture.options.prices["gpt-test"].source === "Synthetic"), true);
  assert.notEqual(captures[0].options.runId, captures[1].options.runId);
  assert.equal(calls.filter(call => call.path === "/api/runs").length, 2);
  assert.equal(calls.filter(call => call.path.endsWith("/complete")).length, 2);
  assert.match(first.metadata.flightRecorderRunId, /^[0-9a-f-]{36}$/);
  assert.match(second.metadata.flightRecorderRunId, /^[0-9a-f-]{36}$/);

  await runtime.dispose();
  assert.equal(counts().stops, 1);
});

test("participant profiles are fixed and runtime rejects unknown participants", async () => {
  const { runtime } = harness();
  assert.deepEqual(Object.keys(profiles), ["flightRecorder.chat", "flightRecorder.review"]);
  await assert.rejects(runtime.handle("unknown", {}, {}, {}, {}), /Unknown/);
  await runtime.dispose();
});

test("Copilot discovery returns a usable command path from platform lookup output", async () => {
  const lines = process.platform === "win32"
    ? "C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\copilot.exe\r\nC:\\tools\\copilot.exe\r\n"
    : "/usr/local/bin/copilot\n";
  const selected = await discoverCopilotCli(async () => ({ stdout: lines }));
  assert.equal(selected, process.platform === "win32" ? "C:\\tools\\copilot.exe" : "/usr/local/bin/copilot");
});