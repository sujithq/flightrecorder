import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withExtensionStage } from "./lib/extension-bundle.mjs";

const defaultRoot = fileURLToPath(new URL("../", import.meta.url));

async function createVSIXWithVsce(options) {
  const { createVSIX } = await import("@vscode/vsce");
  return createVSIX(options);
}

/** Testable packaging entry point; npm run package:vscode uses these defaults. */
export async function packageExtension({
  repositoryRoot = defaultRoot,
  artifactsDirectory = path.join(repositoryRoot, "artifacts"),
  temporaryDirectory,
  readRevision,
  createVSIX = createVSIXWithVsce
} = {}) {
  artifactsDirectory = path.resolve(artifactsDirectory);
  return withExtensionStage({ repositoryRoot, temporaryDirectory, readRevision }, async stage => {
    const filename = `flight-recorder-${stage.extensionManifest.version}.vsix`;
    const stagedPackagePath = path.join(stage.stagingDirectory, filename);
    await createVSIX({
      cwd: stage.extensionDirectory,
      packagePath: stagedPackagePath,
      dependencies: false
    });
    const sha256 = createHash("sha256").update(await readFile(stagedPackagePath)).digest("hex");
    const stagedChecksumPath = `${stagedPackagePath}.sha256`;
    await writeFile(stagedChecksumPath, `${sha256}  ${filename}\n`, { flag: "wx" });

    // Finish VSCE and hashing in temporary storage before copying release artifacts.
    await mkdir(artifactsDirectory, { recursive: true });
    const packagePath = path.join(artifactsDirectory, filename);
    const checksumPath = `${packagePath}.sha256`;
    await copyFile(stagedPackagePath, packagePath);
    await copyFile(stagedChecksumPath, checksumPath);
    return { packagePath, checksumPath, sha256, bundleManifest: stage.bundleManifest };
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = await packageExtension();
  console.log(`Packaged ${result.packagePath}`);
  console.log(`SHA-256 ${result.sha256}`);
}