import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect } from "@playwright/test";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

test("Docker preserves acknowledged traces across crash, recreation and configurable retention", { timeout: 180000 }, async context => {
  const project = `flightrecorder-test-${randomUUID().slice(0, 8)}`;
  let limit = "10";
  let origin;
  const docker = async (...args) => (await execute("docker", args, {
    cwd: root, env: { ...process.env, FLIGHTRECORDER_MAX_COMPLETED_RUNS: limit },
    timeout: 60000, maxBuffer: 1024 * 1024
  })).stdout.trim();
  const compose = (...args) => docker("compose", "--project-name", project,
    "--file", "compose.yaml", "--file", "tests/containers/compose.persistence.yaml", ...args);
  context.after(async () => { await compose("down", "--volumes", "--remove-orphans"); });

  async function ready() {
    await expect.poll(async () => {
      try {
        const address = (await compose("port", "recorder", "8080")).split(/\r?\n/)[0];
        if (!/^127\.0\.0\.1:\d+$/.test(address)) return 0;
        origin = `http://${address}`;
        return (await fetch(`${origin}/api/runs`, { signal: AbortSignal.timeout(1500) })).status;
      }
      catch { return 0; }
    }, { timeout: 20000, intervals: [100, 250, 500] }).toBe(200);
  }

  async function api(path, body) {
    const response = await fetch(`${origin}/api/${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
    assert.ok(response.ok, `${path}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  }

  async function start() {
    return api("runs", {
      request: "Synthetic persistence acceptance trace", entryPointAgent: "test-agent",
      requestingIdentity: "test-identity", recordingMode: 1
    });
  }

  async function mcpTrace(runId) {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST", headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-11-25"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "get_flight_trace", arguments: { runId } } }),
      signal: AbortSignal.timeout(15000)
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    const payload = response.headers.get("content-type")?.includes("text/event-stream")
      ? body.split("\n").find(line => line.startsWith("data:")).slice(5) : body;
    const message = JSON.parse(payload);
    assert.ok(message.result);
    assert.notEqual(message.result.isError, true);
    assert.ok(JSON.stringify(message.result).includes(runId));
  }

  await compose("up", "--detach", "--no-build", "--wait", "--wait-timeout", "30");
  await ready();
  assert.notEqual(await compose("exec", "--no-TTY", "recorder", "id", "-u"), "0");
  assert.equal(await compose("exec", "--no-TTY", "recorder", "stat", "-c", "%a", "/data"), "700");
  const unfinished = [await start(), await start(), await start()];
  const runId = unfinished[0].id;
  const parent = await api(`runs/${runId}/events`, { name: "Parent", type: 1, identity: "parent-identity" });
  await api(`runs/${runId}/events`, {
    name: "Interrupted action", type: 3, parentEventId: parent.id, status: 3,
    model: "synthetic-model", outputTokens: 0, costBasis: "Synthetic USD test pricing.",
    identity: "child-identity", inputTokens: 23, estimatedCost: 0.0123, input: "token=synthetic-private-value"
  });
  const completed = [];
  for (let index = 0; index < 12; index++) {
    const run = await start();
    await api(`runs/${run.id}/complete`, {});
    completed.push(run.id);
  }
  assert.equal((await api("runs")).length, 13);
  let snapshot = await api(`runs/${runId}`);
  const graph = await api(`runs/${runId}/graph`);
  assert.ok(!JSON.stringify(snapshot).includes("synthetic-private-value"));
  const containerId = await compose("ps", "--quiet", "recorder");
  const restartCount = () => docker("inspect", "--format", "{{.RestartCount}}", containerId).then(Number);
  const beforeRestart = await restartCount();
  assert.equal(await docker("inspect", "--format", "{{.HostConfig.RestartPolicy.Name}}", containerId), "unless-stopped");

  await compose("exec", "--no-TTY", "recorder", "/bin/sh", "-c",
    'set -- $(cat /proc/1/task/1/children); [ "$#" -eq 1 ] && kill -KILL "$1"');
  await expect.poll(restartCount, { timeout: 20000, intervals: [100, 250, 500] }).toBeGreaterThan(beforeRestart);
  await ready();
  assert.deepEqual(await api(`runs/${runId}`), snapshot);
  assert.deepEqual(await api(`runs/${runId}/graph`), graph);
  await mcpTrace(runId);
  context.diagnostic("Acknowledged events, IDs, hierarchy and privacy survived SIGKILL and automatic restart.");

  await api(`runs/${runId}/events`, { name: "Resumed action", type: 3, parentEventId: parent.id });
  snapshot = await api(`runs/${runId}`);
  assert.equal(snapshot.endedAt, null);
  await compose("up", "--detach", "--no-build", "--force-recreate", "--wait", "--wait-timeout", "30");
  await ready();
  assert.deepEqual(await api(`runs/${runId}`), snapshot);
  context.diagnostic("The same named volume preserved the resumed trace through container recreation.");

  limit = "3";
  await compose("up", "--detach", "--no-build", "--force-recreate", "--wait", "--wait-timeout", "30");
  await ready();
  const retained = await api("runs");
  assert.equal(retained.length, 6);
  assert.equal(retained.filter(run => run.endedAt !== null).length, 3);
  for (const run of unfinished) assert.ok(retained.some(retainedRun => retainedRun.id === run.id));
  for (const id of completed.slice(-3)) assert.ok(retained.some(run => run.id === id));
  const expired = await fetch(`${origin}/api/runs/${completed[0]}`);
  assert.equal(expired.status, 404);

  await compose("down");
  await compose("up", "--detach", "--no-build", "--wait", "--wait-timeout", "30");
  await ready();
  assert.deepEqual(await api(`runs/${runId}`), snapshot);
  assert.equal((await api("runs")).length, 6);
  await mcpTrace(runId);
  context.diagnostic("Retention=3 keeps three completed plus every unfinished run after down/up without deleting the volume.");
});