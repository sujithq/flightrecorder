import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { attachCopilotUsage, estimateUsd } from "../../integrations/copilot-sdk/usage.mjs";

const runId = "11111111-2222-3333-4444-555555555555";
const parentEventId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const model = "test-model";
const timestamp = "2026-09-06T12:00:00.000Z";
const usage = { model, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 100 };
const price = {
  currency: "USD", source: "Synthetic test prices, not market rates",
  asOf: "2026-09-01", effectiveFrom: "2026-09-01", effectiveUntil: "2026-10-01",
  inputTokenAccounting: "includes-cache",
  inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.5, cacheWritePerMillion: 3
};
const prices = { [model]: price };

// Public v1.0.13 AssistantUsageEvent envelope; no installed SDK or model calls.
function event(data = usage, extra = {}) {
  return { type: "assistant.usage", id: randomUUID(), parentId: null, timestamp, ephemeral: true, data, ...extra };
}

class Session {
  handlers = new Map();
  unsubscribes = 0;
  on(type, handler) {
    assert.equal(type, "assistant.usage");
    assert.equal(typeof handler, "function");
    this.handlers.set(handler, type);
    return () => { this.unsubscribes++; this.handlers.delete(handler); };
  }
  emit(value) {
    for (const [handler, type] of this.handlers) if (type === value.type) handler(value);
  }
}

function harness(overrides = {}) {
  const session = new Session();
  const requests = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, options, body });
    if (new URL(url).pathname === "/v1/traces") return Response.json({}, { status: 200 });
    return Response.json({ ...body, id: randomUUID(), runId }, { status: 201 });
  };
  const adapter = attachCopilotUsage(session, { runId, parentEventId, fetchImpl, ...overrides });
  return { session, requests, adapter };
}

test("USD helper prices cache partitions exactly once with explicit input accounting", () => {
  const included = estimateUsd(usage, prices, timestamp);
  assert.ok(Math.abs(included.estimatedCost - 0.0028) < 1e-12);
  const { inputTokenAccounting, ...rates } = price;
  assert.deepEqual(JSON.parse(included.costBasis), {
    kind: "explicit-token-price-estimate", model, ...rates, inputAccounting: inputTokenAccounting
  });
  const excluded = estimateUsd(usage, { [model]: { ...price, inputTokenAccounting: "excludes-cache" } }, timestamp);
  assert.ok(Math.abs(excluded.estimatedCost - 0.0034) < 1e-12);
  assert.equal(estimateUsd({ ...usage, cacheReadTokens: 1001 }, prices, timestamp), undefined);
});

test("USD helper distinguishes known zero from missing usage and missing prices", () => {
  const zeros = { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.equal(estimateUsd(zeros, prices, timestamp).estimatedCost, 0);
  const free = { ...price, inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 };
  assert.equal(estimateUsd(usage, { [model]: free }, timestamp).estimatedCost, 0);
  assert.equal(estimateUsd(usage, undefined, timestamp), undefined);
  assert.equal(estimateUsd({ ...usage, model: "TEST-MODEL" }, prices, timestamp), undefined);
  assert.equal(estimateUsd({ ...usage, model: undefined }, prices, timestamp), undefined);
  for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
    for (const invalid of [undefined, null, -1, 1.5, NaN, Infinity, "0", true, 2147483648]) {
      assert.equal(estimateUsd({ ...usage, [field]: invalid }, prices, timestamp), undefined, `${field}: ${invalid}`);
    }
  }
  assert.equal(estimateUsd({ ...usage, inputTokens: 2147483647 }, prices, timestamp)?.estimatedCost > 0, true);
});

test("USD helper refuses unsupported currencies, ambiguous caches, and invalid price evidence", () => {
  for (const patch of [
    { currency: "EUR" }, { currency: "AIU" }, { source: "" }, { source: "secret\nvalue" },
    { asOf: undefined }, { asOf: "2026-02-30" }, { effectiveFrom: undefined },
    { effectiveUntil: "2026-08-01" }, { inputTokenAccounting: undefined },
    { inputTokenAccounting: "guess" }, { inputPerMillion: "2" }, { outputPerMillion: true },
    { inputPerMillion: -1 }, { outputPerMillion: Infinity }, { outputPerMillion: null },
    { cacheReadPerMillion: undefined }, { cacheWritePerMillion: undefined },
    { cacheReadPerMillion: -1 }, { inputPerMillion: Number.MAX_VALUE }
  ]) assert.equal(estimateUsd(usage, { [model]: { ...price, ...patch } }, timestamp), undefined, JSON.stringify(patch));
  for (const time of [undefined, "", "bad-date", "2026-02-30T00:00:00Z", "2026-08-31T23:59:59Z", "2026-10-01T00:00:00Z"]) {
    assert.equal(estimateUsd(usage, prices, time), undefined, String(time));
  }
  const noCache = { ...usage, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const withoutCacheRates = { ...price };
  delete withoutCacheRates.cacheReadPerMillion;
  delete withoutCacheRates.cacheWritePerMillion;
  assert.equal(estimateUsd(noCache, { [model]: withoutCacheRates }, timestamp).estimatedCost, 0.003);
  assert.equal(estimateUsd(usage, Object.create(prices), timestamp), undefined);
  assert.equal(estimateUsd(usage, { [model]: { ...price, inputPerMillion: Number.MIN_VALUE } }, timestamp), undefined);
  const longBasis = estimateUsd({ ...usage, model: "m".repeat(200) },
    { ["m".repeat(200)]: { ...price, source: "\\".repeat(256) } }, timestamp);
  assert.ok(longBasis.costBasis.length <= 2000);
});

test("real assistant.usage contract sends only safe observed fields under the existing parent", async () => {
  const { session, requests, adapter } = harness();
  session.emit(event({
    ...usage, duration: 123.5, cost: 9, copilotUsage: { totalNanoAiu: 987654 },
    apiCallId: "provider-sensitive-id", providerCallId: "another-private-id",
    prompt: "DO NOT EXPORT PROMPT", content: "DO NOT EXPORT RESPONSE", cacheDetailsReported: true
  }, { agentId: "session-sensitive-id" }));
  await adapter.flush();
  assert.equal(requests.length, 1);
  const { url, options, body } = requests[0];
  assert.equal(String(url), `http://localhost:5080/api/runs/${runId}/events`);
  assert.equal(options.method, "POST");
  assert.equal(options.redirect, "error");
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(body.type, 2);
  assert.equal(body.status, 1);
  assert.equal(body.parentEventId, parentEventId);
  assert.equal(body.agentName, "copilot-sdk-app");
  assert.equal(body.model, model);
  assert.equal(body.inputTokens, 1000);
  assert.equal(body.outputTokens, 100);
  assert.equal(body.startedAt, timestamp);
  assert.equal(body.endedAt, undefined);
  assert.equal(body.estimatedCost, undefined);
  assert.equal(body.costBasis, undefined);
  assert.equal(body.attributes["sdk.cacheReadCount"], "200");
  assert.equal(body.attributes["sdk.cacheWriteCount"], "100");
  assert.equal(body.attributes["sdk.durationMs"], "123.5");
  assert.equal(body.attributes["sdk.cacheDetailsReported"], "true");
  assert.doesNotMatch(JSON.stringify(body), /sensitive|PRIVATE|EXPORT|987654|apiCallId|providerCallId|totalNanoAiu|copilotUsage/i);
  await adapter.detach();
});

test("OTLP transport emits retry-stable GenAI usage with explicit task and chat attribution", async () => {
  const taskId = "12345678-1234-1234-1234-123456789abc";
  const sdkEventId = "abcdef12-3456-4789-abcd-ef1234567890";
  const { session, requests, adapter } = harness({
    transport: "otlp", prices, taskId, chatSessionId: "session-1", chatTurnId: "turn-1"
  });
  session.emit(event({ ...usage, prompt: "PRIVATE PROMPT", content: "PRIVATE RESPONSE" }, { id: sdkEventId }));
  await adapter.detach();
  assert.equal(requests.length, 1);
  const { url, body } = requests[0];
  assert.equal(String(url), "http://localhost:5080/v1/traces");
  const resource = body.resourceSpans[0];
  const span = resource.scopeSpans[0].spans[0];
  const values = Object.fromEntries([...resource.resource.attributes, ...span.attributes].map(attribute => [
    attribute.key, attribute.value.stringValue ?? Number(attribute.value.intValue ?? attribute.value.doubleValue)
  ]));
  assert.equal(span.traceId, runId.replaceAll("-", ""));
  assert.equal(span.spanId, sdkEventId.replaceAll("-", "").slice(0, 16));
  assert.equal(values["flightrecorder.run.id"], runId);
  assert.equal(values["flightrecorder.event.parent_id"], parentEventId);
  assert.equal(values["flightrecorder.task.id"], taskId);
  assert.equal(values["flightrecorder.chat.session_id"], "session-1");
  assert.equal(values["flightrecorder.chat.turn_id"], "turn-1");
  assert.equal(values["gen_ai.request.model"], model);
  assert.equal(values["gen_ai.usage.input_tokens"], 1000);
  assert.equal(values["gen_ai.usage.output_tokens"], 100);
  assert.ok(values["flightrecorder.estimated_cost"] > 0);
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE|PROMPT|RESPONSE/);
});

test("missing usage stays omitted, explicit zero survives, malformed numbers are never coerced", async () => {
  const { session, requests, adapter } = harness({ prices });
  session.emit(event({ model }));
  session.emit(event({ model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  session.emit(event({ model, inputTokens: -1, outputTokens: "100", cacheReadTokens: true, cacheWriteTokens: null }));
  session.emit(event({ inputTokens: 20, outputTokens: 2 }));
  session.emit(event({ model, inputTokens: 2147483647, outputTokens: 0 }, { timestamp: undefined }));
  await adapter.detach();
  assert.equal(requests.length, 5);
  for (const index of [0, 2]) {
    for (const field of ["inputTokens", "outputTokens", "estimatedCost", "costBasis"]) {
      assert.equal(Object.hasOwn(requests[index].body, field), false);
    }
  }
  assert.equal(requests[1].body.inputTokens, 0);
  assert.equal(requests[1].body.outputTokens, 0);
  assert.equal(requests[1].body.estimatedCost, 0);
  assert.ok(requests[1].body.costBasis);
  assert.equal(requests[3].body.model, undefined);
  assert.equal(requests[3].body.inputTokens, 20);
  assert.equal(requests[3].body.estimatedCost, undefined);
  assert.equal(requests[4].body.startedAt, undefined);
  assert.equal(requests[4].body.inputTokens, 2147483647);
});

test("REST payload always meets nullable usage and conditional pricing-basis validation", async () => {
  const cases = [
    { data: usage, config: prices, priced: true },
    { data: { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, config: prices, priced: true },
    { data: usage, config: undefined, priced: false },
    { data: { ...usage, model: undefined }, config: prices, priced: false },
    { data: { ...usage, inputTokens: undefined }, config: prices, priced: false },
    { data: { ...usage, outputTokens: null }, config: prices, priced: false },
    { data: { ...usage, cacheReadTokens: undefined }, config: prices, priced: false },
    { data: usage, config: { [model]: { ...price, currency: "AIU" } }, priced: false },
    { data: usage, config: { [model]: { ...price, source: "" } }, priced: false }
  ];
  for (const { data, config, priced } of cases) {
    const { session, requests, adapter } = harness({ prices: config });
    session.emit(event(data));
    await adapter.detach();
    const body = requests[0].body;
    assert.equal(Object.hasOwn(body, "estimatedCost"), priced);
    assert.equal(Object.hasOwn(body, "costBasis"), priced);
    if (priced) {
      assert.equal(typeof body.model, "string");
      assert.ok(body.model.trim().length > 0);
      for (const field of ["inputTokens", "outputTokens"]) {
        assert.ok(Number.isInteger(body[field]) && body[field] >= 0 && body[field] <= 2147483647);
      }
      assert.ok(Number.isFinite(body.estimatedCost) && body.estimatedCost >= 0);
      assert.equal(typeof body.costBasis, "string");
      assert.ok(body.costBasis.trim().length > 0 && body.costBasis.length <= 2000);
    }
  }
});

test("context occupancy, cumulative shutdown usage, and billing-only fields do not become usage", async () => {
  const { session, requests, adapter } = harness({ prices });
  session.emit(event({ currentTokens: 4000, tokenLimit: 128000, messagesLength: 5 }, { type: "session.usage_info" }));
  session.emit(event({ modelMetrics: { [model]: { usage } } }, { type: "session.shutdown" }));
  session.emit(event({ model, cost: 5, copilotUsage: { totalNanoAiu: 1000000000 } }));
  await adapter.detach();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.inputTokens, undefined);
  assert.equal(requests[0].body.estimatedCost, undefined);
});

test("event IDs and provider call IDs deduplicate locally without collapsing identical separate calls", async () => {
  const { session, requests, adapter } = harness();
  const first = event({ ...usage, apiCallId: "call-one" });
  session.emit(first);
  session.emit(structuredClone(first));
  session.emit(event({ ...usage, apiCallId: "call-one" }));
  session.emit(event({ ...usage, apiCallId: "call-two" }));
  session.emit(event(usage));
  session.emit(event(usage));
  await adapter.detach();
  assert.equal(requests.length, 4);
  assert.doesNotMatch(JSON.stringify(requests.map(r => r.body)), /call-one|call-two/);
});

test("sends are serialized, input is snapshotted, and flush waits for every accepted event", async () => {
  const pending = [];
  const bodies = [];
  let active = 0;
  let maximum = 0;
  const { session, adapter } = harness({ fetchImpl: async (_url, options) => {
    active++;
    maximum = Math.max(maximum, active);
    const body = JSON.parse(options.body);
    bodies.push(body);
    await new Promise(resolve => pending.push(resolve));
    active--;
    return Response.json({ ...body, id: randomUUID(), runId }, { status: 201 });
  } });
  const first = event();
  session.emit(first);
  first.data = { model, inputTokens: 999 };
  session.emit(event({ ...usage, inputTokens: 2000 }));
  let flushed = false;
  const flushing = adapter.flush().then(() => { flushed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bodies.length, 1);
  assert.equal(flushed, false);
  pending.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bodies.length, 2);
  pending.shift()();
  await flushing;
  assert.equal(maximum, 1);
  assert.equal(bodies[0].inputTokens, 1000);
  assert.equal(bodies[1].inputTokens, 2000);
  await adapter.detach();
});

test("detach is idempotent, drains queued writes, and never owns session or run completion", async () => {
  const { session, requests, adapter } = harness({ parentEventId: undefined });
  session.emit(event());
  const closing = adapter.detach();
  assert.equal(session.handlers.size, 0);
  session.emit(event());
  await closing;
  await adapter.detach();
  assert.equal(session.unsubscribes, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.parentEventId, undefined);
});

test("HTTP errors are sticky and observable through onError, flush, and detach without retries", async () => {
  let attempts = 0;
  const errors = [];
  const { session, adapter } = harness({
    fetchImpl: async () => { attempts++; return new Response("PRIVATE FAILURE BODY", { status: 503 }); },
    onError: error => errors.push(error)
  });
  session.emit(event());
  await assert.rejects(adapter.flush(), AggregateError);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /503/);
  assert.doesNotMatch(errors[0].message, /PRIVATE/);
  await assert.rejects(adapter.detach(), AggregateError);
  session.emit(event());
  assert.equal(attempts, 1);
});

test("OTLP transport rejects HTTP errors, malformed acknowledgements, and partial success", async () => {
  const cases = [
    async () => new Response(null, { status: 503 }),
    async () => new Response("not-json", { status: 200 }),
    async () => Response.json({ partialSuccess: { rejectedSpans: "1", errorMessage: "synthetic rejection" } })
  ];
  for (const fetchImpl of cases) {
    const { session, adapter } = harness({ transport: "otlp", fetchImpl });
    session.emit(event());
    await assert.rejects(adapter.detach(), AggregateError);
  }
});

test("transport rejection, invalid acknowledgements, and observer rejection never become unhandled", async () => {
  const cases = [
    async () => { throw new Error("connection failed"); },
    async () => new Response("invalid-json", { status: 201 }),
    async () => Response.json({ id: randomUUID(), runId: randomUUID(), type: 2 }, { status: 201 }),
    async () => new Response(null, { status: 204 }),
    async () => new Response("x".repeat(65537), { status: 201 })
  ];
  for (const fetchImpl of cases) {
    const { session, adapter } = harness({ fetchImpl, onError: async () => { throw new Error("observer failed"); } });
    session.emit(event());
    await assert.rejects(adapter.flush(), error => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors.length, 2);
      return true;
    });
    await assert.rejects(adapter.detach(), AggregateError);
  }
});

test("invalid acknowledgement contents are not included in surfaced errors", async () => {
  const errors = [];
  const { session, adapter } = harness({
    fetchImpl: async () => new Response("PRIVATE ACKNOWLEDGEMENT CONTENT", { status: 201 }),
    onError: error => errors.push(error)
  });
  session.emit(event());
  await assert.rejects(adapter.detach(), AggregateError);
  assert.doesNotMatch(errors[0].message, /PRIVATE|CONTENT/);
  assert.equal(errors[0].cause, undefined);
});

test("bounded timeout covers both fetch and response body consumption", async () => {
  for (const fetchImpl of [
    async () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start() {} }), { status: 201 })
  ]) {
    const errors = [];
    const { session, adapter } = harness({ requestTimeoutMs: 20, fetchImpl, onError: error => errors.push(error) });
    session.emit(event());
    await assert.rejects(adapter.flush(), AggregateError);
    assert.match(errors[0].message, /timed out/);
    await assert.rejects(adapter.detach(), AggregateError);
  }
});

test("queue and dedup bounds fail observably instead of evicting IDs or growing indefinitely", async () => {
  for (const overrides of [{ maxPending: 1 }, { maxEvents: 1 }]) {
    const { session, requests, adapter } = harness(overrides);
    session.emit(event());
    session.emit(event());
    await assert.rejects(adapter.flush(), AggregateError);
    assert.equal(requests.length, 1);
    assert.equal(session.handlers.size, 0);
    await assert.rejects(adapter.detach(), AggregateError);
  }
});

test("malformed supported events and failed unsubscribe are observable", async () => {
  const { session, adapter } = harness();
  session.emit(event(usage, { id: undefined }));
  await assert.rejects(adapter.flush(), AggregateError);
  await assert.rejects(adapter.detach(), AggregateError);
  const badSession = { on: () => () => { throw new Error("unsubscribe failed"); } };
  const badAdapter = attachCopilotUsage(badSession, { runId });
  await assert.rejects(badAdapter.detach(), AggregateError);
  await assert.rejects(badAdapter.flush(), AggregateError);
});

test("configuration accepts only explicit local origins and bounded valid options", () => {
  for (const serverUrl of [
    "https://example.com", "http://example.com", "https://localhost.example.com",
    "http://localhost@evil.example", "http://user:secret@localhost", "http://localhost/api",
    "http://localhost?key=secret", "http://localhost#fragment", "file:///C:/recorder"
  ]) assert.throws(() => harness({ serverUrl }), /loopback/i);
  for (const config of [
    { runId: "../run" }, { parentEventId: "not-uuid" }, { requestTimeoutMs: 0 },
    { requestTimeoutMs: Infinity }, { maxEvents: 0 }, { maxPending: true },
    { agentName: "private user\nname" }, { fetchImpl: 5 }, { onError: "ignore" },
    { transport: "grpc" }, { taskId: "not-uuid" }, { parentTaskId: runId },
    { chatTurnId: "private\nturn" }
  ]) assert.throws(() => harness(config));
  assert.throws(() => attachCopilotUsage({}, { runId }));
  assert.throws(() => attachCopilotUsage({ on() {} }, { runId }), /unsubscribe/);
});

test("native fetch writes a real loopback POST and never follows redirects", async () => {
  const received = [];
  let redirect = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push({ path: request.url, body });
    if (redirect) {
      response.writeHead(307, { location: "/must-not-follow" });
      response.end();
    } else {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ ...body, id: randomUUID(), runId }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const session = new Session();
    const adapter = attachCopilotUsage(session, { runId, parentEventId, serverUrl, prices });
    session.emit(event());
    await adapter.detach();
    assert.equal(received[0].path, `/api/runs/${runId}/events`);
    assert.ok(received[0].body.estimatedCost > 0);
    redirect = true;
    const second = attachCopilotUsage(session, { runId, serverUrl });
    session.emit(event());
    await assert.rejects(second.detach(), AggregateError);
    assert.equal(received.length, 2);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
