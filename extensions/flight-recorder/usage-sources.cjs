"use strict";

const nodeFs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { TextDecoder } = require("node:util");

const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_DB_BYTES = 64 * 1024 * 1024;
const SQLITE_BUSY_TIMEOUT_MS = 200;
const MAX_OBSERVATIONS = 1000;
const MAX_DB_ROWS = 10000;
const MAX_EVENTS = 50000;
const MAX_NODES = 200000;
const MAX_ARRAY = 10000;
const MAX_DEPTH = 64;
const MAX_INT = 2147483647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MESSAGES = Object.freeze({
  UNSUPPORTED_FORMAT: "This persisted usage schema is not supported. Choose a supported JSON, JSONL, or CLI usage database.",
  SOURCE_UNAVAILABLE: "The selected local usage source is unavailable or cannot be read safely. Check its location and permissions.",
  SOURCE_TOO_LARGE: "The usage source exceeds the bounded reader limit. Choose a smaller session or export.",
  SOURCE_CHANGED: "The usage source changed or its final JSONL record is incomplete. Retry after the writer finishes; no partial snapshot was imported.",
  SQLITE_UNAVAILABLE: "Built-in SQLite is unavailable. Update VS Code to a version with node:sqlite, or manually select a supported JSON/JSONL export. No external database tools are installed.",
  INVALID_USAGE: "The source contains invalid, conflicting, or out-of-range usage values. No partial snapshot was imported."
});

class SourceError extends Error {
  constructor(code, message = MESSAGES[code]) {
    super(message || MESSAGES.SOURCE_UNAVAILABLE);
    this.name = "SourceError";
    this.code = Object.hasOwn(MESSAGES, code) ? code : "SOURCE_UNAVAILABLE";
  }
}

const fail = code => { throw new SourceError(code); };
const digest = value => createHash("sha256").update(value).digest("hex");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fsApi = supplied => supplied?.promises || supplied || nodeFs.promises;
const own = (value, key) => object(value) && Object.hasOwn(value, key);
const missingFile = error => error?.code === "ENOENT" || error?.code === "ENOTDIR";

function sourceError(error) {
  if (error instanceof SourceError) return error;
  if (typeof error?.errcode === "number" && [5, 6].includes(error.errcode & 0xff)) {
    return new SourceError("SOURCE_CHANGED");
  }
  return new SourceError("SOURCE_UNAVAILABLE");
}

function absolutePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0") ||
      value.startsWith("\\\\") || value.startsWith("//")) fail("SOURCE_UNAVAILABLE");
  return path.resolve(value);
}

function canonicalKey(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

async function checkedPath(value, fs, expected, canonicalized = false) {
  const resolved = absolutePath(value);
  const root = path.parse(resolved).root;
  let current = root;
  let stat = await fs.lstat(root);
  if (stat.isSymbolicLink()) fail("SOURCE_UNAVAILABLE");
  const segments = resolved.slice(root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (i < segments.length - 1 && !stat.isDirectory())) fail("SOURCE_UNAVAILABLE");
  }
  if (expected === "file" && !stat.isFile()) fail("SOURCE_UNAVAILABLE");
  if (expected === "directory" && !stat.isDirectory()) fail("SOURCE_UNAVAILABLE");
  const real = await fs.realpath(resolved);
  if (canonicalKey(path.resolve(real)) !== canonicalKey(resolved)) {
    if (process.platform !== "win32" || canonicalized) fail("SOURCE_CHANGED");
    // Windows short (8.3) names may resolve to a different spelling without being
    // links. Recheck the canonical path and file identity instead of trusting it.
    const canonical = await checkedPath(real, fs, expected, true);
    if (!sameFile(stat, canonical.stat)) fail("SOURCE_CHANGED");
    return canonical;
  }
  return { path: path.resolve(real), stat };
}

function sameFile(a, b) {
  // Windows directory-entry ctime can lag the open handle's ctime after a write.
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && (process.platform === "win32" || a.ctimeMs === b.ctimeMs);
}

async function readText(file, fs) {
  const checked = await checkedPath(file, fs, "file");
  if (checked.stat.size > MAX_TEXT_BYTES) fail("SOURCE_TOO_LARGE");
  const flags = nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW || 0);
  const handle = await fs.open(checked.path, flags);
  try {
    if (!sameFile(checked.stat, await handle.stat())) fail("SOURCE_CHANGED");
    const chunks = [];
    let length = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(65536, MAX_TEXT_BYTES + 1 - length));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > MAX_TEXT_BYTES) fail("SOURCE_TOO_LARGE");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await checkedPath(file, fs, "file");
    if (!sameFile(checked.stat, await handle.stat()) || !sameFile(checked.stat, after.stat) ||
        length !== checked.stat.size) fail("SOURCE_CHANGED");
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)), path: checked.path };
    } catch {
      fail("UNSUPPORTED_FORMAT");
    }
  } finally {
    await handle.close();
  }
}

function validateTree(value, budget) {
  const pending = [[value, 0]];
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (++budget.nodes > MAX_NODES || depth > MAX_DEPTH) fail("SOURCE_TOO_LARGE");
    if (item === null || typeof item !== "object") continue;
    if (Array.isArray(item) && item.length > MAX_ARRAY) fail("SOURCE_TOO_LARGE");
    for (const key of Object.keys(item)) {
      if (UNSAFE_KEYS.has(key)) fail("UNSUPPORTED_FORMAT");
      pending.push([item[key], depth + 1]);
    }
  }
  return value;
}

function parseJson(text, budget, incomplete = false) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { fail(incomplete ? "SOURCE_CHANGED" : "UNSUPPORTED_FORMAT"); }
  return validateTree(parsed, budget);
}

function numberValue(value, max = MAX_INT) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(max)) fail("INVALID_USAGE");
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) fail("INVALID_USAGE");
  return value;
}

function modelLabel(value, warnings) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.length <= 120 &&
      /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/i.test(value) &&
      !/^(?:gh[pousr]_|github_pat_|sk-|https?:|file:)/i.test(value) && !UNSAFE_KEYS.has(value)) return value;
  warnings.add("An unsafe or unsupported model label was omitted.");
  return undefined;
}

function timestamp(value, warnings, milliseconds = false) {
  if (value === undefined || value === null) return undefined;
  if (milliseconds && Number.isSafeInteger(value) && value >= 0 && value <= 253402300799999) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    const date = new Date(value);
    const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
    if (Number.isFinite(date.getTime()) && Number.isFinite(day.getTime()) &&
        day.toISOString().slice(0, 10) === value.slice(0, 10)) return date.toISOString();
  }
  warnings.add("An invalid timestamp was omitted.");
  return undefined;
}

function observation(sourceId, key, model, time, fields, warnings, visible, allowEstimates) {
  const result = { id: digest(JSON.stringify([sourceId, key])) };
  const safeModel = modelLabel(model, warnings);
  if (safeModel !== undefined) result.model = safeModel;
  if (time !== undefined) result.timestamp = time;
  const measured = Object.entries(fields).some(([key, value]) => key !== "nanoAiu" && value !== undefined);
  result.quality = measured ? "measured" : "unavailable";
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) result[key] = value;
  if (allowEstimates && fields.inputTokens === undefined && fields.outputTokens === undefined && visible) {
    for (const [field, chars] of Object.entries(visible)) {
      if (chars !== undefined) result[field] = numberValue(Math.ceil(chars / 4));
    }
    if (!measured && Object.keys(visible).length) result.quality = "estimated";
    if (Object.keys(visible).length) warnings.add("Estimates count visible transcript characters divided by four, not actual model context or billed tokens.");
  }
  if (result.quality === "unavailable") warnings.add("Some recognizable requests have no supported measured usage.");
  return result;
}

function fieldsFrom(record, names) {
  const fields = {};
  for (const [target, name] of Object.entries(names)) {
    fields[target] = numberValue(own(record, name) ? record[name] : undefined, target === "nanoAiu" ? Number.MAX_SAFE_INTEGER : MAX_INT);
  }
  return fields;
}

function chatUsage(request) {
  const result = object(request.result) ? request.result : {};
  const candidates = [
    fieldsFrom(result.usage, { inputTokens: "promptTokens", outputTokens: "completionTokens" }),
    fieldsFrom(result, { inputTokens: "promptTokens", outputTokens: "outputTokens" }),
    fieldsFrom(result.metadata, { inputTokens: "promptTokens", outputTokens: "outputTokens" })
  ];
  const fields = {};
  for (const field of ["inputTokens", "outputTokens"]) {
    const supplied = candidates.map(candidate => candidate[field]).filter(value => value !== undefined);
    if (new Set(supplied).size > 1) fail("INVALID_USAGE");
    fields[field] = supplied[0];
  }
  return fields;
}

function visibleChat(request) {
  const visible = {};
  if (typeof request.message?.text === "string") {
    visible.estimatedInputTokens = request.message.text.length;
  } else if (Array.isArray(request.message?.parts)) {
    const parts = request.message.parts.filter(part => typeof part?.text === "string");
    if (parts.length) visible.estimatedInputTokens = parts.reduce((sum, part) => sum + part.text.length, 0);
  }
  const response = request.response ?? request.responses;
  if (Array.isArray(response)) {
    let chars = 0;
    let found = false;
    for (const part of response) {
      if (!object(part) || (part.kind !== undefined && !["markdownContent", "markdown", "text"].includes(part.kind))) continue;
      const value = typeof part.content?.value === "string" ? part.content.value : part.value;
      if (typeof value === "string") { chars += value.length; found = true; }
    }
    if (found) visible.estimatedOutputTokens = chars;
  }
  return visible;
}

function chatObservations(state, context) {
  if (!object(state)) fail("UNSUPPORTED_FORMAT");
  const requests = Array.isArray(state.requests) ? state.requests : state.history;
  if (!Array.isArray(requests)) fail("UNSUPPORTED_FORMAT");
  if (requests.length > MAX_OBSERVATIONS) fail("SOURCE_TOO_LARGE");
  return requests.map((request, index) => {
    if (!object(request) || !(object(request.message) || object(request.result) ||
        Array.isArray(request.response) || Array.isArray(request.responses))) fail("UNSUPPORTED_FORMAT");
    const requestId = request.requestId ?? request.id;
    const key = typeof requestId === "string" && requestId.length > 0 && requestId.length <= 512
      ? ["request", requestId] : ["request-index", index];
    return observation(context.id, key,
      request.modelId ?? request.selectedModel?.identifier ?? request.model ?? request.result?.metadata?.modelId,
      timestamp(request.timestamp, context.warnings, true), chatUsage(request), context.warnings,
      context.allowEstimates ? visibleChat(request) : undefined, context.allowEstimates);
  });
}

function pathSegment(container, segment) {
  if (typeof segment !== "string" && typeof segment !== "number") fail("UNSUPPORTED_FORMAT");
  const key = String(segment);
  if (key.length === 0 || key.length > 128 || UNSAFE_KEYS.has(key)) fail("UNSUPPORTED_FORMAT");
  if (Array.isArray(container)) {
    if (!/^(0|[1-9]\d*)$/.test(key)) fail("UNSUPPORTED_FORMAT");
    const index = Number(key);
    if (index >= MAX_ARRAY) fail("SOURCE_TOO_LARGE");
    if (index > container.length) fail("UNSUPPORTED_FORMAT");
  }
  return key;
}

function deltaState(events) {
  if (events[0]?.kind !== 0 || !object(events[0].v)) fail("UNSUPPORTED_FORMAT");
  let state = events[0].v;
  for (let i = 1; i < events.length; i++) {
    const event = events[i];
    if (!object(event) || !Object.hasOwn(event, "v")) fail("UNSUPPORTED_FORMAT");
    if (event.kind === 0) {
      if (!object(event.v)) fail("UNSUPPORTED_FORMAT");
      state = event.v;
      continue;
    }
    if (![1, 2].includes(event.kind) || !Array.isArray(event.k) || !event.k.length) fail("UNSUPPORTED_FORMAT");
    if (event.k.length > MAX_DEPTH) fail("SOURCE_TOO_LARGE");
    let current = state;
    for (let n = 0; n < event.k.length; n++) {
      const key = pathSegment(current, event.k[n]);
      if (n < event.k.length - 1) {
        if (!Object.hasOwn(current, key)) {
          current[key] = /^(0|[1-9]\d*)$/.test(String(event.k[n + 1])) ? [] : Object.create(null);
        }
        if (current[key] === null || typeof current[key] !== "object") fail("UNSUPPORTED_FORMAT");
        current = current[key];
      } else if (event.kind === 1) {
        current[key] = event.v;
      } else {
        if (!Object.hasOwn(current, key)) current[key] = [];
        if (!Array.isArray(current[key])) fail("UNSUPPORTED_FORMAT");
        const additions = Array.isArray(event.v) ? event.v : [event.v];
        if (current[key].length + additions.length > MAX_ARRAY) fail("SOURCE_TOO_LARGE");
        for (const addition of additions) current[key].push(addition);
      }
    }
  }
  validateTree(state, { nodes: 0 });
  return state;
}

const CLI_FIELDS = Object.freeze({
  inputTokens: "inputTokens", outputTokens: "outputTokens",
  cacheReadTokens: "cacheReadTokens", cacheWriteTokens: "cacheWriteTokens"
});

function eventKey(event, index) {
  return typeof event.id === "string" && event.id.length > 0 && event.id.length <= 512
    ? ["event", event.id] : ["event-index", index];
}

function eventObservations(events, context) {
  const calls = [];
  const shutdowns = [];
  const requests = [];
  let current;
  let recognized = false;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (!object(event) || typeof event.type !== "string" || !object(event.data)) fail("UNSUPPORTED_FORMAT");
    const data = event.data;
    if (event.type === "assistant.usage") {
      recognized = true;
      const fields = fieldsFrom(data, CLI_FIELDS);
      const nanoAiu = numberValue(data.copilotUsage?.totalNanoAiu, Number.MAX_SAFE_INTEGER);
      if (context.kind === "copilot-cli") fields.nanoAiu = nanoAiu;
      else if (nanoAiu !== undefined) context.warnings.add("CLI billing fields were omitted for a non-CLI source.");
      calls.push(observation(context.id, eventKey(event, index), data.model,
        timestamp(event.timestamp, context.warnings), fields, context.warnings));
    } else if (event.type === "session.shutdown") {
      recognized = true;
      shutdowns.push(event);
    } else if (event.type === "user.message") {
      if (typeof data.content !== "string") fail("UNSUPPORTED_FORMAT");
      recognized = true;
      current = { event, index, input: data.content.length, output: undefined, fields: {} };
      requests.push(current);
    } else if (event.type === "assistant.message") {
      if (typeof data.content !== "string" && !own(data, "outputTokens")) fail("UNSUPPORTED_FORMAT");
      recognized = true;
      if (!current) { current = { event, index, fields: {} }; requests.push(current); }
      if (typeof data.content === "string") current.output = (current.output ?? 0) + data.content.length;
      const output = numberValue(data.outputTokens);
      if (output !== undefined) current.fields.outputTokens = numberValue((current.fields.outputTokens ?? 0) + output);
      if (data.model !== undefined) current.model = data.model;
    } else if (event.type === "session.start" && typeof data.sessionId === "string") {
      recognized = true;
    } else {
      context.warnings.add("Non-usage event records were ignored; unsupported event types are not token evidence.");
    }
  }
  if (!recognized) fail("UNSUPPORTED_FORMAT");
  if (calls.some(call => call.quality === "measured")) {
    if (shutdowns.length) context.warnings.add("Per-call usage was selected; shutdown totals were not added.");
    return calls;
  }
  if (shutdowns.length) {
    const last = shutdowns[shutdowns.length - 1];
    if (shutdowns.length > 1) context.warnings.add("Only the latest shutdown snapshot was selected; multiple totals were not added.");
    if (!object(last.data.modelMetrics)) fail("UNSUPPORTED_FORMAT");
    const totals = Object.entries(last.data.modelMetrics).map(([model, metrics]) => {
      if (!object(metrics) || !object(metrics.usage)) fail("UNSUPPORTED_FORMAT");
      return observation(context.id, ["shutdown-model", model], model,
        timestamp(last.timestamp, context.warnings), fieldsFrom(metrics.usage, CLI_FIELDS), context.warnings);
    });
    const nanoAiu = numberValue(last.data.totalNanoAiu, Number.MAX_SAFE_INTEGER);
    if (nanoAiu !== undefined && context.kind === "copilot-cli") {
      totals.push(observation(context.id, ["shutdown-billing"], undefined,
        timestamp(last.timestamp, context.warnings), { nanoAiu }, context.warnings));
    } else if (nanoAiu !== undefined) {
      context.warnings.add("CLI billing fields were omitted for a non-CLI source.");
    }
    context.warnings.add("Shutdown observations are model totals, not individual calls.");
    return totals;
  }
  if (calls.length) return calls;
  return requests.map(request => {
    const visible = {};
    if (request.input !== undefined) visible.estimatedInputTokens = request.input;
    if (request.output !== undefined) visible.estimatedOutputTokens = request.output;
    return observation(context.id, eventKey(request.event, request.index), request.model,
      timestamp(request.event.timestamp, context.warnings), request.fields, context.warnings,
      visible, context.allowEstimates);
  });
}

function snapshot(source, context, format, observations) {
  if (observations.length > MAX_OBSERVATIONS) fail("SOURCE_TOO_LARGE");
  const unique = new Map();
  for (const item of observations) {
    const previous = unique.get(item.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(item)) fail("INVALID_USAGE");
    unique.set(item.id, item);
  }
  if (!unique.size) context.warnings.add("The recognized source currently contains no usage observations.");
  const result = {
    sourceId: context.id, sourceKind: source.kind, format,
    observations: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)),
    warnings: [...context.warnings].sort()
  };
  return { ...result, revision: digest(JSON.stringify(result)) };
}

const DB_FIELDS = Object.freeze({
  inputTokens: "input_tokens", outputTokens: "output_tokens",
  cacheReadTokens: "cache_read_tokens", cacheWriteTokens: "cache_write_tokens", nanoAiu: "total_nano_aiu"
});

function sqliteClass(options) {
  if (Object.hasOwn(options, "DatabaseSync")) {
    if (typeof options.DatabaseSync !== "function") fail("SQLITE_UNAVAILABLE");
    return options.DatabaseSync;
  }
  try { return require("node:sqlite").DatabaseSync; } catch { fail("SQLITE_UNAVAILABLE"); }
}

async function withDatabase(file, options, action) {
  const fs = fsApi(options.fs);
  const checked = await checkedPath(file, fs, "file");
  if (checked.stat.size > MAX_DB_BYTES) fail("SOURCE_TOO_LARGE");
  const sidecars = new Map();
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      const sidecar = await checkedPath(`${file}${suffix}`, fs, "file");
      if (sidecar.stat.size > MAX_DB_BYTES) fail("SOURCE_TOO_LARGE");
      sidecars.set(suffix, sidecar.stat);
    } catch (error) { if (!missingFile(error)) throw error; }
  }
  const DatabaseSync = sqliteClass(options);
  let db;
  try {
    db = new DatabaseSync(checked.path, {
      readOnly: true, allowExtension: false, enableDoubleQuotedStringLiterals: false,
      timeout: SQLITE_BUSY_TIMEOUT_MS
    });
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}; PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN`);
    const table = db.prepare("SELECT type, rootpage FROM sqlite_schema WHERE name = 'assistant_usage_events' LIMIT 2").all();
    if (table.length !== 1 || table[0].type !== "table" || table[0].rootpage <= 0) fail("UNSUPPORTED_FORMAT");
    const columns = db.prepare("SELECT name, type, pk, hidden FROM pragma_table_xinfo('assistant_usage_events') LIMIT 129").all();
    if (columns.length > 128) fail("SOURCE_TOO_LARGE");
    const byName = new Map(columns.map(column => [column.name, column]));
    for (const name of ["session_id", "model", "input_tokens", "output_tokens"]) {
      if (!byName.has(name) || byName.get(name).hidden !== 0) fail("UNSUPPORTED_FORMAT");
    }
    for (const name of Object.values(DB_FIELDS)) {
      if (byName.has(name) && byName.get(name).hidden !== 0) fail("UNSUPPORTED_FORMAT");
    }
    const result = action(db, columns, checked.path);
    db.exec("ROLLBACK");
    const after = await checkedPath(file, fs, "file");
    if (!sameFile(checked.stat, after.stat)) fail("SOURCE_CHANGED");
    // SQLite gives a transaction-consistent view. Also avoid publishing stale
    // snapshots when the backing file or WAL changes during this bounded read.
    for (const suffix of ["-wal", "-journal"]) {
      let current;
      try { current = (await checkedPath(`${file}${suffix}`, fs, "file")).stat; }
      catch (error) { if (!missingFile(error)) throw error; }
      const previous = sidecars.get(suffix);
      if (Boolean(previous) !== Boolean(current) || (previous && !sameFile(previous, current))) fail("SOURCE_CHANGED");
    }
    return result;
  } finally {
    if (db) db.close();
  }
}

async function readDatabase(source, options, context) {
  if (typeof source.sessionId !== "string" || !UUID.test(source.sessionId)) fail("UNSUPPORTED_FORMAT");
  return withDatabase(source.path, options, (db, columns) => {
    const columnNames = new Set(columns.map(column => column.name));
    const primary = columns.filter(column => column.pk > 0);
    const stableKey = primary.length === 1 && ["id", "event_id"].includes(primary[0].name) &&
      primary[0].hidden === 0 ? primary[0].name : undefined;
    // Bound text crossing the SQLite boundary; malformed numeric text/blob values
    // become an invalid sentinel, never a coercion or exported source content.
    const selected = ["CASE WHEN model IS NULL OR (typeof(model) = 'text' AND length(model) <= 512) THEN model ELSE 0 END AS model"];
    for (const name of Object.values(DB_FIELDS).filter(name => columnNames.has(name))) {
      selected.push(`CASE WHEN typeof(${name}) IN ('integer', 'real', 'null') THEN ${name} ELSE -1 END AS ${name}`);
    }
    if (stableKey) {
      selected.unshift(`CASE WHEN typeof(${stableKey}) = 'integer' OR (typeof(${stableKey}) = 'text' AND length(${stableKey}) <= 512) THEN ${stableKey} ELSE NULL END AS ${stableKey}`);
    }
    const sql = `SELECT ${selected.join(", ")} FROM assistant_usage_events WHERE session_id = ? LIMIT ${MAX_DB_ROWS + 1}`;
    const query = db.prepare(sql);
    query.setReadBigInts(true);
    const rows = query.all(source.sessionId);
    if (rows.length > MAX_DB_ROWS) fail("SOURCE_TOO_LARGE");
    if (stableKey && rows.length > MAX_OBSERVATIONS) fail("SOURCE_TOO_LARGE");
    if (Object.values(DB_FIELDS).some(name => !columnNames.has(name))) {
      context.warnings.add("Some optional database usage columns are unavailable; missing values were not replaced with zero.");
    }
    if (stableKey) {
      return rows.map(row => {
        if (row.model !== null && typeof row.model !== "string") fail("INVALID_USAGE");
        const key = row[stableKey];
        if ((typeof key !== "string" && typeof key !== "bigint") ||
            String(key).length === 0 || String(key).length > 512) fail("UNSUPPORTED_FORMAT");
        return observation(context.id, ["database-row", stableKey, String(key)], row.model, undefined,
          fieldsFrom(row, DB_FIELDS), context.warnings);
      });
    }
    // Without a declared stable key, rowid is not a durable identity (VACUUM can change it).
    const models = new Map();
    for (const row of rows) {
      if (row.model !== null && (typeof row.model !== "string" || row.model.length > 512)) fail("INVALID_USAGE");
      const fields = fieldsFrom(row, DB_FIELDS);
      let aggregate = models.get(row.model);
      if (!aggregate) {
        aggregate = { totals: Object.create(null), missing: new Set() };
        models.set(row.model, aggregate);
      }
      for (const [name, value] of Object.entries(fields)) {
        if (value === undefined) aggregate.missing.add(name);
        else aggregate.totals[name] = (aggregate.totals[name] ?? 0n) + BigInt(value);
      }
    }
    context.warnings.add("The database has no supported stable row key; observations are per-model totals, not individual calls.");
    return [...models].map(([model, aggregate]) => {
      const fields = {};
      for (const name of Object.keys(DB_FIELDS)) {
        fields[name] = aggregate.missing.has(name) ? undefined :
          numberValue(aggregate.totals[name], name === "nanoAiu" ? Number.MAX_SAFE_INTEGER : MAX_INT);
      }
      if (aggregate.missing.size) context.warnings.add("Incomplete aggregate fields were omitted rather than presented as complete totals.");
      return observation(context.id, ["database-model", model], model, undefined, fields, context.warnings);
    });
  });
}

async function readSource(source, options = {}) {
  try {
    if (!object(source) || !["vscode-chat", "copilot-cli"].includes(source.kind)) fail("UNSUPPORTED_FORMAT");
    const file = absolutePath(source.path);
    const extension = path.extname(file).toLowerCase();
    if (![".json", ".jsonl", ".db"].includes(extension) || (extension === ".db" && source.kind !== "copilot-cli") ||
        (extension === ".json" && source.kind !== "vscode-chat")) fail("UNSUPPORTED_FORMAT");
    if (extension !== ".db" && source.sessionId !== undefined) fail("UNSUPPORTED_FORMAT");
    const checked = await checkedPath(file, fsApi(options.fs), "file");
    const id = digest(JSON.stringify([canonicalKey(checked.path), source.kind, source.sessionId ?? null]));
    const context = { id, kind: source.kind, allowEstimates: options.allowEstimates === true, warnings: new Set() };
    if (extension === ".db") {
      return snapshot(source, context, "copilot-cli-db", await readDatabase({ ...source, path: file }, options, context));
    }
    const { text } = await readText(file, fsApi(options.fs));
    const budget = { nodes: 0 };
    if (extension === ".json") {
      return snapshot(source, context, "vscode-json", chatObservations(parseJson(text, budget), context));
    }
    const lines = text.split(/\r?\n/);
    const events = [];
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      if (events.length >= MAX_EVENTS) fail("SOURCE_TOO_LARGE");
      events.push(parseJson(lines[index], budget, index === lines.length - 1 && !text.endsWith("\n")));
    }
    if (!events.length) fail("UNSUPPORTED_FORMAT");
    if (source.kind === "vscode-chat" && events[0]?.kind === 0) {
      return snapshot(source, context, "vscode-delta-jsonl", chatObservations(deltaState(events), context));
    }
    return snapshot(source, context, source.kind === "copilot-cli" ? "copilot-cli-events" : "vscode-event-jsonl",
      eventObservations(events, context));
  } catch (error) {
    throw sourceError(error);
  }
}

async function listDatabaseSessions(file, options = {}) {
  try {
    file = absolutePath(file);
    return await withDatabase(file, options, db => {
      // Deliberately never query sessions, turns, messages, summaries, or cwd.
      const rows = db.prepare(`SELECT CASE WHEN typeof(session_id) = 'text' AND length(session_id) = 36 THEN session_id ELSE NULL END AS session_id FROM assistant_usage_events LIMIT ${MAX_DB_ROWS + 1}`).all();
      if (rows.length > MAX_DB_ROWS) fail("SOURCE_TOO_LARGE");
      const ids = new Set();
      for (const row of rows) {
        if (typeof row.session_id !== "string" || !UUID.test(row.session_id)) fail("UNSUPPORTED_FORMAT");
        ids.add(row.session_id);
      }
      if (ids.size > MAX_OBSERVATIONS) fail("SOURCE_TOO_LARGE");
      return [...ids].sort().map(sessionId => ({
        kind: "copilot-cli", path: file, sessionId, label: `Session ${sessionId.slice(0, 8)}`
      }));
    });
  } catch (error) {
    throw sourceError(error);
  }
}

async function discoverSources({ vscodeUserPath, copilotHome, fs: supplied } = {}) {
  if (vscodeUserPath === undefined && copilotHome === undefined) return [];
  const fs = fsApi(supplied);
  const result = new Map();
  const visited = new Set();
  const budget = { entries: 0, directories: 0 };
  async function entries(directory) {
    const key = canonicalKey(absolutePath(directory));
    if (visited.has(key)) return [];
    visited.add(key);
    let checked;
    try { checked = await checkedPath(directory, fs, "directory"); }
    catch (error) { if (missingFile(error)) return []; throw error; }
    if (++budget.directories > 1000) fail("SOURCE_TOO_LARGE");
    const found = [];
    const handle = await fs.opendir(checked.path);
    for await (const entry of handle) {
      if (++budget.entries > 5000) fail("SOURCE_TOO_LARGE");
      if (entry.name === "." || entry.name === ".." || entry.name.includes(path.sep)) fail("SOURCE_UNAVAILABLE");
      if (entry.isSymbolicLink()) continue;
      found.push(entry);
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }
  async function add(file, kind) {
    const checked = await checkedPath(file, fs, "file");
    const key = canonicalKey(checked.path);
    const stem = path.basename(file, path.extname(file));
    const suffix = UUID.test(stem) ? stem.slice(0, 8) : digest(key).slice(0, 8);
    const label = path.extname(file).toLowerCase() === ".db" ? "Copilot CLI usage database" :
      `${kind === "vscode-chat" ? "Chat" : "CLI"} session ${suffix}`;
    const descriptor = { kind, path: checked.path, label };
    if (Number.isFinite(checked.stat.mtimeMs)) descriptor.modifiedAt = new Date(checked.stat.mtimeMs).toISOString();
    result.set(key, descriptor);
    if (result.size > MAX_OBSERVATIONS) fail("SOURCE_TOO_LARGE");
  }
  async function leaf(directory, kind, depth = 0) {
    for (const entry of await entries(directory)) {
      const file = path.join(directory, entry.name);
      if (entry.isFile() && /\.(json|jsonl)$/i.test(entry.name)) await add(file, kind);
      else if (entry.isDirectory() && depth < 1) await leaf(file, kind, depth + 1);
    }
  }
  async function chatStorage(directory) {
    await leaf(path.join(directory, "chatSessions"), "vscode-chat");
    for (const name of ["GitHub.copilot-chat", "github.copilot-chat", "GitHub.copilot", "github.copilot"]) {
      for (const folder of ["chatSessions", "transcripts"]) {
        await leaf(path.join(directory, name, folder), "vscode-chat");
      }
      await leaf(path.join(directory, name, "chatSessions", "transcripts"), "vscode-chat");
    }
  }
  try {
    if (vscodeUserPath !== undefined) {
      const root = absolutePath(vscodeUserPath);
      const workspace = path.join(root, "workspaceStorage");
      for (const entry of await entries(workspace)) {
        if (entry.isDirectory()) await chatStorage(path.join(workspace, entry.name));
      }
      const global = path.join(root, "globalStorage");
      await leaf(path.join(global, "emptyWindowChatSessions"), "vscode-chat");
      await chatStorage(global);
    }
    if (copilotHome !== undefined) {
      const root = absolutePath(copilotHome);
      for (const entry of await entries(root)) {
        if (entry.isFile() && entry.name === "session-store.db") await add(path.join(root, entry.name), "copilot-cli");
      }
      const sessions = path.join(root, "session-state");
      for (const entry of await entries(sessions)) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) await add(path.join(sessions, entry.name), "copilot-cli");
        if (entry.isDirectory()) {
          for (const child of await entries(path.join(sessions, entry.name))) {
            if (child.isFile() && child.name === "events.jsonl") await add(path.join(sessions, entry.name, child.name), "copilot-cli");
          }
        }
      }
    }
    return [...result.values()].sort((a, b) => {
      const measuredFirst = Number(path.extname(b.path) === ".db") - Number(path.extname(a.path) === ".db");
      return measuredFirst || a.path.localeCompare(b.path);
    });
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError("SOURCE_UNAVAILABLE");
  }
}

module.exports = { SourceError, discoverSources, readSource, listDatabaseSessions };
