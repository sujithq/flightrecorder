# Optional feature guide

## Viewer, graph and policy inspection

Run `npm ci`, `npm run build:web`, then `dotnet run --project src/FlightRecorder.Api`.
Open <http://localhost:5205>. Choose a run from history and switch between
**Timeline**, **Agent graph**, **Policies** and **Compare**. The timeline's replay
controls step through stored events without rerunning tools.

The **Demo run** menu creates either a blocked or approved synthetic deployment
repair. Demo ingestion is enabled in Development; outside Development, explicitly
set `FlightRecorder__EnableDemo=true`. No external deployment, repository write or
permission grant occurs in either demo.

Graph edges come from `parentEventId`, which must reference an existing event in
the same run. Selecting an edge shows the delegated objective, source/destination
identity and duration; selecting a node shows status and the recorded event.
Policy filters distinguish allowed decisions from blocks and approval requests.
The viewer shows observable evidence, not hidden model reasoning.

**Compare** treats the selected run as the candidate and lets you choose another
run as the baseline. Events match by parent path, event type, agent, name and
occurrence number. Deltas are candidate minus baseline. Renamed operations appear
as added/removed; this is structural comparison, not semantic matching or re-execution.

## OpenTelemetry

The export menu downloads OTLP/HTTP JSON from
`GET /api/runs/{runId}/exports/otlp`. It includes one root span plus all recorded
events, valid trace/span IDs, timestamps, parent links, status and usage attributes.
Standard `gen_ai.*` attributes are used where applicable; experimental attributes
use the `flightrecorder.*` namespace.

To forward a trace, configure the collector's complete OTLP/HTTP JSON endpoint
before starting the API:

```powershell
$env:FlightRecorder__OtlpEndpoint = "http://localhost:4318/v1/traces"
dotnet run --project src/FlightRecorder.Api
```

Select **Send to collector**, or POST to the same export URL. The endpoint is
server-configured, not supplied by callers. HTTPS is required except for loopback
HTTP; redirects are disabled. Missing configuration returns 503, and collector
failures or rejected spans return 502. Forwarding is explicit, not automatic.
This implementation does not support OTLP/gRPC or collector authentication headers.

## VS Code panel

```powershell
npm run package:vscode
```

Install `artifacts/flight-recorder-0.1.0.vsix` through **Extensions: Install from
VSIX**. Start the API, set `flightRecorder.serverUrl` if it is not on port 5205,
then run **Flight Recorder: Open Recorder** or **Flight Recorder: Select Run**.
The extension embeds the same viewer rather than maintaining a separate UI.

Only localhost, 127.0.0.1 and ::1 origins are accepted, and workspace trust is
required. Remote workspaces use VS Code port forwarding through `asExternalUri`;
the forwarded frame must use HTTPS or loopback HTTP. No local-resource access is
granted to the panel, and its outer document cannot execute scripts.
The recorder must remain running. Reopen the panel after restarting it.

## GitHub summaries and checks

Generate Markdown from a recorded run without contacting GitHub:

```powershell
npm run github:summary -- --run-id <run-uuid> --url http://localhost:5205
```

Set `GITHUB_STEP_SUMMARY` or pass `--summary-file <path>` to append the Markdown to
a file. The summary includes metrics and bounded event evidence. Configure
`FlightRecorder__PublicBaseUrl` on the API to produce clickable viewer/event
links. Without it, event UUIDs remain visible. Use an HTTPS viewer URL, or loopback
HTTP for local use.

Publishing is opt-in and requires a token with `checks:write` supplied through
`GITHUB_TOKEN` by your credential manager or CI secret configuration:

```powershell
npm run github:summary -- --run-id <run-uuid> --publish --repo owner/repository --sha <full-commit-sha>
```

The token is sent only to `https://api.github.com`, never to the recorder. No token
is embedded in a URL, trace or check payload. The command creates a new check each
time it is invoked; it does not update previous checks. Failed runs map to
`failure`, policy interventions to `action_required`, and completed successful
runs to `success`. An active run produces an in-progress check. This publishes a
summary, not a pull request, and does not grant the agent any new permissions.

For a workflow with Node.js 24 and a reachable recorder, the local composite action
can write the job summary without a token:

```yaml
- uses: ./.github/actions/flight-recorder
  with:
    run-id: ${{ steps.agent.outputs.run_id }}
    server-url: http://localhost:5205
```

To also publish a check, grant the job `checks: write` and pass `publish: 'true'`
and `github-token: ${{ secrets.GITHUB_TOKEN }}`. Fork pull requests may not have
write permission; keep summary-only mode for those runs. A localhost viewer link
is useful only on the same machine, not from a remote GitHub runner.

## Recording privacy

- **MetadataOnly** omits run request content, objectives, input/output and arbitrary attributes. Retained metadata is redacted, and attributes use a small semantic allowlist.
- **Redacted** removes recognized secret assignments, authorization values, common token formats, email addresses, phone patterns and identifier patterns before storage. JSON bodies are parsed recursively; secret-keyed values are replaced.
- **Full** retains raw local content. The UI, API and comparisons expose it to anyone who can reach the service, so use this mode only with explicit approval and appropriate data.

`FlightRecorder:RedactionPatterns` accepts additional regular expressions in the
API configuration. For example, a synthetic organization identifier rule:

```json
{
  "FlightRecorder": {
    "RedactionPatterns": ["\\bDEMO-[0-9]{8}\\b"]
  }
}
```

Regex operations are time-bounded and replace the entire field on timeout.
Detection is best-effort and cannot identify every form of PII or secret.
OTLP, GitHub and badge exports always redact metadata and omit request bodies,
input/output, objectives and arbitrary attributes, even for Full-mode traces.
Changing patterns affects new ingestion and subsequent exports, not content that
has already been stored or exported.

There is no authentication, access-control enforcement, encryption-at-rest,
retention service or durable storage in this prototype. Do not expose it publicly
or treat recording mode as an authorization boundary. Keep the API on loopback.

## Badger2040

See [the USB companion guide](../integrations/badger2040/README.md). The non-W
Badger2040 works through its USB serial connection; Wi-Fi and cloud credentials
are not required. The device receives only a compact, redacted summary.

## Verification

Automated checks cover API/MCP behavior, graph hierarchy, concurrent recording,
redaction, OTLP wire data and forwarding errors, GitHub payloads and size limits,
comparison, badge framing/rendering, extension URL/CSP boundaries, and desktop/mobile
viewer workflows. Browser screenshots are generated under `artifacts/browser/`.
Physical badge operation, the native VS Code host and remote forwarding, and live
GitHub check publishing still require environment-specific acceptance checks.