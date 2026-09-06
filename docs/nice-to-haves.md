# Optional feature guide

## Viewer, graph and policy inspection

Run `docker compose up --build --detach` and open <http://localhost:5080>.
Choose a run from history and switch between
**Timeline**, **Agent graph**, **Policies** and **Compare**. The timeline's replay
controls step through stored events without rerunning tools.

The **Demo run** menu creates either a blocked or approved synthetic deployment
repair. Compose enables demo ingestion; it is also enabled in native Development.
Other deployments must explicitly set `FlightRecorder__EnableDemo=true`. No external deployment, repository write or
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

## Trace persistence

The API uses embedded SQLite inside the existing process. No database server,
extra container or hosted storage subscription is required. Docker stores
`/data/traces.db` and its journal in a named volume mounted at `/data`; the default
Compose project names it `flightrecorder_recorder-data`. The runtime user owns
the directory with owner-only permissions. Mount the directory, not just the
database file, so SQLite can write its journal.

The default retention is the latest **10 completed runs plus all unfinished runs**.
Completion means `endedAt` is recorded, not simply that a status is failed or
blocked. Completed runs are ordered by completion time, start time, then run ID.
Pruning happens in the same transaction as completion and at startup, not while
reading traces. Unfinished runs survive interruption without fabricated completion,
new events or replayed tool actions. They can continue recording under the same ID.
An unfinished status is not a liveness signal from the original agent.

Configuration:

| Setting | Default | Purpose |
| --- | --- | --- |
| `FlightRecorder:Storage:MaxCompletedRuns` | `10` | Positive count of completed runs to keep |
| `FlightRecorder:Storage:DataDirectory` | User-local application data / `FlightRecorder` | Absolute writable data directory for native runs |
| `FLIGHTRECORDER_MAX_COMPLETED_RUNS` | `10` | Compose override mapped to the API's retention setting |

Compose sets the data directory to `/data`. For native Windows runs the default
is `%LOCALAPPDATA%\FlightRecorder`; other platforms use .NET's
`Environment.SpecialFolder.LocalApplicationData`. Override native settings through
`FlightRecorder__Storage__DataDirectory` and `FlightRecorder__Storage__MaxCompletedRuns`.
Use a private directory outside the checkout and web root. Local and Docker defaults
are separate stores. This deployment supports one API instance per data directory,
not shared network filesystems or multiple replicas.

Change Docker retention with an environment variable and recreate the service:

```powershell
$env:FLIGHTRECORDER_MAX_COMPLETED_RUNS = "25"
docker compose up --detach
```

Lowering the limit deletes older completed traces on the next startup; increasing
it does not restore deleted data. Zero, negative or malformed limits and invalid
directories fail startup. The first deployment of persistence starts with a new
database; old in-memory history is not imported.

Run creation, every event and completion commit before success is returned.
SQLite uses transactions, rollback journaling and full synchronization. Disk-write
failures roll back and return a generic REST 503 or an MCP failed-tool result,
without exposing payloads or SQL parameters. Corrupt or unsupported databases fail
startup rather than being replaced with empty state. A crash after commit but
before a response reaches the client may still leave the write committed; retries
are not automatically deduplicated.

The volume survives API/container restarts, force recreation, and ordinary
`docker compose down`/`up`. `docker compose down -v`, explicit volume deletion,
Docker data reset or disk failure can destroy it. There is no backup system or
encryption-at-rest. SQLite may retain freed pages for reuse, so pruning does not
promise file shrinking or secure erasure. Unfinished runs are retained indefinitely:
the run limit is not a byte quota. Do not delete database or journal files while
the service is running; investigate storage errors before restarting it.

## OpenTelemetry

The export menu downloads OTLP/HTTP JSON from
`GET /api/runs/{runId}/exports/otlp`. It includes one root span plus all recorded
events, valid trace/span IDs, timestamps, parent links, status and usage attributes.
Standard `gen_ai.*` attributes are used where applicable; experimental attributes
use the `flightrecorder.*` namespace.

To forward a trace from Docker, configure `FlightRecorder__OtlpEndpoint` in the
recorder service's environment and recreate that service. Use a collector address
reachable from inside the container, not the host's loopback address.

For an explicitly chosen native development instance on port 5205, set the
collector's complete OTLP/HTTP JSON endpoint before starting that API:

```powershell
$env:FlightRecorder__OtlpEndpoint = "http://localhost:4318/v1/traces"
dotnet run --project src/FlightRecorder.Api
```

Use the native viewer at `http://localhost:5205` for this native example; its
configuration and database are separate from Docker's viewer on 5080.

Select **Send to collector**, or POST to the same export URL. The endpoint is
server-configured, not supplied by callers. HTTPS is required except for loopback
HTTP; redirects are disabled. Missing configuration returns 503, and collector
failures or rejected spans return 502. Forwarding is explicit, not automatic.
This implementation does not support OTLP/gRPC or collector authentication headers.

## VS Code panel

```powershell
npm run package:vscode
```

Install `artifacts/flight-recorder-0.1.1.vsix` through **Extensions: Install from
VSIX**. Start the Docker recorder; the panel defaults to `http://localhost:5080`,
then run **Flight Recorder: Open Recorder** or **Flight Recorder: Select Run**.
The extension embeds the same viewer rather than maintaining a separate UI.

After upgrading an older extension, reset a previously configured
`flightRecorder.serverUrl` or set it to `http://localhost:5080`. Explicit settings
are preserved and override the new default. Reopen the panel to load the new URL.

Only localhost, 127.0.0.1 and ::1 origins are accepted, and workspace trust is
required. Remote workspaces use VS Code port forwarding through `asExternalUri`;
the forwarded frame must use HTTPS or loopback HTTP. No local-resource access is
granted to the panel, and its outer document cannot execute scripts.
The recorder must remain running. Reopen the panel after restarting it.

## GitHub summaries and checks

Generate Markdown from a recorded run without contacting GitHub:

```powershell
npm run github:summary -- --run-id <run-uuid>
```

The CLI defaults to Docker at `http://localhost:5080`. `FLIGHTRECORDER_URL` can
override that origin; an explicit `--url` overrides the environment setting.

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
    server-url: http://localhost:5080
```

To also publish a check, grant the job `checks: write` and pass `publish: 'true'`
and `github-token: ${{ secrets.GITHUB_TOKEN }}`. Fork pull requests may not have
write permission; keep summary-only mode for those runs. A localhost viewer link
is useful only on the same machine, not from a remote GitHub runner.

## Recording privacy

- **MetadataOnly** omits run request content, objectives, input/output and arbitrary attributes. Retained metadata is redacted, and attributes use a small semantic allowlist.
- **Redacted** removes recognized secret assignments, authorization values, common token formats, email addresses, phone patterns and identifier patterns before storage. JSON bodies are parsed recursively; secret-keyed values are replaced.
- **Full** retains raw content in SQLite as well as the local viewer. The UI, API and comparisons expose it to anyone who can reach the service, and host administrators can read the stored data. Use this mode only with explicit approval and appropriate data.

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

Recording mode is preserved across restart. MetadataOnly and Redacted apply their
protections before persistence; Full is not silently redacted on disk. There is
no authentication, access-control enforcement or encryption-at-rest. Do not expose
the prototype publicly or treat recording mode as an authorization boundary.
Keep the API on loopback and protect access to its data directory and volume.

## Badger2040

See [the USB companion guide](../integrations/badger2040/README.md). The non-W
Badger2040 works through its USB serial connection; Wi-Fi and cloud credentials
are not required. The device receives only a compact, redacted summary.

## Verification

Automated checks cover API/MCP behavior, graph hierarchy, concurrent recording,
redaction, OTLP wire data and forwarding errors, GitHub payloads and size limits,
comparison, badge framing/rendering, extension URL/CSP boundaries, and desktop/mobile
viewer workflows. Browser screenshots are generated under `artifacts/browser/`.
Persistence tests additionally verify reopened database snapshots, concurrent
recording, retention, rollback on disk/database errors, corrupt schema rejection,
and REST/MCP failure behavior. `npm run test:persistence` tests the built Docker
image with its own disposable project and volume, including hard-crash recovery
and recreation. Test data never shares the user's default database.
Physical badge operation, the native VS Code host and remote forwarding, and live
GitHub check publishing still require environment-specific acceptance checks.