# Agent Flight Recorder

A privacy-conscious flight recorder for multi-agent workflows, with a browser/VS Code trace viewer, agent graph, policy inspection, run comparison, and portable exports.

## Run locally

Requires .NET 10 (see `global.json`) and Node.js 24 LTS. NuGet restores use the approved source in [NuGet.Config](NuGet.Config); npm uses its existing registry configuration.

```powershell
npm ci
npm run build:web
dotnet run --project src\FlightRecorder.Api
```

Open **http://localhost:5205**. The **Demo run** menu creates synthetic blocked or approved deployment-repair traces without performing external actions. Create both scenarios to compare their policy outcomes and costs.

## Nice-to-have features

| Feature | Available implementation |
| --- | --- |
| Agent graph | Recorded parent relationships, selectable connections, delegated objectives and identity changes |
| Policy visualization | Decision list, scope comparison, filters and evidence inspector |
| OpenTelemetry export | OTLP/HTTP JSON download and forwarding to a configured collector |
| VS Code panel | Shared viewer and run picker, packaged as a local VSIX |
| GitHub check summary | Job-summary CLI, reusable action and explicit opt-in Checks API publishing |
| Trace comparison | Matched events, changed fields and duration/token/cost/policy deltas |
| PII/secret redaction | Before-storage protection, JSON secret-key handling and configurable patterns |
| Badger2040 companion | USB serial bridge and MicroPython e-ink summary display |

See [feature setup and limitations](docs/nice-to-haves.md) and the [Badger2040 guide](integrations/badger2040/README.md).

## API

- `POST /api/runs` starts a run. Choose `MetadataOnly`, `Redacted`, or `Full` recording.
- `POST /api/runs/{runId}/events` records a structured event.
- `POST /api/runs/{runId}/complete` closes a run.
- `GET /api/runs/{runId}` returns the complete trace, including token, latency and cost totals.
- `GET /api/runs/{runId}/analysis` returns a deterministic, evidence-linked root-cause summary.
- `GET /api/runs` lists run summaries.
- `GET /api/runs/{runId}/graph` returns recorded nodes and edges.
- `GET /api/runs/{baselineId}/compare/{candidateId}` compares two stored traces.
- `GET /api/runs/{runId}/exports/otlp` downloads OTLP JSON; `POST` forwards it to the configured collector.
- `GET /api/runs/{runId}/exports/github` returns a GitHub check payload without a commit SHA.
- `GET /api/runs/{runId}/badge` and `GET /api/badger/latest` return compact device summaries.

The store is in-memory and resets when the process stops. There is no authentication or authorization layer: keep the prototype on loopback and use synthetic data. Recording policy decisions does not enforce permissions. Diagnosis is deterministic and evidence-linked, not a model-generated explanation. Full recording is opt-in and is not redacted in the local viewer.

## GitHub Copilot integration

The API exposes a Streamable HTTP MCP endpoint at `http://localhost:5205/mcp`. Repository configuration is included for both GitHub Copilot Chat in VS Code (`.vscode/mcp.json`) and GitHub Copilot CLI (`.mcp.json`).

Start the API, then select the repository's **flight-recorder** custom agent or ask Copilot to use the `flightrecorder` MCP tools. See [the getting-started guide](docs/getting-started.md#use-with-github-copilot-chat-in-vs-code) for setup and example prompts.

## Run with Docker

```powershell
docker build --tag flightrecorder:dev .
docker run --rm --publish 127.0.0.1:8080:8080 flightrecorder:dev
```

The viewer, REST API and MCP endpoint are then available through `http://localhost:8080`. Add `--env FlightRecorder__EnableDemo=true` to enable the synthetic demo menu in the production container.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes. Report suspected vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## Validate

```powershell
npm test
npm run test:badger
dotnet build FlightRecorder.slnx -c Release --artifacts-path artifacts/validation
dotnet test FlightRecorder.slnx -c Release --no-build --artifacts-path artifacts/validation
npm run test:e2e
npm run package:vscode
```

Python 3.11+ is needed only for badge tests. Browser tests use installed Edge on Windows; elsewhere run `npx playwright install chromium` first. Playwright starts the built API automatically, or targets `FLIGHTRECORDER_URL` when specified. The VSIX is written to `artifacts/flight-recorder-0.1.0.vsix`.

Squad is installed locally and pinned in the lockfile. Use `npm run squad:check` for diagnostics and `npm run squad -- --help` for its commands.
