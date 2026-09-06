import assert from "node:assert/strict";
import { test } from "node:test";
import { badgeFrame, BadgeRelay } from "../../scripts/lib/badge-protocol.mjs";

const summary = {
  version: 1, runId: "11111111-2222-3333-4444-555555555555",
  agent: "coding-agent", status: "Blocked", eventCount: 11, tokens: 6990,
  durationSeconds: 14.7, estimatedCost: 0.0164, alert: "Create pull request"
};

test("badge frames contain only the compact allowlisted summary and one newline", () => {
  const frame = badgeFrame({ ...summary, input: "must not leave recorder", output: "private", attributes: { private: "value" } });
  assert.deepEqual(JSON.parse(frame), summary);
  assert.ok(frame.endsWith("\n"));
  assert.equal(frame.split("\n").length, 2);
  assert.ok(Buffer.byteLength(frame) <= 1024);
});

test("display text is ASCII, bounded and cannot inject additional serial frames", () => {
  const frame = badgeFrame({ ...summary, agent: 'A\n\u0003"'.repeat(40), alert: "B".repeat(100) });
  const decoded = JSON.parse(frame);
  assert.equal(decoded.agent.length, 28);
  assert.equal(decoded.alert.length, 64);
  assert.ok(!frame.includes("\u0003"));
  assert.ok(!decoded.agent.includes("\n"));
});

test("unknown protocols, states, identifiers and invalid metrics are rejected", () => {
  for (const patch of [{ version: 2 }, { status: "Unsupported" }, { runId: "not-a-run" },
    { tokens: -1 }, { tokens: 1.5 }, { estimatedCost: NaN }, { durationSeconds: Infinity }, { eventCount: "11" }]) {
    assert.throws(() => badgeFrame({ ...summary, ...patch }));
  }
});

test("relay ignores absent and unchanged data but forwards new outcomes", async () => {
  const frames = [];
  const relay = new BadgeRelay(async frame => frames.push(frame));
  assert.equal(await relay.send(null), false);
  assert.equal(await relay.send(summary), true);
  assert.equal(await relay.send(summary), false);
  assert.equal(await relay.send({ ...summary, status: "Succeeded", alert: null }), true);
  assert.equal(frames.length, 2);
});

test("failed writes are retried instead of being marked as delivered", async () => {
  let calls = 0;
  const relay = new BadgeRelay(async () => {
    calls += 1;
    if (calls === 1) throw new Error("USB disconnected");
  });
  await assert.rejects(relay.send(summary), /USB disconnected/);
  assert.equal(await relay.send(summary), true);
  assert.equal(calls, 2);
});