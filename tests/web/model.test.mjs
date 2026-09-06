import assert from "node:assert/strict";
import { test } from "node:test";
import {
  statusName, eventTypeName, recordingModeName, escapeHtml, durationMs,
  formatDuration, formatNumber, formatCost, eventDepth, timelineBounds
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
});

test("metrics have stable units", () => {
  assert.equal(formatDuration(420), "420 ms");
  assert.equal(formatDuration(14700), "14.70 s");
  assert.equal(formatDuration(125000), "2m 5s");
  assert.equal(formatDuration(NaN), "0 ms");
  assert.equal(formatNumber(12500), "12,500");
  assert.equal(formatCost(0.0321), "$0.0321");
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