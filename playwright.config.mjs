import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const apiRoot = fileURLToPath(new URL("src/FlightRecorder.Api", import.meta.url));

export default defineConfig({
  testDir: "./tests/browser",
  outputDir: "artifacts/browser",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  webServer: process.env.FLIGHTRECORDER_URL ? undefined : {
    command: `dotnet artifacts/validation/bin/FlightRecorder.Api/release/FlightRecorder.Api.dll --urls http://127.0.0.1:5080 --environment Development --contentRoot "${apiRoot}"`,
    url: "http://127.0.0.1:5080/api/runs",
    reuseExistingServer: !process.env.CI,
    timeout: 60000
  },
  use: {
    baseURL: process.env.FLIGHTRECORDER_URL ?? "http://127.0.0.1:5080",
    channel: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "win32" ? "msedge" : undefined),
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } }
  ]
});