import assert from "node:assert/strict";
import { test } from "node:test";
import {
  statusName, eventTypeName, recordingModeName, escapeHtml, durationMs,
  formatDuration, formatNumber, formatCost, formatUsage, reportedTokens, estimatedTokens, importQualityCounts, formatCredits,
  usageComplete, usageLabel, recorderVersionLabel, eventDepth, timelineBounds
} from "../../src/FlightRecorder.Web/model.js";

test("API enums accept numeric values and known string names only", () => {
  assert.equal(statusName(3), "Blocked");
  assert.equal(statusName(4), "RequiresApproval");
  assert.equal(statusName("Succeeded"), "Succeeded");
  assert.equal(statusName("<script>"), "Unknown");
  assert.equal(eventTypeName(4), "PolicyDecision");
  assert.equal(recordingModeName(0), "MetadataOnly");
  assert.equal(eventTypeName(99), "Unknown");
});

test("viewer version labels require actual runtime metadata, never a guessed extension version", () => {
  assert.equal(recorderVersionLabel({ version: "1.0.0" }), "Recorder v1.0.0");
  assert.equal(recorderVersionLabel({ version: "1.1.0-rc.1+abc" }), "Recorder v1.1.0-rc.1+abc");
  assert.equal(recorderVersionLabel({ version: null }), "Development build");
  for (const info of [null, {}, { version: 1 }, { version: "" }, { version: "<script>" },
    { version: "v1.0.0" }, { version: "01.0.0" }, { version: `1.0.0+${"a".repeat(70)}` }]) {
    assert.throws(() => recorderVersionLabel(info), /metadata is invalid/);
  }
});

test("trace content is escaped in text and attribute contexts", () => {
  assert.equal(escapeHtml('<img src="x" onerror=\'alert(1)\'>&'),
    "&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;&amp;");
  assert.equal(escapeHtml(null), "");
});

test("duration uses timestamps including live runs and rejects invalid or negative intervals", () => {
  const startedAt = "2026-09-06T12:00:00.1234567+00:00";
  assert.equal(durationMs({ startedAt, endedAt: "2026-09-06T12:00:02.6234567+00:00" }), 2500);
  assert.equal(durationMs({ startedAt }, Date.parse(startedAt) + 500), 500);
  assert.equal(durationMs({ startedAt }, Date.parse(startedAt) - 500), 0);
  assert.equal(durationMs({ startedAt: "invalid" }), 0);
  assert.equal(durationMs({ startedAt, importedUsage: { timestampMeaning: "observed" } }, Date.parse(startedAt) + 500), 0);
});

test("metrics have stable units", () => {
  assert.equal(formatDuration(420), "420 ms");
  assert.equal(formatDuration(14700), "14.70 s");
  assert.equal(formatDuration(125000), "2m 5s");
  assert.equal(formatDuration(NaN), "0 ms");
  assert.equal(formatNumber(12500), "12,500");
  assert.equal(formatCost(0.0321), "$0.0321");
});

test("missing usage is not reported while measured zero remains numeric", () => {
  for (const value of [undefined, null, NaN, "0"]) {
    assert.equal(formatUsage(value), "Not reported");
    assert.equal(formatCost(value), "Not reported");
  }
  assert.equal(formatUsage(0), "0");
  assert.equal(formatCost(0), "$0.0000");
  assert.equal(formatCost(0.00001), "<$0.0001");
  assert.equal(formatCost(0.0001), "$0.0001");
  assert.equal(reportedTokens({ inputTokens: null, outputTokens: null }), null);
  assert.equal(reportedTokens({ inputTokens: 10, outputTokens: null }), 10);
  assert.equal(reportedTokens({ inputTokens: 0, outputTokens: 0 }), 0);
});

test("usage totals identify partial data and permit comparisons only with complete reporting", () => {
  const absent = { inputTokens: null, outputTokens: null, estimatedCost: null };
  assert.equal(usageLabel(absent, "tokens"), "Not reported");
  assert.equal(usageLabel(absent, "cost"), "Not reported");
  const partial = { inputTokens: 20, outputTokens: null, estimatedCost: 0, usage: { tokensComplete: false, costComplete: false } };
  assert.equal(usageLabel(partial, "tokens"), "20 (partial)");
  assert.equal(usageLabel(partial, "cost"), "$0.0000 (partial)");
  assert.equal(usageComplete(partial, "tokens"), false);
  const complete = { inputTokens: 0, outputTokens: 0, estimatedCost: 0, usage: { tokensComplete: true, costComplete: true } };
  assert.equal(usageLabel(complete, "tokens"), "0");
  assert.equal(usageLabel(complete, "cost"), "$0.0000");
  assert.equal(usageComplete(complete, "tokens"), true);
  assert.equal(usageComplete(complete, "cost"), true);
});

test("imported estimates and billing credits remain separate from measured usage", () => {
  const metrics = { inputTokens: 100, outputTokens: 20, estimatedInputTokens: 10, estimatedOutputTokens: 4, copilotCredits: 0.25 };
  assert.equal(reportedTokens(metrics), 120);
  assert.equal(estimatedTokens(metrics), 14);
  assert.equal(estimatedTokens({}), null);
  assert.equal(estimatedTokens({ estimatedInputTokens: 0 }), 0);
  assert.equal(formatCredits(null), "Not reported");
  assert.equal(formatCredits(0), "0");
  assert.equal(formatCredits(0.25), "0.25");
  assert.equal(formatCredits(0.00001), "<0.0001");
  assert.deepEqual(importQualityCounts([
    {}, { importedUsage: { quality: "measured" } }, { importedUsage: { quality: "estimated" } },
    { importedUsage: { quality: "unavailable" } }, { importedUsage: { quality: "__proto__" } }
  ]), { measured: 1, estimated: 1, unavailable: 1 });
});

test("hierarchy follows recorded parents and terminates for orphaned or cyclic data", () => {
  const root = { id: "root" };
  const agent = { id: "agent", parentEventId: "root" };
  const tool = { id: "tool", parentEventId: "agent" };
  assert.equal(eventDepth(tool, [root, agent, tool]), 2);
  assert.equal(eventDepth(tool, [tool]), 0);
  assert.equal(eventDepth(tool, [tool, { ...agent, parentEventId: "tool" }]), 1);
});

test("waterfall includes event bounds even when the run end precedes them", () => {
  const bounds = timelineBounds({
    startedAt: "2026-09-06T12:00:01Z", endedAt: "2026-09-06T12:00:02Z",
    events: [{ startedAt: "2026-09-06T12:00:00Z", endedAt: "2026-09-06T12:00:03Z" }]
  });
  assert.equal(bounds.duration, 3000);
});