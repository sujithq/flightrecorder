import { requireRunId } from "./recorder-client.mjs";

const statuses = new Set(["Started", "Succeeded", "Failed", "Blocked", "RequiresApproval"]);
const asciiText = (value, length) => typeof value === "string" ? value.replace(/[^\x20-\x7e]/g, "?").slice(0, length) : "";

function nonnegative(value, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(value))) {
    throw new Error("Invalid badge metric.");
  }
  return value;
}

export function badgeFrame(summary) {
  if (!summary || summary.version !== 1 || !statuses.has(summary.status)) throw new Error("Unsupported badge summary.");
  const frame = JSON.stringify({
    version: 1,
    runId: requireRunId(summary.runId),
    agent: asciiText(summary.agent, 28),
    status: summary.status,
    eventCount: nonnegative(summary.eventCount, true),
    tokens: nonnegative(summary.tokens, true),
    durationSeconds: nonnegative(summary.durationSeconds),
    estimatedCost: nonnegative(summary.estimatedCost),
    alert: summary.alert === null || summary.alert === undefined ? null : asciiText(summary.alert, 64)
  }) + "\n";
  if (Buffer.byteLength(frame, "utf8") > 1024) throw new Error("Badge frame exceeds the device buffer.");
  return frame;
}

export class BadgeRelay {
  constructor(writeFrame) {
    this.writeFrame = writeFrame;
    this.previous = null;
  }

  async send(summary) {
    if (!summary) return false;
    const frame = badgeFrame(summary);
    if (frame === this.previous) return false;
    await this.writeFrame(frame);
    this.previous = frame;
    return true;
  }
}