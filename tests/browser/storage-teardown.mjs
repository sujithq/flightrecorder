import { rm } from "node:fs/promises";

export default async function teardown(config) {
  if (config.metadata.traceTestDirectory) {
    await rm(config.metadata.traceTestDirectory, { recursive: true, force: true });
  }
}