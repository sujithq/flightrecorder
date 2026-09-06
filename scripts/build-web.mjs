import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(new URL("../src/FlightRecorder.Api/wwwroot/assets/", import.meta.url), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["src/FlightRecorder.Web/app.js"],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  outfile: "src/FlightRecorder.Api/wwwroot/assets/app.js",
  loader: { ".woff2": "file", ".woff": "file" },
  assetNames: "fonts/[name]-[hash]",
  logLevel: "info"
});
await copyFile(new URL("../src/FlightRecorder.Web/index.html", import.meta.url),
  new URL("../src/FlightRecorder.Api/wwwroot/index.html", import.meta.url));