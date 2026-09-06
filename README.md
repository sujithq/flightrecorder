# Agent Flight Recorder

A privacy-conscious flight recorder for multi-agent workflows, with a browser/VS Code trace viewer, agent graph, policy inspection, run comparison, and portable exports.

## Install with VS Code

Download the VSIX and checksum from a published [GitHub release](https://github.com/sujithq/flightrecorder/releases),
install it with **Extensions: Install from VSIX**, then run **Flight Recorder: Set Up Local Recorder**.
The extension bundles version-matched source, checks Docker/Compose prerequisites, and builds and runs
the API, viewer, and MCP endpoint after confirmation. No repository clone or host SDKs are required.

Setup supports local desktop VS Code 1.101+ on Windows, macOS, and Linux. Missing Docker produces
installation/startup guidance rather than a privileged installer. Builds need network access for uncached
images and packages and honor [NuGet.Config](NuGet.Config). Restart with Docker defaults to **off**;
Copilot MCP registration is also opt-in. Traces persist in a dedicated Docker volume.
See the [extension installation guide](extensions/flight-recorder/README.md) for management and recovery.

**Already installed, with an empty folder open?** Follow the
[first-trace quickstart](extensions/flight-recorder/README.md#quickstart-an-empty-folder-to-your-first-trace):
start the recorder, connect normal Copilot Agent mode, paste the first-task prompt,
and inspect the saved run. No repository checkout or manual MCP files are needed;
connecting tools alone does not start recording.

## Start with Docker from a checkout

Docker Compose runs the API, MCP endpoint and viewer together. No manually started native API is needed.

```powershell
docker compose up --build --detach
```

Open **http://localhost:5080**. The **Demo run** menu creates synthetic blocked or approved deployment-repair traces without performing external actions. Create both scenarios to compare their policy outcomes and costs.

## Nice-to-have features

| Feature | Available implementation |
| --- | --- |
| Agent graph | Recorded parent relationships, selectable connections, delegated objectives and identity changes |
| Policy visualization | Decision list, scope comparison, filters and evidence inspector |
| OpenTelemetry export | OTLP/HTTP JSON download and forwarding to a configured collector |
| VS Code extension | Bundled local Docker setup, lifecycle controls, optional MCP connection, shared viewer and run picker |
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

The API stores traces in embedded SQLite, with no separate database server or hosting fee. It retains the latest 10 completed runs by default and all unfinished runs. There is no authentication or authorization layer: keep the prototype on loopback and use synthetic data. Recording policy decisions do not enforce permissions. Diagnosis is deterministic and evidence-linked, not a model-generated explanation. Full recording is opt-in and remains unredacted in both the viewer and stored trace.

## GitHub Copilot integration

The Docker service exposes a Streamable HTTP MCP endpoint at `http://localhost:5080/mcp`. Repository configuration targets this endpoint for both GitHub Copilot Chat in VS Code ([.vscode/mcp.json](.vscode/mcp.json)) and GitHub Copilot CLI ([.mcp.json](.mcp.json)). A native `dotnet run` still defaults to port 5205; use `--urls http://localhost:5080` to match the MCP configuration when Docker is stopped.

Use the VSIX's **Connect to Copilot** command after local setup, or start the checkout's Docker service and enable its existing MCP configuration. Avoid registering the same endpoint twice. The [shared local recording policy](.github/copilot-instructions.md#local-flight-recorder-policy) instructs local Copilot agents that load it to record substantive tasks, including in normal Agent mode; selecting the **flight-recorder** custom agent is optional. The top-level agent owns the run and passes recording context to delegates. Installing the VSIX does not copy this repository's instructions into other projects. Recording is best-effort and agent-reported, not automatic interception, and requires a trusted server and permitted tools. See [the getting-started guide](docs/getting-started.md#use-with-github-copilot-chat-in-vs-code) for setup and example prompts.

## Automatic startup with Docker

These commands operate on the checkout's Compose deployment, not the separately owned VSIX installation.
For a VSIX installation use **Configure Restart with Docker**, which defaults to off and optionally selects
`unless-stopped`. Neither approach configures operating-system startup for Docker.

```powershell
docker compose up --build --detach
```

The [Compose service](compose.yaml) hosts the viewer, API and MCP endpoint at **http://localhost:5080**, bound to loopback only. It enables synthetic demos and uses `restart: unless-stopped`, so Docker restarts the existing container when its engine starts or the API process exits. No separate native API, Node.js service, database, OTLP collector or open terminal is required.

On Windows, enable Docker Desktop's **Start Docker Desktop when you sign in** setting. After the first Compose startup, Windows sign-in starts Docker Desktop and Docker starts the recorder. This is sign-in startup, not a guarantee that it runs before anyone logs in. Do not use `docker run --rm` for this service: an automatically removed container cannot restart.

The VS Code panel, optional helper scripts and GitHub summary action all default to `http://localhost:5080`. Explicit `flightRecorder.serverUrl`, `FLIGHTRECORDER_URL`, `--url` and action `server-url` overrides still take precedence. Reset any stale override to use Docker. After upgrading the extension, reopen its panel; an already open frame may still show its previous URL.

```powershell
docker compose ps
docker compose logs --tail 50 recorder
docker compose stop
docker compose start
```

`stop` deliberately disables automatic restart until `start` or `up` is run again. `docker compose down` removes the service entirely. To rebuild after code changes, rerun `docker compose up --build --detach`.

Run history is stored in `/data/traces.db` on the `recorder-data` named volume. It survives API crashes, Docker restarts, image updates, container recreation, and `docker compose down` followed by `up`. The container runs as its existing non-root user, with an owner-only data directory. Stop any older recorder container bound to port 5080 before the first Compose startup.

## Native development

Native execution is an explicit alternative for debugging the API. It requires .NET 10 (see `global.json`) and Node.js 24 LTS. NuGet restores use the approved source in [NuGet.Config](NuGet.Config); npm uses its existing registry configuration.

```powershell
npm ci
npm run build:web
dotnet run --project src\FlightRecorder.Api --launch-profile http
```

This development profile listens on `http://localhost:5205`. Use that URL explicitly in the panel or helpers when inspecting native runs. Repository MCP clients still target Docker on `5080`; to test the native API through those unchanged configurations, stop the Docker recorder first and add `--urls http://localhost:5080` to the native command. Docker's internal port `8080` and the isolated browser-test port `5081` are separate and should not be changed.

## Trace retention

Completed runs have an `endedAt` value, regardless of success, failure or a policy block. The newest 10 are retained by completion time, then start time and run ID for deterministic ties. All unfinished runs remain, including interrupted workflows, so the total can exceed 10. An unfinished status does not prove the original agent is still running; the same run ID can receive more events or be explicitly completed through the existing API/MCP tools.

To retain a different number in Docker:

```powershell
$env:FLIGHTRECORDER_MAX_COMPLETED_RUNS = "25"
docker compose up --detach
```

The setting must be positive and takes effect when the container is recreated. Omit it to use 10. Completion and startup enforce the limit; reducing it deletes older completed runs, while increasing it cannot restore deleted traces. Pruned run IDs return not found. Every successful recording operation is committed before its response; storage failures do not silently fall back to memory.

Native `dotnet run` uses the current user's local application data directory (`%LOCALAPPDATA%\FlightRecorder\traces.db` on Windows). Override it with an absolute `FlightRecorder__Storage__DataDirectory` and set `FlightRecorder__Storage__MaxCompletedRuns` for native retention. Docker and native defaults use separate databases; do not point concurrent instances at the same directory.

**The first upgrade from the old in-memory service starts fresh; existing volatile history is not imported.** Persistence applies to runs recorded after deployment. Keep the named volume: `docker compose down -v`, explicit volume deletion, or Docker data reset can erase history. A volume is not a backup and does not protect against disk/machine loss. Retention is a run-count limit, not a disk quota or secure deletion guarantee; unfinished traces can keep growing. See [storage and privacy details](docs/nice-to-haves.md#trace-persistence).

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

Python 3.11+ is needed only for badge tests. Browser tests use installed Edge on Windows; elsewhere run `npx playwright install chromium` first. Playwright starts the built API on port 5081 with a temporary database and does not reuse the Docker service on 5080. Setting `FLIGHTRECORDER_URL` explicitly targets that server and may change its trace history. The VSIX is written to `artifacts/flight-recorder-0.1.1.vsix`; install it with **Extensions: Install from VSIX** to update an older panel extension.

After `docker compose build recorder`, run `npm run test:persistence` to check crash recovery, recreation and configurable retention using a disposable Docker project, volume and random loopback port. It does not modify the running recorder or its volume.

Squad is installed locally and pinned in the lockfile. Use `npm run squad:check` for diagnostics and `npm run squad -- --help` for its commands.
