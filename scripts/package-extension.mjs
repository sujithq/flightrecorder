import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createVSIX } from "@vscode/vsce";

await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
await copyFile(new URL("../LICENSE", import.meta.url), new URL("../extensions/flight-recorder/LICENSE", import.meta.url));
await createVSIX({
  cwd: fileURLToPath(new URL("../extensions/flight-recorder/", import.meta.url)),
  packagePath: fileURLToPath(new URL("../artifacts/flight-recorder-0.1.0.vsix", import.meta.url)),
  dependencies: false
});