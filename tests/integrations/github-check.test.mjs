import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCheck, checkMarkdown, publishCheck } from "../../scripts/github-check.mjs";
import { recorderOrigin, recorderJson } from "../../scripts/lib/recorder-client.mjs";

const runId = "11111111-2222-3333-4444-555555555555";
const sha = "a".repeat(40);
const check = {
  name: "Agent Flight Recorder", status: "completed", conclusion: "action_required",
  external_id: runId,
  output: { title: "Agent run: Blocked", summary: "## Blocked run\n", text: "- Evidence: policy approval denied\n" }
};

test("summary retrieval is read-only and sends no GitHub credentials to the recorder", async () => {
  const loaded = await loadCheck("http://localhost:5205", runId, async (url, options) => {
    assert.equal(url.href, `http://localhost:5205/api/runs/${runId}/exports/github`);
    assert.equal(options.redirect, "error");
    assert.equal(options.headers, undefined);
    assert.equal(options.method, undefined);
    return Response.json(check);
  });
  assert.equal(checkMarkdown(loaded), "## Blocked run\n\n- Evidence: policy approval denied\n");
});

test("publishing attaches the SHA to the intended Checks endpoint without changing policy outcome", async () => {
  const result = await publishCheck(check, { repository: "example/recorder", sha, token: "synthetic-test-value" }, async (url, options) => {
    assert.equal(url, "https://api.github.com/repos/example/recorder/check-runs");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer synthetic-test-value");
    const payload = JSON.parse(options.body);
    assert.equal(payload.head_sha, sha);
    assert.equal(payload.conclusion, "action_required");
    assert.deepEqual(payload.output, check.output);
    return Response.json({ id: 42 });
  });
  assert.equal(result.id, 42);
  assert.equal(check.head_sha, undefined);
});

test("invalid targets and missing credentials fail before any publish request", async () => {
  const noFetch = () => assert.fail("No network request should be sent");
  await assert.rejects(publishCheck(check, { repository: "../other/path", sha, token: "test" }, noFetch), /owner\/repo/);
  await assert.rejects(publishCheck(check, { repository: "example/recorder", sha: "main", token: "test" }, noFetch), /commit SHA/);
  await assert.rejects(publishCheck(check, { repository: "example/recorder", sha }, noFetch), /GITHUB_TOKEN/);
  await assert.rejects(loadCheck("http://localhost:5205", "../other", noFetch), /UUID/);
});

test("recorder URL and redirects cannot route requests outside the approved origin", async () => {
  for (const url of ["http://remote.example", "https://user:test@example.com", "https://example.com/?token=test"]) {
    assert.throws(() => recorderOrigin(url));
  }
  assert.equal(recorderOrigin("https://recorder.example").origin, "https://recorder.example");
  await assert.rejects(recorderJson("http://localhost:5205", "https://other.example/api/runs"), /Invalid recorder/);
});

test("HTTP errors are actionable without echoing upstream response bodies", async () => {
  await assert.rejects(loadCheck("http://localhost:5205", runId, async () => new Response("private details", { status: 404 })), /HTTP 404/);
  await assert.rejects(publishCheck(check, { repository: "example/recorder", sha, token: "test" }, async () => new Response("private details", { status: 403 })), /HTTP 403/);
  await assert.rejects(loadCheck("http://localhost:5205", runId, async () => Response.json({})), /invalid GitHub check/);
});