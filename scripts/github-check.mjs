import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { recorderJson, requireRunId } from "./lib/recorder-client.mjs";

export async function loadCheck(serverUrl, runId, fetchImpl = fetch) {
  const check = await recorderJson(serverUrl, `/api/runs/${requireRunId(runId)}/exports/github`, fetchImpl);
  if (!check || typeof check.name !== "string" || typeof check.output?.summary !== "string" ||
      typeof check.output?.title !== "string" || typeof check.output?.text !== "string") {
    throw new Error("Recorder returned an invalid GitHub check summary.");
  }
  return check;
}

export function checkMarkdown(check) {
  return `${check.output.summary.trim()}\n\n${check.output.text.trim()}\n`;
}

export async function publishCheck(check, { repository, sha, token }, fetchImpl = fetch) {
  if (typeof repository !== "string" || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) {
    throw new Error("Repository must have the form owner/repo.");
  }
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) throw new Error("A full 40-character commit SHA is required.");
  if (!token) throw new Error("Set GITHUB_TOKEN with checks:write permission to publish a check.");
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/check-runs`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: {
      Accept: "application/vnd.github+json", "Content-Type": "application/json",
      Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28"
    },
    body: JSON.stringify({ ...check, head_sha: sha })
  });
  if (!response.ok) throw new Error(`GitHub Checks API returned HTTP ${response.status}. Verify the token's checks:write permission.`);
  return response.json();
}

async function main() {
  const { values } = parseArgs({ options: {
    url: { type: "string", default: process.env.FLIGHTRECORDER_URL ?? "http://localhost:5080" },
    "run-id": { type: "string" },
    repo: { type: "string", default: process.env.GITHUB_REPOSITORY },
    sha: { type: "string", default: process.env.GITHUB_SHA },
    "summary-file": { type: "string", default: process.env.GITHUB_STEP_SUMMARY },
    publish: { type: "boolean", default: false }, help: { type: "boolean", default: false }
  } });
  if (values.help) {
    console.log("Usage: npm run github:summary -- --run-id UUID [--url ORIGIN] [--summary-file PATH] [--publish --repo OWNER/REPO --sha SHA]\nPublishing requires GITHUB_TOKEN with checks:write. Without --publish, no GitHub request is made.");
    return;
  }
  const check = await loadCheck(values.url, values["run-id"]);
  const markdown = checkMarkdown(check);
  if (values["summary-file"]) await appendFile(values["summary-file"], markdown, "utf8");
  else process.stdout.write(markdown);
  if (values.publish) {
    const result = await publishCheck(check, { repository: values.repo, sha: values.sha, token: process.env.GITHUB_TOKEN });
    console.log(`Published Flight Recorder check ${result.id}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}