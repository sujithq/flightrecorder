import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const runId = "11111111-2222-3333-4444-555555555555";

async function runCli(script, args, response, environmentUrl) {
  const env = { ...process.env };
  delete env.FLIGHTRECORDER_URL;
  delete env.GITHUB_STEP_SUMMARY;
  delete env.GITHUB_TOKEN;
  delete env.GITHUB_REPOSITORY;
  delete env.GITHUB_SHA;
  if (environmentUrl) env.FLIGHTRECORDER_URL = environmentUrl;
  const hook = `globalThis.fetch = async (url, options) => {
    if (options.method && options.method !== "GET") throw new Error("Unexpected write request");
    process.stderr.write(new URL(url).href + "\\n");
    return Response.json(${JSON.stringify(response)});
  };`;
  return execute(process.execPath, ["--import", `data:text/javascript;base64,${Buffer.from(hook).toString("base64")}`,
    script, ...args], { cwd: root, env, timeout: 15000 });
}

const clients = [
  {
    name: "GitHub summary", script: "scripts/github-check.mjs", args: ["--run-id", runId],
    path: `/api/runs/${runId}/exports/github`,
    response: { name: "Agent Flight Recorder", output: { title: "Synthetic run", summary: "Synthetic summary", text: "Synthetic evidence" } }
  },
  {
    name: "Badger bridge", script: "scripts/badger-bridge.mjs", args: ["--stdout"], path: "/api/badger/latest",
    response: { version: 1, runId, agent: "test-agent", status: "Succeeded", eventCount: 1,
      tokens: 0, durationSeconds: 1, estimatedCost: 0, alert: null }
  }
];

for (const client of clients) {
  test(`${client.name} defaults to Docker port 5080`, async () => {
    const result = await runCli(client.script, client.args, client.response);
    assert.equal(result.stderr.trim(), `http://localhost:5080${client.path}`);
    assert.ok(result.stdout.trim());
  });

  test(`${client.name} honors an explicit native-server environment override`, async () => {
    const result = await runCli(client.script, client.args, client.response, "http://localhost:5205");
    assert.equal(result.stderr.trim(), `http://localhost:5205${client.path}`);
  });

  test(`${client.name} command-line URL overrides the environment`, async () => {
    const result = await runCli(client.script, [...client.args, "--url", "http://127.0.0.1:6200"],
      client.response, "http://localhost:5205");
    assert.equal(result.stderr.trim(), `http://127.0.0.1:6200${client.path}`);
  });
}