# Agent Flight Recorder: Getting Started

Start with the installed-extension quickstart below. The later sections also show
how to operate a repository deployment and record a run directly using PowerShell.

## Already installed: start in an empty folder

Use the [empty-folder quickstart](../extensions/flight-recorder/README.md#quickstart-an-empty-folder-to-your-first-trace)
for the exact Command Palette actions, setup choices, Copilot tool checks, and a
copyable prompt that creates your first recorded task. It works without cloning
this repository or creating MCP files.

The sequence is **Set Up Local Recorder -> Connect to Copilot -> ask Agent mode to
record a task -> Select Run**. A running service and connected MCP tools do not
automatically record work. In another project, use the explicit prompt or add that
project's own recording policy; this repository's instructions are not inherited.

## Install without cloning the repository

Install the VSIX from a published [GitHub release](https://github.com/sujithq/flightrecorder/releases)
using **Extensions: Install from VSIX**, then invoke **Flight Recorder: Set Up Local Recorder**
in a trusted local desktop window. The bundled API/web source is built inside Docker;
host Git, Node.js, and .NET are not required.

Setup checks Docker, Compose v2, a local Docker endpoint, and a running Linux-container engine.
If something is missing, follow the platform-specific guide and retry. The extension does not
install Docker, elevate permissions, switch contexts, or configure OS startup.
Uncached image/package downloads require network access; restores honor the bundled
[NuGet.Config](../NuGet.Config).

Confirm the port and build before resources are created. Restart is off by default, with an
optional `unless-stopped` policy when Docker itself starts. The extension preserves trace storage
and offers explicit lifecycle/status/log commands. It does not start services on activation.
Existing port occupants can be explicitly reused when verified, or avoided by choosing another port;
unowned services are never stopped or replaced.

Optionally choose **Connect to Copilot** after setup. Approve the MCP server and tools in VS Code,
or skip this if you already configured that endpoint manually. Workspace MCP/instruction files
and Copilot CLI configuration are not changed.

See the [extension guide](../extensions/flight-recorder/README.md) for checksums, installation
prerequisites, remote-viewer limitations, upgrades, and troubleshooting. The examples below use
port 5080; substitute the selected local port if you changed it.

## 1. Start the Docker recorder

If you used VSIX setup, the API is already running; do not also start the checkout's deployment
on the same port. For repository development, with Docker running, execute this from the repository root:

```powershell
docker compose up --build --detach
```

The API and viewer listen at `http://localhost:5080`, and MCP is available at `http://localhost:5080/mcp`. The container runs independently of this terminal and restarts when Docker starts unless explicitly stopped. Do not start a separate native API for the examples in this guide. The viewer's **Demo run** menu creates synthetic blocked and approved runs for graph, policy and comparison exploration. See [the optional feature guide](nice-to-haves.md) for OTLP, GitHub, VS Code and Badger2040 setup.

The Docker volume preserves the latest 10 completed runs and all unfinished runs across restarts. Repository MCP configurations, the VS Code panel and helper scripts all default to Docker on 5080. See [retention configuration](nice-to-haves.md#trace-persistence) before changing the limit or deleting a volume. [Native development](../README.md#native-development) is a separate, explicit alternative with its own database.

## 2. Start a recorded run

From PowerShell, run:

```powershell
$run = Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:5080/api/runs `
  -ContentType application/json `
  -Body (@{
    request = "Investigate failed deployment"
    entryPointAgent = "orchestrator"
    requestingIdentity = "developer"
    recordingMode = 1
  } | ConvertTo-Json)

$runId = $run.id
$runId
```

Recording modes:

| Value | Mode | Behavior |
|---:|---|---|
| `0` | MetadataOnly | Omits request content, objectives, input/output and non-allowlisted attributes; redacts retained metadata |
| `1` | Redacted | Redacts known PII/secret patterns across requests, event content and metadata before storage |
| `2` | Full | Retains unredacted content in memory and on disk; use only with explicitly approved synthetic or non-sensitive data |

## 3. Record an agent event

```powershell
$agentEvent = Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:5080/api/runs/$runId/events" `
  -ContentType application/json `
  -Body (@{
    type = 1
    name = "deployment-investigation"
    status = 1
    agentName = "diagnostic-agent"
    agentVersion = "1.0"
    objective = "Determine why deployment failed"
  } | ConvertTo-Json)
```

Event types:

| Value | Type |
|---:|---|
| `0` | Run |
| `1` | AgentSpan |
| `2` | ModelCall |
| `3` | ToolCall |
| `4` | PolicyDecision |

## 4. Record a model call

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:5080/api/runs/$runId/events" `
  -ContentType application/json `
  -Body (@{
    type = 2
    name = "analyze-logs"
    parentEventId = $agentEvent.id
    status = 1
    model = "gpt-5"
    inputTokens = 800
    outputTokens = 200
    estimatedCost = 0.02
    costBasis = "Synthetic USD example estimate, not real provider pricing"
    input = "Analyze deployment logs"
    output = "Deployment failed because approval was missing"
  } | ConvertTo-Json)
```

## 5. Record a policy failure

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:5080/api/runs/$runId/events" `
  -ContentType application/json `
  -Body (@{
    type = 4
    name = "production-deployment"
    parentEventId = $agentEvent.id
    status = 3
    requestedScope = "deployments:write"
    grantedScope = "deployments:read"
    policyName = "production-approval"
    policyReason = "Explicit production approval is required"
  } | ConvertTo-Json)
```

Event statuses:

| Value | Status |
|---:|---|
| `0` | Started |
| `1` | Succeeded |
| `2` | Failed |
| `3` | Blocked |
| `4` | RequiresApproval |

## 6. Complete the run

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:5080/api/runs/$runId/complete"
```

## 7. View the complete trace

```powershell
Invoke-RestMethod "http://localhost:5080/api/runs/$runId" |
  ConvertTo-Json -Depth 10
```

The trace includes all events and aggregate duration, token, cost, and status information. Open `http://localhost:5080/?run=<runId>` to inspect it visually. An optional `parentEventId` must refer to an event already recorded in the same run; this preserves actual hierarchy instead of guessing delegation from agent names.

## 8. View the root-cause analysis

```powershell
Invoke-RestMethod "http://localhost:5080/api/runs/$runId/analysis" |
  ConvertTo-Json -Depth 10
```

The analysis identifies the primary failure or policy intervention and links the conclusion to recorded event IDs.

## 9. List recorded runs

```powershell
Invoke-RestMethod http://localhost:5080/api/runs |
  ConvertTo-Json -Depth 10
```

## Real-world example: coding agent blocked from creating a pull request

In this scenario, a coding agent receives a request, inspects the repository, changes the code, runs the tests successfully, and then attempts to create a pull request. The pull request operation is blocked because the agent only has read access.

Start the Docker recorder as above, then run the following complete script in PowerShell:

```powershell
$baseUrl = "http://localhost:5080/api"

# Start the run using redacted recording so common secret values are removed.
$run = Invoke-RestMethod `
  -Method Post `
  -Uri "$baseUrl/runs" `
  -ContentType application/json `
  -Body (@{
    request = "Fix issue #42 and open a pull request"
    entryPointAgent = "coding-agent"
    requestingIdentity = "developer@example"
    recordingMode = 1
  } | ConvertTo-Json)

$runId = $run.id
Write-Host "Recording run $runId"

# Record the agent beginning its work.
$agentStart = Invoke-RestMethod `
  -Method Post `
  -Uri "$baseUrl/runs/$runId/events" `
  -ContentType application/json `
  -Body (@{
    type = 1
    name = "implement-issue"
    status = 0
    agentName = "coding-agent"
    agentVersion = "1.0"
    identity = "github-app:flight-recorder-demo"
    objective = "Fix issue #42, validate the change, and create a pull request"
  } | ConvertTo-Json)

# Record a model call used to plan the implementation.
$modelCall = Invoke-RestMethod `
  -Method Post `
  -Uri "$baseUrl/runs/$runId/events" `
  -ContentType application/json `
  -Body (@{
    type = 2
    name = "plan-code-change"
    status = 1
    agentName = "coding-agent"
    model = "gpt-5"
    inputTokens = 1250
    outputTokens = 340
    estimatedCost = 0.018
    costBasis = "Synthetic USD example estimate, not real provider pricing"
    input = "Issue text and repository context; api_key=demo-secret"
    output = "Update the service, add regression tests, and run the targeted test project."
  } | ConvertTo-Json)

# Record the repository inspection tool call.
$inspection = Invoke-RestMethod `
  -Method Post `
  -Uri "$baseUrl/runs/$runId/events" `
  -ContentType application/json `
  -Body (@{
    type = 3
    name = "inspect-repository"
    status = 1
    agentName = "coding-agent"
    toolServer = "local-shell"
    identity = "github-app:flight-recorder-demo"
    input = "git status --short"
    output = "Working tree inspected successfully"
    attributes = @{
      repository = "example/checkout-service"
      branch = "fix/issue-42"
    }
  } | ConvertTo-Json -Depth 5)

# Record the successful test execution.
$tests = Invoke-RestMethod `
  -Method Post `
  -Uri "$baseUrl/runs/$runId/events" `
  -ContentType application/json `
  -Body (@{
    type = 3
    name = "run-tests"
    status = 1
    agentName = "coding-agent"
    toolServer = "local-shell"
    input = "dotnet test"
    output = "Passed: 128, Failed: 0"
    attributes = @{
      passed = "128"
      failed = "0"
    }
  } | ConvertTo-Json -Depth 5)

# Record the policy decision that blocks pull request creation.
$policyDecision = Invoke-RestMethod `
  -Method Post `
  -Uri "$baseUrl/runs/$runId/events" `
  -ContentType application/json `
  -Body (@{
    type = 4
    name = "create-pull-request"
    status = 3
    agentName = "coding-agent"
    toolServer = "github"
    identity = "github-app:flight-recorder-demo"
    requestedScope = "pull_requests:write"
    grantedScope = "contents:read"
    policyName = "repository-write-approval"
    policyReason = "Repository write actions require explicit approval"
  } | ConvertTo-Json)

# Close the run.
Invoke-RestMethod `
  -Method Post `
  -Uri "$baseUrl/runs/$runId/complete"

# Display the resulting trace and deterministic analysis.
$trace = Invoke-RestMethod "$baseUrl/runs/$runId"
$analysis = Invoke-RestMethod "$baseUrl/runs/$runId/analysis"

$trace | ConvertTo-Json -Depth 10
$analysis | ConvertTo-Json -Depth 10
```

### What this example demonstrates

The resulting trace shows that:

1. The coding agent received a concrete objective and identity.
2. The model call consumed tokens and incurred an estimated cost.
3. Repository inspection and all 128 tests succeeded.
4. Pull request creation requested `pull_requests:write`, but only `contents:read` was granted.
5. The run was therefore marked as blocked rather than failed.
6. The analysis identifies `create-pull-request` as the primary failure and links it to the successful test event.
7. Because the run uses redacted recording, `api_key=demo-secret` is stored as `api_key=[REDACTED]`.

This makes it possible to distinguish a code failure from an authorization or governance failure without relying on unstructured logs.

## GitHub Copilot integration

The Docker API exposes a Streamable HTTP Model Context Protocol (MCP) endpoint at `http://localhost:5080/mcp`. Copilot can use the endpoint as six tools:

- `flightrecorder/start_flight_run`
- `flightrecorder/record_flight_event`
- `flightrecorder/complete_flight_run`
- `flightrecorder/get_flight_trace`
- `flightrecorder/analyze_flight_run`
- `flightrecorder/list_flight_runs`

The [shared local recording policy](../.github/copilot-instructions.md#local-flight-recorder-policy) instructs ordinary Copilot, custom agents, and Squad agents whose host loads it to record substantive local tasks in VS Code or Copilot CLI. It does not automatically apply recording to cloud/CI sessions or casual questions, and users can opt out. Instructions do not configure the server, enable tools, or override permissions.

The [flight-recorder custom agent](../.github/agents/flight-recorder.agent.md) remains an optional explicit entry point for recorded work and trace diagnosis. It references the shared policy instead of maintaining a separate recording procedure. Recording is best-effort: Copilot explicitly calls the MCP tools as it works; the Flight Recorder does not intercept Copilot traffic automatically.

The top-level agent starts and owns one run. Before delegation, it records an `AgentSpan` and passes the run ID, the span's event ID as `parentEventId`, ownership, and recording rules to the delegate. Delegates contribute to that run rather than starting or completing their own. Restricted delegates return sanitized evidence for the owner to record with attribution. Only the owner completes the run after all contributors finish, then analyzes it. Inspecting an existing trace does not start or complete a run.

### Start the shared MCP server

Either use **Set Up Local Recorder** in the VSIX, or run the repository Compose deployment below.
Both clients can connect to the same selected service; repository configurations default to port 5080.
Ensure it is running before opening a recording session:

```powershell
docker compose up --build --detach
```

No separate `dotnet run` or open terminal is required. The MCP endpoint is local and unauthenticated, so keep the Compose loopback binding. After changing an MCP configuration, restart that client connection so it loads the new URL.

### Use with GitHub Copilot Chat in VS Code

The self-contained VSIX requires VS Code 1.101 or later, GitHub Copilot access for agent tools,
and an organization policy that permits MCP servers when applicable. After VSIX setup, use
**Connect to Copilot** to register the endpoint without editing files. Approve it using
**MCP: List Servers** and the tools picker.

For the repository's existing manual MCP configuration instead:

1. Open the repository root in VS Code. VS Code discovers `.vscode/mcp.json`.
2. Open `.vscode/mcp.json` and click **Start** above the `flightrecorder` server, or run **MCP: List Servers** from the Command Palette and start it there.
3. Approve the server when VS Code asks whether you trust it.
4. Open Copilot Chat.
5. Use normal **Agent** mode or a custom agent that loads the repository instructions and has recorder access. Optionally select **flight-recorder** for an explicit recorded workflow. If it is not listed, reload the VS Code window after pulling the agent file.
6. Enter a normal development request, for example:

   > Fix issue #42, run the relevant tests, and explain any operation that is blocked.

7. Approve MCP tool calls when prompted.
8. The run owner returns the run ID and trace summary after completing the task and collecting delegated evidence. If recording is unavailable or incomplete, it reports that limitation instead. Ask `Show the full Flight Recorder trace for that run` to inspect the recorded evidence.

No special recording prompt is required when the local agent loads and follows the shared policy. You can still request recording explicitly:

> Record this task with Flight Recorder using the repository's shared local recording policy.

Use the tools button in Copilot Chat to confirm that the run owner has the required `flightrecorder` tools enabled. Do not broaden a read-only delegate's permissions just to record evidence.

### Use with GitHub Copilot CLI

Copilot CLI discovers the repository-level `.mcp.json` when it starts within this repository.

1. In a second terminal, change to the repository root and start Copilot CLI:

   ```powershell
   copilot
   ```

2. Confirm folder trust if prompted. Project MCP servers are skipped in untrusted directories.
3. Verify the server and tools:

   ```text
   /mcp show flightrecorder
   ```

4. Continue with the default agent, or optionally select the repository custom agent:

   ```text
   /agent
   ```

   Choose **flight-recorder**. Restart Copilot CLI first if the agent was added while the CLI was already running.

5. Enter a normal task, for example:

   > Fix issue #42, run the relevant tests, and explain any operation that is blocked.

6. Approve tool calls when prompted. Under the shared policy, the run owner completes and analyzes the trace after all contributors finish, or reports recording limitations.

You can also invoke the agent directly from PowerShell:

```powershell
copilot --agent flight-recorder --prompt "Fix issue #42 and run the relevant tests"
```

For prompt mode in a repository that has not already been trusted interactively, set `GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP=true` before invoking Copilot so it can load the workspace MCP configuration.

### Troubleshooting

- **Connection refused:** run `docker compose ps` and verify that `http://localhost:5080/api/runs` responds. Both MCP files must target `http://localhost:5080/mcp`.
- **VSIX-managed service unavailable:** use **Show Local Recorder Status / Logs**, then explicitly start or retry setup. Repository Compose commands do not manage this separate installation.
- **Duplicate MCP tools:** keep either the extension-provided connection or your manual configuration for the same endpoint; **Disconnect from Copilot** disables only the extension provider.
- **Panel or helper still uses an old URL:** update the panel extension, reset or update `flightRecorder.serverUrl`, and check `FLIGHTRECORDER_URL`, `--url` or the action's `server-url` input. Explicit settings override defaults. Reopen the panel after changing its URL.
- **Server not listed in VS Code:** run **Developer: Reload Window**, then **MCP: List Servers**.
- **Server not listed in Copilot CLI:** start the CLI from the repository root, accept folder trust, and run `/mcp show flightrecorder`.
- **Tools are unavailable:** confirm your Copilot organization policy allows MCP servers and that the server is enabled in the tools picker.
- **No trace was created:** confirm that the session is local, the task is substantive, the host loaded the repository instructions, and the agent has permitted recorder tools. Check for a reported recording failure or opt-out. Selecting **flight-recorder** or explicitly requesting the shared policy can clarify intent, but cannot grant missing permissions or guarantee capture.

## Data persistence

SQLite stores traces in the Docker named volume. The latest 10 completed runs and all unfinished runs survive API and container restarts. Retention is configurable; `docker compose down -v` deletes the volume and its history. Full-mode content remains unredacted on disk. See [trace persistence](nice-to-haves.md#trace-persistence) for the full configuration and limits.

## Release and clean-install acceptance

Maintainers push an explicit `v<extensionVersion>` tag only when a release is intended.
For the automated local flow, [ask Copilot for a conventional commit message to
prepare the version, then run the release-tag task after committing and pushing
main](../CONTRIBUTING.md#conventional-commit-and-release-flow).
The release workflow reuses CI, checks version consistency, tests the actual packaged VSIX,
and creates a draft containing that same VSIX and its SHA-256 checksum. Publish the draft
manually after reviewing its assets. The workflow never overwrites an existing release;
inspect and resolve an existing draft explicitly before retrying publication.

Before publishing, verify a clean desktop VS Code profile on supported platforms:

1. Install the release candidate VSIX into an isolated user-data/extensions directory, not
   over a normal developer profile. Use an unrelated trusted workspace with no repository checkout.
2. Confirm that activation alone creates no container and starts no Docker application.
3. Exercise missing/stopped Docker guidance, then explicit setup, a port conflict, and normal readiness.
4. Verify the panel and optional MCP discovery/approvals, plus cancellation and failure reporting.
5. Create only synthetic test traces; verify stop/start/recreation preserves them and restart is
   off unless enabled. Do not reboot a shared machine or change OS startup settings for testing.
6. Verify saved external/native URLs are preserved and remote sessions remain viewer-only.

Automated tests cover mocked Windows/macOS/Linux behavior and extracted-VSIX Docker acceptance.
The container test uses uniquely owned resources and a temporary installation, not an existing
developer recorder. Automated Linux container coverage does not itself prove a Docker Desktop
installation on Windows or macOS; record actual platform acceptance separately.
