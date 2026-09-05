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

## Validate

```powershell
dotnet restore FlightRecorder.slnx
dotnet build FlightRecorder.slnx -c Debug --no-restore
dotnet test FlightRecorder.slnx -c Debug --no-build
```
