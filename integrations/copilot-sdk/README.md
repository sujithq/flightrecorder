# Opt-in Copilot SDK usage capture

`usage.mjs` attaches to an **application-controlled `@github/copilot-sdk`
session**, sending observed model-call usage to an existing local Flight Recorder
run. It has no dependencies and does not import, install, start, or call the SDK.
This is **not** interception of VS Code's stock Copilot Chat. The VSIX cannot
obtain native Chat token counts or costs through this adapter. The repository's
`@github/copilot` dependency is the CLI, **not** `@github/copilot-sdk`.

## Supported SDK contract

Verified against the public **`github/copilot-sdk` v1.0.13** source:

- [Usage and billing guide](https://github.com/github/copilot-sdk/blob/v1.0.13/docs/features/usage-and-billing.md)
- [Generated event types](https://github.com/github/copilot-sdk/blob/v1.0.13/nodejs/src/generated/session-events.ts)
- [Session subscription API](https://github.com/github/copilot-sdk/blob/v1.0.13/nodejs/src/session.ts)
- [Node.js setup](https://github.com/github/copilot-sdk/blob/v1.0.13/nodejs/README.md)

The adapter calls `session.on("assistant.usage", handler)` and retains the returned
unsubscribe function. `assistant.usage` is emitted once per model API call,
including sub-agent calls. Its envelope has `id`, `timestamp`, `parentId`,
`ephemeral: true`, and `data`; `data.model` identifies the **observed** model.
Optional `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, and
`duration` are consumed as numbers, never parsed from response text.

`assistant.usage` is ephemeral: attach **before sending work**. Resuming a
session does not replay these events. An older SDK/runtime or an unavailable
usage field can produce no usable telemetry. A successful `flush()` only means
accepted events were delivered; it does **not** prove that the runtime emitted
usage for every call. There is no history scrape, usage polling, or synthetic
zero event when nothing is emitted.

These other SDK metrics are deliberately ignored:

- `session.usage_info`: **context-window occupancy**, not per-call consumption.
- `session.shutdown` / `session.usage.getMetrics`: **cumulative** metrics, which
  would double-count live events.
- `data.cost`: a premium-request/model multiplier, **not USD**.
- `data.copilotUsage.totalNanoAiu` and `models.list` billing prices: Copilot credit
  units, **not automatically convertible to USD**.

## Use in your SDK application

Copy `usage.mjs` into your application, or import it directly from this checkout.
Use an app where you have independently installed/configured `@github/copilot-sdk`
and its authentication/runtime prerequisites. Node.js **22.12+** meets this
adapter's and the referenced SDK's requirements. No SDK installation or paid
model call is needed to run this repository's adapter tests.

The following is a real application example, **not a test**: `sendAndWait` makes
a model call and can consume Copilot quota or incur charges. Provide an existing
run UUID and, when delegated, an already-recorded parent event UUID from that
same run. The run owner, not this adapter, creates and completes the run.

```js
import { readFile } from "node:fs/promises";
import { CopilotClient } from "@github/copilot-sdk";
import { attachCopilotUsage } from "./usage.mjs";

const model = process.env.COPILOT_MODEL;
const runId = process.env.FLIGHTRECORDER_RUN_ID;
if (!model || !runId) throw new Error("Supply COPILOT_MODEL and an existing run UUID.");
const prices = process.env.COPILOT_USD_PRICES_FILE
  ? JSON.parse(await readFile(process.env.COPILOT_USD_PRICES_FILE, "utf8"))
  : undefined; // token capture works without prices

const client = new CopilotClient();
let session;
let capture;
try {
  await client.start();
  session = await client.createSession({
    model,
    onPermissionRequest: () => ({
      kind: "denied-no-approval-rule-and-could-not-request-from-user"
    })
  });
  capture = attachCopilotUsage(session, {
    runId,
    parentEventId: process.env.FLIGHTRECORDER_PARENT_EVENT_ID,
    serverUrl: process.env.FLIGHTRECORDER_URL ?? "http://localhost:5080",
    prices,
    onError: error => console.error(error.message)
  });
  await session.sendAndWait({ prompt: "What is 2 + 2?" });
} finally {
  try {
    await capture?.detach(); // synchronously unsubscribe, then await flush
  } finally {
    try { await session?.disconnect(); }
    finally { await client.stop(); }
  }
}
// Only after successful flush/detach may the run owner complete the run.
// Never treat a caught capture error as successful recording.
```

The handler above denies permission requests rather than silently approving tool
execution. Supply your application's own permission policy if tools are needed.
The adapter never modifies the session's permissions or lifecycle.

## Explicit USD pricing (optional)

`prices` is an object keyed by the **exact observed `data.model`** string; there
is no alias, case-insensitive, selected-model, or wildcard fallback. Its values
have these fields:

| Field | Required meaning |
| --- | --- |
| `currency` | Exactly `"USD"` |
| `source` | Your non-sensitive price-source citation/label; printable ASCII, 1–256 characters |
| `asOf` | Date those prices were verified, `YYYY-MM-DD` |
| `effectiveFrom` | First applicable UTC date, inclusive, `YYYY-MM-DD` |
| `effectiveUntil` | Optional first inapplicable UTC date, exclusive |
| `inputTokenAccounting` | `"includes-cache"` or `"excludes-cache"`, verified for this provider/runtime |
| `inputPerMillion` | USD per million **uncached** input tokens |
| `outputPerMillion` | USD per million output tokens |
| `cacheReadPerMillion` | USD per million cache-read tokens; required for a nonzero observed read count |
| `cacheWritePerMillion` | USD per million cache-write tokens; required for a nonzero observed write count |

All rates must be finite JavaScript numbers from 0 through 1,000,000,000.
Strings, booleans, negative values, invalid dates, non-USD currencies, inherited
model keys, and incomplete evidence do not generate estimates. There are no
bundled price values, network price lookups, or assumed fallback rates. A price
with no end date remains applicable until the caller replaces it.

The SDK's generic input-token field does not specify a universal cache-inclusion
convention. **Verify this separately for the model/provider before configuring
pricing**:

- `includes-cache`: uncached input = input − cache read − cache write.
- `excludes-cache`: uncached input = input; cache read/write are additional
  separately priced categories.
- Estimated USD = `(uncached × input rate + output × output rate +
  cache read × read rate + cache write × write rate) / 1,000,000`.

Both cache counts must be explicitly observed, even if zero. Missing counts,
negative partitions, unknown cache semantics, or a cache TTL/tier that a single
configured write rate cannot accurately represent mean **withhold pricing**
(omit the model's price entry). The adapter does not infer zero from an absent
cache field or use the internal `cacheDetailsReported` flag to invent counts.
Provider-specific overlapping cache categories are unsupported unless the
chosen partition is verified. Cache evidence is recorded without adding it to
the SDK's input total; reasoning/prediction tokens are not added to output.

`estimateUsd(usageData, prices, observedTimestamp)` is a pure helper returning
`{ estimatedCost, costBasis }` or `undefined`. An observed timestamp inside the
configured effective interval and all four valid counts are required. Tiny
positive amounts below C# decimal precision are withheld rather than reported
as free. Floating-point results are **estimates**, not accounting-grade monetary
arithmetic or actual Copilot invoices.

Every supplied estimate, **including zero**, carries a top-level JSON-string
`costBasis` with model, currency, source, dates, accounting convention, and
rates. The emitted accounting key is `inputAccounting`; incoming configuration
still uses `inputTokenAccounting`. Cache evidence uses `sdk.cacheReadCount` and
`sdk.cacheWriteCount`. These metadata names avoid the recorder's general-purpose
secret-key redaction without weakening it. They are retained as allowlisted usage
metadata in MetadataOnly mode. The basis fits the recorder's 2,000-character limit. Missing estimates omit both
fields. Unknown means unknown; a zero requires observed zero usage or explicit
zero prices, not absence of data.

## Delivery, privacy, and lifecycle

- `attachCopilotUsage(session, options)` returns `{ flush, detach }`.
  `flush()` drains accepted events without unsubscribing; call it after work is
  idle. `detach()` unsubscribes immediately, drains, and is idempotent.
- Events are serialized POSTs to `/api/runs/{runId}/events` with `type: 2`
  (`ModelCall`), `status: 1` (`Succeeded` usage observation), optional parent
  UUID, and the non-sensitive role `copilot-sdk-app` by default.
- Known input/output counts must be integer numbers in `0..2147483647`.
  Missing/null/invalid counts are omitted, not coerced. Invalid field **names**
  are noted in attributes without their values. A missing/invalid model does
  not prevent recording valid counts, but prevents pricing.
- `startedAt` uses the valid SDK **usage event's emission timestamp**, not a
  claimed model-call start. No end/start duration is invented. An observed
  `duration` is kept separately as `sdk.durationMs`; cache counts and the
  optional boolean `cacheDetailsReported` are also attributes.
- No prompts, responses, credentials, repository paths, SDK session/agent
  identities, provider request IDs, or raw event payloads are sent. Event UUIDs
  and `(model, apiCallId)` keys are retained **locally only** for deduplication.
  Do not attach two adapters to the same work/run: deduplication is per adapter,
  not persistent across restarts. Identical counts on distinct calls are kept.
- Only loopback HTTP(S) origins (`localhost`, `127.0.0.1`, `[::1]`) are allowed.
  The default is `http://localhost:5080`; a native server can be explicitly set
  to `http://localhost:5205`. Remote origins, embedded credentials, paths,
  queries, and fragments are rejected. Redirects are errors. Use only a trusted
  local recorder; its normal redaction/metadata recording policy still applies.
- `requestTimeoutMs` defaults to 15,000 (allowed 1–60,000), covering fetch **and**
  response-body reads. A successful acknowledgement must be HTTP 201 with an
  event UUID, matching run, parent, type, and name; its body is capped at 64 KiB.
  No response body is included in error messages.
- `maxPending` defaults to 256 (maximum 10,000); `maxEvents` defaults to 10,000
  (maximum 100,000). Reaching either bound fails visibly instead of silently
  evicting dedup keys or allowing unbounded intake.
- Capture/delivery failures stop new intake; already accepted events still
  receive one serialized send attempt. Failures remain observable on every
  `flush()`/`detach()` as `AggregateError`. Optional `onError(error)` is also
  observed, and its exceptions join the aggregate; keep that callback bounded.
  SDK listeners themselves return synchronously, avoiding ignored rejected
  listener promises. The adapter never automatically retries: a timeout or bad
  acknowledgement can occur **after** storage, so blindly retrying may duplicate
  evidence. Inspect the existing run and report the gap to its owner.
- `fetchImpl` is an optional **trusted application/test seam**, defaulting to
  native `fetch`. A custom implementation must honor the supplied local URL,
  `redirect: "error"`, and `AbortSignal`; never inject an untrusted transport.
  Callers must sanitize configured model/role/source labels and own recorder
  availability, recording consent, run/parent authorization, and completion.

## Validation

From the repository root:

```powershell
node --test tests\integrations\copilot-usage.test.mjs
```

Tests emulate the documented SDK envelope and typed subscription contract and
exercise a real loopback HTTP server. They make no model calls and require no
SDK installation. They do not claim a live SDK/runtime end-to-end verification.
