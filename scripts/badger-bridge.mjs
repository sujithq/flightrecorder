import { parseArgs } from "node:util";
import { recorderJson, requireRunId } from "./lib/recorder-client.mjs";
import { BadgeRelay } from "./lib/badge-protocol.mjs";

async function main() {
  const { values } = parseArgs({ options: {
    url: { type: "string", default: process.env.FLIGHTRECORDER_URL ?? "http://localhost:5080" },
    "run-id": { type: "string" }, port: { type: "string" },
    interval: { type: "string", default: "30" }, watch: { type: "boolean", default: false },
    stdout: { type: "boolean", default: false }, list: { type: "boolean", default: false },
    help: { type: "boolean", default: false }
  } });
  if (values.help) {
    console.log("Usage: npm run badger -- --port COM5 [--url ORIGIN] [--run-id UUID] [--watch --interval 30]\nUse --list to list serial ports or --stdout to preview JSON without a device. The default reads the latest run once.");
    return;
  }
  if (values.list) {
    const { SerialPort } = await import("serialport");
    for (const port of await SerialPort.list()) console.log(`${port.path}\t${port.manufacturer ?? "Serial device"}`);
    return;
  }
  if (!values.port && !values.stdout) throw new Error("Specify --port or --stdout. Use --list to locate your Badger2040.");
  if (values.port && values.stdout) throw new Error("Choose --port or --stdout, not both.");
  const interval = Number(values.interval);
  if (!Number.isFinite(interval) || interval < 15 || interval > 86400) throw new Error("Polling interval must be between 15 and 86400 seconds.");
  const path = values["run-id"] ? `/api/runs/${requireRunId(values["run-id"])}/badge` : "/api/badger/latest";
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let port;
  let timer;
  let pending = Promise.resolve();
  try {
    let writeFrame = async frame => { process.stdout.write(frame); };
    if (values.port) {
      const { SerialPort } = await import("serialport");
      port = new SerialPort({ path: values.port, baudRate: 115200, autoOpen: false });
      port.on("error", () => { console.error("Serial connection failed."); process.exitCode = 1; stop(); });
      await new Promise((resolve, reject) => port.open(error => error ? reject(error) : resolve()));
      writeFrame = frame => new Promise((resolve, reject) => {
        port.write(frame, error => {
          if (error) reject(error);
          else port.drain(drainError => drainError ? reject(drainError) : resolve());
        });
      });
    }
    const relay = new BadgeRelay(writeFrame);
    const update = async () => relay.send(await recorderJson(values.url, path));
    await update();
    if (values.watch && !controller.signal.aborted) {
      let busy = false;
      timer = setInterval(() => {
        if (busy || controller.signal.aborted) return;
        busy = true;
        pending = update().catch(error => console.error(error.message)).finally(() => { busy = false; });
      }, interval * 1000);
      await new Promise(resolve => controller.signal.addEventListener("abort", resolve, { once: true }));
    }
  } finally {
    clearInterval(timer);
    await pending;
    if (port?.isOpen) await new Promise(resolve => port.close(resolve));
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });