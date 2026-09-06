import { copyFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createVSIX } from "@vscode/vsce";

const manifest = JSON.parse(await readFile(new URL("../extensions/flight-recorder/package.json", import.meta.url), "utf8"));
await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
await copyFile(new URL("../LICENSE", import.meta.url), new URL("../extensions/flight-recorder/LICENSE", import.meta.url));
await createVSIX({
  cwd: fileURLToPath(new URL("../extensions/flight-recorder/", import.meta.url)),
  packagePath: fileURLToPath(new URL(`../artifacts/${manifest.name}-${manifest.version}.vsix`, import.meta.url)),
  dependencies: false
});