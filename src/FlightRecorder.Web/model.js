const statuses = ["Started", "Succeeded", "Failed", "Blocked", "RequiresApproval"];
const eventTypes = ["Run", "AgentSpan", "ModelCall", "ToolCall", "PolicyDecision"];
const recordingModes = ["MetadataOnly", "Redacted", "Full"];

function enumName(value, names) {
  return typeof value === "number" ? names[value] ?? "Unknown" : names.includes(value) ? value : "Unknown";
}

export const statusName = value => enumName(value, statuses);
export const eventTypeName = value => enumName(value, eventTypes);
export const recordingModeName = value => enumName(value, recordingModes);

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

export function durationMs(item, now = Date.now()) {
  const started = Date.parse(item.startedAt);
  const ended = item.endedAt ? Date.parse(item.endedAt) : now;
  return Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0;
}

export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "0 ms";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(2)} s`;
  return `${Math.floor(milliseconds / 60000)}m ${Math.floor(milliseconds % 60000 / 1000)}s`;
}

export const formatNumber = value => new Intl.NumberFormat("en-US").format(value ?? 0);
export const formatCost = value => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4
}).format(value ?? 0);

export function eventDepth(event, events) {
  const byId = new Map(events.map(item => [item.id, item]));
  const visited = new Set([event.id]);
  let depth = 0;
  let parentId = event.parentEventId;
  while (parentId && byId.has(parentId) && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = byId.get(parentId).parentEventId;
  }
  return depth;
}

export function timelineBounds(run, now = Date.now()) {
  const timestamps = [Date.parse(run.startedAt), ...run.events.map(event => Date.parse(event.startedAt))]
    .filter(Number.isFinite);
  const start = timestamps.length ? Math.min(...timestamps) : now;
  const ends = [run.endedAt ? Date.parse(run.endedAt) : now,
    ...run.events.map(event => event.endedAt ? Date.parse(event.endedAt) : now)].filter(Number.isFinite);
  const end = Math.max(start + 1, ...ends);
  return { start, end, duration: end - start };
}