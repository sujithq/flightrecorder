import { test, expect } from "@playwright/test";

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