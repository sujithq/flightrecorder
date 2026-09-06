import assert from "node:assert/strict";
import { test } from "node:test";
import { badgeFrame, BadgeRelay } from "../../scripts/lib/badge-protocol.mjs";

const summary = {
  version: 1, runId: "11111111-2222-3333-4444-555555555555",
  agent: "coding-agent", status: "Blocked", eventCount: 11, tokens: 6990,
  durationSeconds: 14.7, estimatedCost: 0.0164, alert: "Create pull request"
};

test("badge frames contain only the compact allowlisted summary and one newline", () => {
  for (const expected of [summary, { ...summary, version: 2, tokens: null, estimatedCost: null }]) {
    const frame = badgeFrame({ ...expected, input: "must not leave recorder", output: "private", attributes: { private: "value" } });
    assert.deepEqual(JSON.parse(frame), expected);
    assert.ok(frame.endsWith("\n"));
    assert.equal(frame.split("\n").length, 2);
    assert.ok(Buffer.byteLength(frame) <= 1024);
  }
});

test("display text is ASCII, bounded and cannot inject additional serial frames", () => {
  for (const version of [1, 2]) {
    const frame = badgeFrame({ ...summary, version, agent: 'A\n\u0003"'.repeat(40), alert: "B".repeat(100) });
    const decoded = JSON.parse(frame);
    assert.equal(decoded.agent.length, 28);
    assert.equal(decoded.alert.length, 64);
    assert.ok(!frame.includes("\u0003"));
    assert.ok(!decoded.agent.includes("\n"));
  }
});

test("unknown protocols, states and identifiers are rejected", () => {
  for (const patch of [{ version: 0 }, { version: 3 }, { version: "2" }, { version: true },
    { version: null }, { version: undefined }, { status: "Unsupported" }, { runId: "not-a-run" }]) {
    assert.throws(() => badgeFrame({ ...summary, ...patch }));
  }
});

test("both protocol versions preserve reported zero, positive and boundary metrics", () => {
  for (const version of [1, 2]) {
    for (const metrics of [
      { eventCount: 0, tokens: 0, durationSeconds: 0, estimatedCost: 0 },
      { eventCount: 11, tokens: 6990, durationSeconds: 14.7, estimatedCost: 0.0164 },
      { eventCount: Number.MAX_SAFE_INTEGER, tokens: Number.MAX_SAFE_INTEGER, durationSeconds: Number.MAX_SAFE_INTEGER, estimatedCost: Number.MAX_SAFE_INTEGER }
    ]) {
      const expected = { ...summary, version, ...metrics };
      assert.deepEqual(JSON.parse(badgeFrame(expected)), expected);
    }
  }
});

test("only version 2 permits explicit null usage metrics independently", () => {
  for (const usage of [{ tokens: null }, { estimatedCost: null }, { tokens: null, estimatedCost: null }]) {
    const expected = { ...summary, version: 2, ...usage };
    assert.deepEqual(JSON.parse(badgeFrame(expected)), expected);
    assert.throws(() => badgeFrame({ ...summary, ...usage }), /Invalid badge metric/);
  }
});

test("all metrics must be present and valid without coercion in both versions", () => {
  for (const version of [1, 2]) {
    for (const field of ["eventCount", "tokens", "durationSeconds", "estimatedCost"]) {
      for (const value of [-1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, true, false, "0", "", undefined]) {
        assert.throws(() => badgeFrame({ ...summary, version, [field]: value }), /Invalid badge metric/,
          `version ${version}, ${field}=${String(value)}`);
      }
      const missing = { ...summary, version };
      delete missing[field];
      assert.throws(() => badgeFrame(missing), /Invalid badge metric/);
      if (version === 1 || field === "eventCount" || field === "durationSeconds") {
        assert.throws(() => badgeFrame({ ...summary, version, [field]: null }), /Invalid badge metric/);
      }
    }
    for (const field of ["eventCount", "tokens"]) {
      assert.throws(() => badgeFrame({ ...summary, version, [field]: 1.5 }), /Invalid badge metric/);
    }
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

test("relay preserves version upgrades and transitions between unknown, zero and known usage", async () => {
  const frames = [];
  const relay = new BadgeRelay(async frame => frames.push(JSON.parse(frame)));
  const expected = [
    { ...summary, tokens: 0, estimatedCost: 0 },
    { ...summary, version: 2, tokens: 0, estimatedCost: 0 },
    { ...summary, version: 2, tokens: null, estimatedCost: null },
    { ...summary, version: 2, tokens: 0, estimatedCost: 0 },
    { ...summary, version: 2 }
  ];
  for (const value of expected) {
    assert.equal(await relay.send(value), true);
    assert.equal(await relay.send(value), false);
  }
  assert.deepEqual(frames, expected);
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