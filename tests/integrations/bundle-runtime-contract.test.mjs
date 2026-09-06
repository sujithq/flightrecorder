import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { REQUIRED_CONTEXT_FILES, isAllowedContextPath } from "../../scripts/lib/extension-bundle.mjs";

const require = createRequire(import.meta.url);
const runtime = require("../../extensions/flight-recorder/local-recorder.cjs");

test("packaging and installed runtime agree on mandatory build inputs", () => {
  assert.deepEqual([...runtime.REQUIRED_CONTEXT_FILES].sort(), [...REQUIRED_CONTEXT_FILES].sort());
});

test("packaging and runtime enforce the same source-path contract", () => {
  const paths = [
    ...REQUIRED_CONTEXT_FILES,
    "src/FlightRecorder.Api/Controllers/RunsController.cs",
    "src/FlightRecorder.Api/Services/Nested/Service.cs",
    "src/FlightRecorder.Api/Services/.private/Secret.cs",
    "src/FlightRecorder.Api/Services/bin/Generated.cs",
    "src/FlightRecorder.Api/Services/data/Trace.cs",
    "src/FlightRecorder.Api/Services/CON.cs",
    "src/FlightRecorder.Api/Services/Service.cs:stream",
    "src/FlightRecorder.Api/Services/Service.cs.",
    "src/FlightRecorder.Api/Properties/launchSettings.json",
    "src/FlightRecorder.Api/appsettings.Local.json",
    "src/FlightRecorder.Api/appsettings.Development.json",
    "src/FlightRecorder.Web/additional.js",
    "src/FlightRecorder.Web/assets/extra.js",
    "src/FlightRecorder.Web/icon.png",
    "src/FlightRecorder.Web/.env.js",
    "node_modules/private.js", "../Dockerfile", "/Dockerfile", ".env", "data/traces.db",
    "C:/Dockerfile", "src\\FlightRecorder.Api\\Program.cs", "scripts/build-web.mjs\0"
  ];
  for (const path of paths) {
    assert.equal(runtime.allowedBundlePath(path), isAllowedContextPath(path), path);
  }
});
