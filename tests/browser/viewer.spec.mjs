import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { attachCopilotUsage } from "../../integrations/copilot-sdk/usage.mjs";

test("trace workflow exposes graph links, policy evidence, comparison and exports", async ({ page, request }, testInfo) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const blockedResponse = await request.post("/api/demo/runs", { data: { scenario: "blocked" } });
  expect(blockedResponse.ok()).toBeTruthy();
  const blocked = await blockedResponse.json();
  const approvedResponse = await request.post("/api/demo/runs", { data: { scenario: "approved" } });
  const approved = await approvedResponse.json();
  await page.goto(`/?run=${blocked.id}`);
  await expect(page.locator(".timeline-row")).toHaveCount(blocked.events.length);
  await expect(page.getByRole("heading", { name: "Demo: Repair failed deployment" })).toBeVisible();
  await page.getByRole("tab", { name: "Agent graph" }).click();
  await expect(page.locator(".graph-node")).toHaveCount(blocked.events.length + 1);
  await page.locator(".graph-node").filter({ hasText: "Prepare fix" }).click();
  await expect(page.getByRole("complementary", { name: "Decision evidence" })).toContainText("agent-dev-042");
  await page.locator(".graph-edge").filter({ has: page.locator(".edge-line") }).first().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#inspector")).toContainText("Hand-off evidence");
  const graphFits = await page.locator(".graph-scroll").evaluate(container => container.scrollWidth <= container.clientWidth + 1);
  expect(graphFits).toBeTruthy();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("graph.png"), fullPage: true, scale: "css" });
  await page.getByRole("tab", { name: "Policies", exact: true }).click();
  await page.locator(".policy-row").click();
  await expect(page.locator("#inspector")).toContainText("pull_requests:write");
  await expect(page.locator("#inspector")).toContainText("No repository changes were published");
  await page.getByRole("button", { name: "Close inspector" }).click();
  await page.getByRole("button", { name: "Explain run" }).click();
  await expect(page.locator("#analysis")).toBeVisible();
  await page.locator(".evidence-link").first().click();
  await expect(page.locator("#inspector")).toBeVisible();
  await page.getByRole("button", { name: "Close diagnosis" }).click();
  await page.getByRole("button", { name: "Close inspector" }).click();
  await page.getByRole("tab", { name: "Compare", exact: true }).click();
  await page.getByLabel("Baseline run").selectOption(approved.id);
  await expect(page.locator(".comparison-row")).toHaveCount(blocked.events.length);
  await page.getByLabel("Filter event changes").selectOption("changed");
  await expect(page.locator(".comparison-row").filter({ hasText: "Repository write approval" })).toBeVisible();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("comparison.png"), fullPage: true, scale: "css" });
  await page.getByRole("tab", { name: "Timeline", exact: true }).click();
  await page.getByRole("button", { name: "Next event" }).click();
  await expect(page.locator(".timeline-row.selected")).toHaveCount(1);
  await page.getByRole("button", { name: "Close inspector" }).click();
  await page.getByLabel("Export run", { exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "OTLP JSON", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`flight-${blocked.id}.otlp.json`);
  await download.cancel();
  const exportResponse = await request.get(`/api/runs/${blocked.id}/exports/otlp`);
  expect(exportResponse.ok()).toBeTruthy();
  const exported = await exportResponse.json();
  expect(exported.resourceSpans[0].scopeSpans[0].spans).toHaveLength(blocked.events.length + 1);
  await page.reload();
  await expect(page.locator(".timeline-row")).toHaveCount(blocked.events.length);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("timeline.png"), fullPage: true, scale: "css" });
  const layout = await page.evaluate(() => ({
    viewport: innerWidth, width: document.documentElement.scrollWidth,
    fontsLoaded: document.fonts.check('14px "IBM Plex Sans"'),
    brokenImages: [...document.images].filter(image => !image.complete || !image.naturalWidth).length
  }));
  expect(layout.width).toBeLessThanOrEqual(layout.viewport + 1);
  expect(layout.fontsLoaded).toBeTruthy();
  expect(layout.brokenImages).toBe(0);
  expect(errors).toEqual([]);
});

test("trace text stays inert and missing runs surface a recoverable error", async ({ page, request }) => {
  const response = await request.post("/api/runs", { data: {
    request: '<img src=x onerror="globalThis.injected=true">',
    entryPointAgent: "test-agent", requestingIdentity: "test-identity", recordingMode: 2
  } });
  const run = await response.json();
  await page.goto(`/?run=${run.id}`);
  await expect(page.locator("#run-overview h2")).toHaveText('<img src=x onerror="globalThis.injected=true">');
  expect(await page.evaluate(() => globalThis.injected)).toBeUndefined();
  await page.goto("/?run=00000000-0000-0000-0000-000000000000");
  await expect(page.getByRole("alert")).toContainText(/404|Not Found/);
  await page.locator("[data-run]").first().click();
  await expect(page.locator("#run-overview h2")).toBeVisible();
});

test("running recorder version is visible even without a selected run and refreshes independently", async ({ page }, testInfo) => {
  await page.route("**/api/runs", route => route.fulfill({ json: [] }));
  let version = "1.0.0";
  await page.route("**/api/info", route => route.fulfill({ json: { version } }));
  await page.goto("/");
  const label = page.getByRole("status", { name: "Recorder version" });
  await expect(label).toBeVisible();
  await expect(label).toHaveText("Recorder v1.0.0");
  await expect(page.getByRole("heading", { name: "No run selected" })).toBeVisible();
  version = "1.1.0-rc.1+build";
  await page.getByRole("button", { name: "Refresh runs", exact: true }).click();
  await expect(label).toHaveText("Recorder v1.1.0-rc.1+build");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("version-header.png"), scale: "css" });
});

test("development and unavailable versions do not hide the viewer or pretend to be a release", async ({ page }) => {
  await page.route("**/api/runs", route => route.fulfill({ json: [] }));
  await page.route("**/api/info", route => route.fulfill({ json: { version: null } }));
  await page.goto("/");
  const label = page.getByRole("status", { name: "Recorder version" });
  await expect(label).toHaveText("Development build");
  await page.unroute("**/api/info");
  await page.route("**/api/info", route => route.fulfill({ status: 404, json: { title: "No version endpoint" } }));
  await page.getByRole("button", { name: "Refresh runs", exact: true }).click();
  await expect(label).toHaveText("Version unavailable");
  await expect(label).toHaveAttribute("data-state", "error");
  await expect(label).toHaveAttribute("title", /No version endpoint/);
  await expect(page.getByRole("heading", { name: "No run selected" })).toBeVisible();
  await page.unroute("**/api/info");
  await page.route("**/api/info", route => route.fulfill({ json: { version: '<img src=x onerror="globalThis.versionInjected=true">' } }));
  await page.getByRole("button", { name: "Refresh runs", exact: true }).click();
  await expect(label).toHaveText("Version unavailable");
  expect(await page.evaluate(() => globalThis.versionInjected)).toBeUndefined();
});

test("missing, zero and partial usage are distinct in overview, inspector and comparison", async ({ page, request }) => {
  const create = async (name, events) => {
    const response = await request.post("/api/runs", { data: {
      request: name, entryPointAgent: "usage-test", requestingIdentity: "test", recordingMode: 1
    } });
    expect(response.ok()).toBeTruthy();
    const run = await response.json();
    for (const event of events) {
      const recorded = await request.post(`/api/runs/${run.id}/events`, { data: { type: 2, ...event } });
      expect(recorded.ok()).toBeTruthy();
    }
    await request.post(`/api/runs/${run.id}/complete`);
    return run;
  };
  const missing = await create("Usage unavailable", [{ name: "Unknown model usage" }]);
  const measured = await create("Usage explicitly zero", [{
    name: "Zero model usage", model: "synthetic-model", inputTokens: 0, outputTokens: 0,
    estimatedCost: 0, costBasis: "Synthetic USD test pricing: zero per token."
  }]);
  const partial = await create("Usage partially reported", [
    { name: "Input only", inputTokens: 12 }, { name: "Unreported call" }
  ]);
  await page.goto(`/?run=${missing.id}`);
  const tokens = page.locator("#run-overview .metric").filter({ hasText: "Reported tokens" }).locator("strong");
  const cost = page.locator("#run-overview .metric").filter({ hasText: "Reported est. cost" }).locator("strong");
  await expect(tokens).toHaveText("Not reported");
  await expect(cost).toHaveText("Not reported");
  await page.locator(".timeline-row").first().click();
  await expect(page.locator("#inspector")).toContainText("Not reported");
  await page.goto(`/?run=${measured.id}`);
  await expect(tokens).toHaveText("0");
  await expect(cost).toHaveText("$0.0000");
  await page.locator(".timeline-row").first().click();
  await expect(page.locator("#inspector")).toContainText("Synthetic USD test pricing");
  await page.goto(`/?run=${partial.id}`);
  await expect(tokens).toHaveText("12 (partial)");
  await expect(cost).toHaveText("Not reported");
  await page.getByRole("tab", { name: "Compare", exact: true }).click();
  await page.getByLabel("Baseline run").selectOption(missing.id);
  const tokenComparison = page.locator(".delta-metric").filter({ hasText: "Reported tokens" });
  await expect(tokenComparison).toContainText("Not reported");
  await expect(tokenComparison).toContainText("12 (partial)");
  await expect(tokenComparison).toContainText("Not comparable");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
});

test("SDK usage adapter reaches the API and viewer with explicit pricing evidence", async ({ page, request, baseURL }) => {
  const response = await request.post("/api/runs", { data: {
    request: "Synthetic SDK adapter acceptance", entryPointAgent: "sdk-test", requestingIdentity: "test", recordingMode: 1
  } });
  expect(response.ok()).toBeTruthy();
  const run = await response.json();
  let emit;
  const session = {
    on(type, listener) {
      expect(type).toBe("assistant.usage");
      emit = listener;
      return () => { emit = undefined; };
    }
  };
  const capture = attachCopilotUsage(session, {
    runId: run.id, serverUrl: baseURL,
    prices: { "synthetic-model": {
      currency: "USD", source: "Synthetic acceptance prices, not provider pricing",
      asOf: "2026-09-01", effectiveFrom: "2026-09-01", inputTokenAccounting: "includes-cache",
      inputPerMillion: 2, outputPerMillion: 6
    } }
  });
  try {
    emit({
      type: "assistant.usage", id: randomUUID(), timestamp: "2026-09-06T16:00:00Z", ephemeral: true,
      data: { model: "synthetic-model", inputTokens: 1000, outputTokens: 250, cacheReadTokens: 0, cacheWriteTokens: 0 }
    });
  } finally {
    await capture.detach();
  }
  await request.post(`/api/runs/${run.id}/complete`);
  const stored = await (await request.get(`/api/runs/${run.id}`)).json();
  expect(stored.inputTokens).toBe(1000);
  expect(stored.outputTokens).toBe(250);
  expect(stored.estimatedCost).toBeCloseTo(0.0035);
  expect(stored.events[0].costBasis).toContain("Synthetic acceptance prices");
  expect(JSON.parse(stored.events[0].costBasis).inputAccounting).toBe("includes-cache");
  expect(stored.events[0].attributes["sdk.cacheReadCount"]).toBe("0");
  expect(stored.events[0].attributes["sdk.cacheWriteCount"]).toBe("0");
  expect(stored.usage.tokensComplete).toBe(true);
  expect(stored.usage.costComplete).toBe(true);
  await page.goto(`/?run=${run.id}`);
  await expect(page.locator("#run-overview .metric").filter({ hasText: "Reported tokens" }).locator("strong")).toHaveText("1,250");
  await expect(page.locator("#run-overview .metric").filter({ hasText: "Reported est. cost" }).locator("strong")).toHaveText("$0.0035");
  await page.locator(".timeline-row").first().click();
  await expect(page.locator("#inspector")).toContainText("Synthetic acceptance prices");
});