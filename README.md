# Agent Flight Recorder

A small, privacy-conscious flight recorder for multi-agent workflows. The MVP records structured run, agent, model, tool and policy events and exposes an evidence-linked trace API.

## Run locally

```powershell
dotnet run --project src\FlightRecorder.Api
```

## API

- `POST /api/runs` starts a run. Choose `MetadataOnly`, `Redacted`, or `Full` recording.
- `POST /api/runs/{runId}/events` records a structured event.
- `POST /api/runs/{runId}/complete` closes a run.
- `GET /api/runs/{runId}` returns the complete trace, including token, latency and cost totals.
- `GET /api/runs/{runId}/analysis` returns a deterministic, evidence-linked root-cause summary.
- `GET /api/runs` lists run summaries.

The current store is in-memory to keep the prototype easy to run. The service boundary is intentionally isolated so a durable or OpenTelemetry-backed store can be added without changing the controller contract.

## GitHub Copilot integration

The API exposes a Streamable HTTP MCP endpoint at `http://localhost:5205/mcp`. Repository configuration is included for both GitHub Copilot Chat in VS Code (`.vscode/mcp.json`) and GitHub Copilot CLI (`.mcp.json`).

Start the API, then select the repository's **flight-recorder** custom agent or ask Copilot to use the `flightrecorder` MCP tools. See [the getting-started guide](docs/getting-started.md#use-with-github-copilot-chat-in-vs-code) for setup and example prompts.

## Run with Docker

```powershell
docker build --tag flightrecorder:dev .
docker run --rm --publish 8080:8080 flightrecorder:dev
```

The REST API and MCP endpoint are then available through `http://localhost:8080`.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes. Report suspected vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## Validate

```powershell
dotnet restore FlightRecorder.slnx
dotnet build FlightRecorder.slnx -c Debug --no-restore
dotnet test FlightRecorder.slnx -c Debug --no-build
```
