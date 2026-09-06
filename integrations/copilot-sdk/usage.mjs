const INT32_MAX = 2147483647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = /^[a-z0-9][a-z0-9._:/-]{0,199}$/i;
const tokenFields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isTokenCount = value => Number.isInteger(value) && value >= 0 && value <= INT32_MAX;
const isRate = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e9;
const isModel = value => typeof value === "string" && MODEL.test(value);
const isLabel = (value, max) => typeof value === "string" && value.length <= max && /^[\x20-\x7e]+$/.test(value) && value.trim().length > 0;

function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function observedTime(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value) ||
      !isDate(value.slice(0, 10))) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= 0 ? time : undefined;
}

/**
 * Estimate USD only from observed counts and an exact-model, caller-supplied price.
 * Undefined means unknown/invalid, not free. No SDK billing credits are converted.
 */
export function estimateUsd(usage, prices, timestamp) {
  if (!isObject(usage) || !isModel(usage.model) || !isObject(prices) ||
      !Object.hasOwn(prices, usage.model) || tokenFields.some(field => !isTokenCount(usage[field]))) return undefined;
  const price = prices[usage.model];
  const time = observedTime(timestamp);
  if (!isObject(price) || time === undefined || price.currency !== "USD" ||
      !isLabel(price.source, 256) || !isDate(price.asOf) || !isDate(price.effectiveFrom) ||
      !["includes-cache", "excludes-cache"].includes(price.inputTokenAccounting) ||
      !isRate(price.inputPerMillion) || !isRate(price.outputPerMillion)) return undefined;
  const from = Date.parse(`${price.effectiveFrom}T00:00:00Z`);
  if (time < from) return undefined;
  if (price.effectiveUntil !== undefined) {
    if (!isDate(price.effectiveUntil)) return undefined;
    const until = Date.parse(`${price.effectiveUntil}T00:00:00Z`);
    if (until <= from || time >= until) return undefined;
  }
  for (const [count, rate] of [["cacheReadTokens", "cacheReadPerMillion"], ["cacheWriteTokens", "cacheWritePerMillion"]]) {
    if ((usage[count] > 0 || price[rate] !== undefined) && !isRate(price[rate])) return undefined;
  }
  const uncached = price.inputTokenAccounting === "includes-cache"
    ? usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens
    : usage.inputTokens;
  if (uncached < 0) return undefined;
  const terms = [
    [uncached, price.inputPerMillion], [usage.outputTokens, price.outputPerMillion],
    [usage.cacheReadTokens, price.cacheReadPerMillion], [usage.cacheWriteTokens, price.cacheWritePerMillion]
  ];
  let estimatedCost = 0;
  for (const [count, rate] of terms) {
    if (count === 0) continue;
    const amount = count * rate / 1e6;
    // Do not let underflow or C# decimal rounding turn a positive price into free usage.
    if (!Number.isFinite(amount) || (rate > 0 && amount < 1e-28)) return undefined;
    estimatedCost += amount;
  }
  if (!Number.isFinite(estimatedCost) || estimatedCost > Number.MAX_SAFE_INTEGER) return undefined;
  const basis = {
    kind: "explicit-token-price-estimate", model: usage.model,
    currency: "USD", source: price.source, asOf: price.asOf, effectiveFrom: price.effectiveFrom,
    ...(price.effectiveUntil === undefined ? {} : { effectiveUntil: price.effectiveUntil }),
    inputAccounting: price.inputTokenAccounting,
    inputPerMillion: price.inputPerMillion, outputPerMillion: price.outputPerMillion,
    ...(price.cacheReadPerMillion === undefined ? {} : { cacheReadPerMillion: price.cacheReadPerMillion }),
    ...(price.cacheWritePerMillion === undefined ? {} : { cacheWritePerMillion: price.cacheWritePerMillion })
  };
  const costBasis = JSON.stringify(basis);
  return costBasis.length <= 2000 ? { estimatedCost, costBasis } : undefined;
}

function requireUuid(value, name) {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${name} must be a UUID.`);
  return value;
}

function localOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError("Recorder must use a trusted loopback HTTP(S) origin."); }
  if (typeof value !== "string" || !["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("Recorder must use a trusted loopback HTTP(S) origin without credentials, path, query or fragment.");
  }
  return url;
}

function boundedInteger(value, name, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new TypeError(`${name} must be an integer from 1 to ${maximum}.`);
  return value;
}

function payloadFor(event, options) {
  if (!isObject(event.data)) throw new TypeError("assistant.usage must contain a data object.");
  const data = event.data;
  const payload = {
    type: 2, status: 1, name: "Copilot SDK assistant.usage", agentName: options.agentName,
    ...(options.parentEventId === undefined ? {} : { parentEventId: options.parentEventId }),
    attributes: { "sdk.usageEvent": "assistant.usage" }
  };
  if (isModel(data.model)) payload.model = data.model;
  const invalid = [];
  for (const field of tokenFields) {
    if (isTokenCount(data[field])) {
      if (field === "inputTokens" || field === "outputTokens") payload[field] = data[field];
      else payload.attributes[field === "cacheReadTokens" ? "sdk.cacheReadCount" : "sdk.cacheWriteCount"] = String(data[field]);
    } else if (data[field] !== undefined && data[field] !== null) invalid.push(field);
  }
  if (invalid.length) payload.attributes["sdk.invalidUsageFields"] = invalid.join(",");
  if (typeof data.cacheDetailsReported === "boolean") payload.attributes["sdk.cacheDetailsReported"] = String(data.cacheDetailsReported);
  if (typeof data.duration === "number" && Number.isFinite(data.duration) && data.duration >= 0) {
    payload.attributes["sdk.durationMs"] = String(data.duration);
  }
  if (observedTime(event.timestamp) !== undefined) {
    payload.startedAt = event.timestamp;
    payload.attributes["sdk.timestampMeaning"] = "usage-event-emitted-at";
  }
  const estimate = estimateUsd(data, options.prices, event.timestamp);
  if (estimate) Object.assign(payload, estimate);
  return payload;
}

async function readAcknowledgement(response) {
  if (response.status !== 201) {
    await response.body?.cancel();
    throw new Error(`Recorder returned HTTP ${response.status}; expected 201.`);
  }
  if (!response.body) throw new Error("Recorder returned an empty acknowledgement.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        throw new Error("Recorder acknowledgement exceeded 64 KiB.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); }
    catch { throw new Error("Recorder returned a non-JSON acknowledgement; delivery is unknown."); }
  } finally {
    reader.releaseLock();
  }
}

async function postEvent(url, payload, options) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Recorder request timed out; delivery is unknown. No retry was attempted."));
      controller.abort();
    }, options.requestTimeoutMs);
  });
  try {
    // Race covers response-body reads and custom transports that ignore AbortSignal.
    await Promise.race([timeout, (async () => {
      const response = await options.fetchImpl(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(payload), redirect: "error", signal: controller.signal
      });
      const result = await readAcknowledgement(response);
      if (!isObject(result) || typeof result.id !== "string" || !UUID.test(result.id) ||
          typeof result.runId !== "string" || result.runId.toLowerCase() !== options.runId.toLowerCase() ||
          result.type !== 2 || result.name !== payload.name ||
          (result.parentEventId ?? undefined)?.toLowerCase() !== payload.parentEventId?.toLowerCase()) {
        throw new Error("Recorder returned an invalid event acknowledgement; delivery is unknown.");
      }
    })()]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Opt in to live usage from a caller-owned @github/copilot-sdk session.
 * flush/detach reject with AggregateError on any capture, delivery, or observer failure.
 */
export function attachCopilotUsage(session, {
  runId, parentEventId, prices, serverUrl = "http://localhost:5080",
  agentName = "copilot-sdk-app", fetchImpl = globalThis.fetch, onError,
  requestTimeoutMs = 15000, maxPending = 256, maxEvents = 10000
} = {}) {
  requireUuid(runId, "runId");
  if (parentEventId !== undefined) requireUuid(parentEventId, "parentEventId");
  const url = new URL(`/api/runs/${runId}/events`, localOrigin(serverUrl));
  if (!session || typeof session.on !== "function") throw new TypeError("A caller-owned SDK session with on(type, handler) is required.");
  if (typeof fetchImpl !== "function" || (onError !== undefined && typeof onError !== "function")) {
    throw new TypeError("fetchImpl and onError must be functions when supplied.");
  }
  if (typeof agentName !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(agentName)) {
    throw new TypeError("agentName must be a non-sensitive role label (1-64 letters, digits, dots, underscores or hyphens).");
  }
  boundedInteger(requestTimeoutMs, "requestTimeoutMs", 60000);
  boundedInteger(maxPending, "maxPending", 10000);
  boundedInteger(maxEvents, "maxEvents", 100000);
  const options = { runId, parentEventId, prices, agentName, fetchImpl, requestTimeoutMs };
  const seenEvents = new Set();
  const seenCalls = new Set();
  const failures = [];
  let tail = Promise.resolve();
  let observers = Promise.resolve();
  let pending = 0;
  let active = true;
  let unsubscribe;

  function notify(error) {
    failures.push(error);
    if (onError) observers = observers.then(() => onError(error)).catch(cause => {
      failures.push(new Error("Usage onError observer failed.", { cause }));
    });
  }
  function stop() {
    active = false;
    const off = unsubscribe;
    unsubscribe = undefined;
    if (off) {
      try { off(); } catch (cause) { notify(new Error("SDK usage unsubscribe failed.", { cause })); }
    }
  }
  function fail(cause) {
    notify(cause instanceof Error ? cause : new Error("SDK usage capture failed.", { cause }));
    stop();
  }
  function onUsage(event) {
    if (!active || event?.type !== "assistant.usage") return;
    try {
      const id = requireUuid(event.id, "SDK event id").toLowerCase();
      const callId = event.data?.apiCallId;
      const callKey = typeof callId === "string" && callId.length > 0 && callId.length <= 512
        ? JSON.stringify([event.data.model, callId]) : undefined;
      if (seenEvents.has(id) || (callKey !== undefined && seenCalls.has(callKey))) return;
      if (pending >= maxPending || seenEvents.size >= maxEvents) throw new Error("SDK usage capture capacity exceeded; detach and flush before completing the run.");
      const payload = payloadFor(event, options);
      seenEvents.add(id);
      if (callKey !== undefined) seenCalls.add(callKey);
      pending++;
      tail = tail.then(() => postEvent(url, payload, options)).catch(fail).finally(() => { pending--; });
    } catch (cause) { fail(cause); }
  }

  try {
    unsubscribe = session.on("assistant.usage", onUsage);
    if (typeof unsubscribe !== "function") throw new TypeError("SDK session.on must return an unsubscribe function.");
    if (!active) stop();
  } catch (cause) {
    active = false;
    throw cause;
  }

  async function flush() {
    let current;
    do {
      current = tail;
      await current;
      await observers;
    } while (tail !== current);
    if (failures.length) throw new AggregateError([...failures], "Copilot SDK usage capture was incomplete; do not assume delivery or retry automatically.");
  }
  async function detach() {
    stop();
    await flush();
  }
  return Object.freeze({ flush, detach });
}
