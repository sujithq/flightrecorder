import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { readSource } = require("../../extensions/flight-recorder/usage-sources.cjs");
const { UsageCollection } = require("../../extensions/flight-recorder/usage-collector.cjs");

async function startRun(request) {
  const response = await request.post("/api/runs", { data: {
    request: "Synthetic persisted usage acceptance", entryPointAgent: "collector-test",
    requestingIdentity: "test", recordingMode: 1
  } });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test("local Chat snapshots import once, update measurements and expose provenance without transcript text", async ({ request, page, baseURL }) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "recorder-chat-acceptance-")));
  const file = join(directory, "session.json");
  const source = { kind: "vscode-chat", path: file };
  const content = input => ({ requests: [{
    requestId: "synthetic-request-1", modelId: "test-model",
    message: { text: "PRIVATE_SYNTHETIC_PROMPT" },
    response: [{ kind: "markdownContent", content: { value: "PRIVATE_SYNTHETIC_RESPONSE" } }],
    result: { usage: { promptTokens: input, completionTokens: 5 } }
  }] });
  let collector;
  try {
    await writeFile(file, JSON.stringify(content(20)));
    const snapshot = await readSource(source);
    const run = await startRun(request);
    collector = new UsageCollection({
      source, sourceId: snapshot.sourceId, runId: run.id, origin: baseURL, readSource
    });
    const first = await collector.sync();
    expect(first.changed).toBe(true);
    expect((await collector.sync()).changed).toBe(false);
    let trace = await (await request.get(`/api/runs/${run.id}`)).json();
    expect(trace.events).toHaveLength(1);
    const id = trace.events[0].id;
    expect(trace.inputTokens).toBe(20);
    expect(trace.outputTokens).toBe(5);
    expect(JSON.stringify(trace)).not.toContain("PRIVATE_SYNTHETIC");
    expect(JSON.stringify(trace)).not.toContain(directory);
    await writeFile(file, JSON.stringify(content(24)));
    expect((await collector.sync()).changed).toBe(true);
    trace = await (await request.get(`/api/runs/${run.id}`)).json();
    expect(trace.events).toHaveLength(1);
    expect(trace.events[0].id).toBe(id);
    expect(trace.inputTokens).toBe(24);
    await page.goto(`/?run=${run.id}`);
    await expect(page.locator(".import-summary")).toContainText("1 measured");
    await page.locator(".timeline-row").first().click();
    await expect(page.locator(".usage-provenance")).toContainText("vscode-chat");
    await expect(page.locator(".usage-provenance")).toContainText("measured");
    await expect(page.locator("#run-overview .metric").filter({ hasText: "Reported tokens" }).locator("strong")).toHaveText("29");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  } finally {
    await collector?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unavailable session usage does not become measured zero, even after opting into text estimates", async ({ request, page, baseURL }) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "recorder-estimate-acceptance-")));
  const file = join(directory, "session.json");
  const source = { kind: "vscode-chat", path: file };
  const content = { requests: [{
    requestId: "synthetic-request-2", modelId: "test-model",
    message: { text: "A short synthetic prompt" },
    response: [{ kind: "markdownContent", value: "A short synthetic response" }]
  }] };
  let collector;
  try {
    await writeFile(file, JSON.stringify(content));
    const initial = await readSource(source, { allowEstimates: false });
    const run = await startRun(request);
    collector = new UsageCollection({
      source, sourceId: initial.sourceId, runId: run.id, origin: baseURL, readSource
    });
    await collector.sync();
    let trace = await (await request.get(`/api/runs/${run.id}`)).json();
    expect(trace.inputTokens).toBeNull();
    expect(trace.estimatedInputTokens).toBeNull();
    await collector.stop();
    collector = new UsageCollection({
      source, sourceId: initial.sourceId, runId: run.id, origin: baseURL, readSource, allowEstimates: true
    });
    await collector.sync();
    trace = await (await request.get(`/api/runs/${run.id}`)).json();
    expect(trace.inputTokens).toBeNull();
    expect(trace.estimatedInputTokens).toBeGreaterThan(0);
    expect(trace.estimatedCost).toBeNull();
    await page.goto(`/?run=${run.id}`);
    await expect(page.locator(".import-summary")).toContainText("1 estimated");
    await expect(page.locator("#run-overview .metric").filter({ hasText: "Reported tokens" }).locator("strong")).toHaveText("Not reported");
    await expect(page.locator("#run-overview .metric").filter({ hasText: "Text estimate (tokens)" }).locator("strong")).not.toHaveText("Not reported");
  } finally {
    await collector?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI database billing usage remains separate from API cost estimates in the viewer", async ({ request, page, baseURL }) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = require("node:sqlite")); }
  catch (error) {
    if (error.code !== "ERR_UNKNOWN_BUILTIN_MODULE") throw error;
  }
  test.skip(!DatabaseSync, "Extension host/runner does not provide built-in SQLite.");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "recorder-cli-acceptance-")));
  const file = join(directory, "session-store.db");
  const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const source = { kind: "copilot-cli", path: file, sessionId };
  let collector;
  try {
    const database = new DatabaseSync(file);
    try {
      database.exec("CREATE TABLE assistant_usage_events (session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, total_nano_aiu INTEGER)");
      database.prepare("INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?, ?, ?, ?)").run(sessionId, "test-model", 100, 25, 10, 0, 1000000000);
    } finally { database.close(); }
    const snapshot = await readSource(source);
    const run = await startRun(request);
    collector = new UsageCollection({
      source, sourceId: snapshot.sourceId, runId: run.id, origin: baseURL, readSource
    });
    await collector.sync();
    expect((await collector.sync()).changed).toBe(false);
    const trace = await (await request.get(`/api/runs/${run.id}`)).json();
    expect(trace.inputTokens).toBe(100);
    expect(trace.copilotCredits).toBe(1);
    expect(trace.copilotUsageValueUsd).toBe(0.01);
    expect(trace.estimatedCost).toBeNull();
    await page.goto(`/?run=${run.id}`);
    await expect(page.locator("#run-overview .metric").filter({ hasText: "Reported Copilot credits" }).locator("strong")).toHaveText("1");
    await expect(page.locator("#run-overview .metric").filter({ hasText: "Credit-equivalent USD" }).locator("strong")).toHaveText("$0.0100");
    await expect(page.locator(".import-summary")).toContainText("not your invoice");
  } finally {
    await collector?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
