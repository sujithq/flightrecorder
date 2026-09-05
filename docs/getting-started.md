# Agent Flight Recorder: Getting Started

This guide demonstrates how to start the API and record a complete agent run using PowerShell.

## 1. Start the API

From the repository root, run:

```powershell
dotnet run --project src\FlightRecorder.Api --launch-profile http
```

The API listens at `http://localhost:5205`. Keep this terminal open while using the API.

## 2. Start a recorded run

Open another PowerShell terminal and run:

```powershell
$run = Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:5205/api/runs `
  -ContentType application/json `
  -Body (@{
    request = "Investigate failed deployment"
    entryPointAgent = "orchestrator"
    requestingIdentity = "developer"
    recordingMode = 2
  } | ConvertTo-Json)

$runId = $run.id
$runId
```

Recording modes:

| Value | Mode | Behavior |
|---:|---|---|
| `0` | MetadataOnly | Does not retain event input or output |
| `1` | Redacted | Retains input and output after known secrets are redacted |
| `2` | Full | Retains full event input and output |

## 3. Record an agent event

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:5205/api/runs/$runId/events" `
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
  -Uri "http://localhost:5205/api/runs/$runId/events" `
  -ContentType application/json `
  -Body (@{
    type = 2
    name = "analyze-logs"
    status = 1
    model = "gpt-5"
    inputTokens = 800
    outputTokens = 200
    estimatedCost = 0.02
    input = "Analyze deployment logs"
    output = "Deployment failed because approval was missing"
  } | ConvertTo-Json)
```

## 5. Record a policy failure

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:5205/api/runs/$runId/events" `
  -ContentType application/json `
  -Body (@{
    type = 4
    name = "production-deployment"
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
  -Uri "http://localhost:5205/api/runs/$runId/complete"
```

## 7. View the complete trace

```powershell
Invoke-RestMethod "http://localhost:5205/api/runs/$runId" |
  ConvertTo-Json -Depth 10
```

The trace includes all events and aggregate duration, token, cost, and status information.

## 8. View the root-cause analysis

```powershell
Invoke-RestMethod "http://localhost:5205/api/runs/$runId/analysis" |
  ConvertTo-Json -Depth 10
```

The analysis identifies the primary failure or policy intervention and links the conclusion to recorded event IDs.

## 9. List recorded runs

```powershell
Invoke-RestMethod http://localhost:5205/api/runs |
  ConvertTo-Json -Depth 10
```

## Real-world example: coding agent blocked from creating a pull request

In this scenario, a coding agent receives a request, inspects the repository, changes the code, runs the tests successfully, and then attempts to create a pull request. The pull request operation is blocked because the agent only has read access.

Start the API in the first terminal, then run the following complete script in a second PowerShell terminal:

```powershell
$baseUrl = "http://localhost:5205/api"

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

The API exposes a Streamable HTTP Model Context Protocol (MCP) endpoint at `http://localhost:5205/mcp`. Copilot can use the endpoint as six tools:

- `flightrecorder/start_flight_run`
- `flightrecorder/record_flight_event`
- `flightrecorder/complete_flight_run`
- `flightrecorder/get_flight_trace`
- `flightrecorder/analyze_flight_run`
- `flightrecorder/list_flight_runs`

The repository also provides a `.github/agents/flight-recorder.agent.md` custom agent. The agent performs normal software-engineering work while recording significant milestones, tests, failures, and policy decisions. Recording is explicit: Copilot calls the MCP tools as it works; the Flight Recorder does not intercept Copilot traffic automatically.

### Start the shared MCP server

Both VS Code and Copilot CLI connect to the same local process. Start it before opening a recording session:

```powershell
dotnet run --project src\FlightRecorder.Api --launch-profile http
```

Keep this terminal running. The MCP endpoint is local and unauthenticated, so expose it only on a trusted development machine.

### Use with GitHub Copilot Chat in VS Code

Prerequisites are VS Code 1.99 or later, GitHub Copilot access, and an organization policy that permits MCP servers when applicable.

1. Open the repository root in VS Code. VS Code discovers `.vscode/mcp.json`.
2. Open `.vscode/mcp.json` and click **Start** above the `flightrecorder` server, or run **MCP: List Servers** from the Command Palette and start it there.
3. Approve the server when VS Code asks whether you trust it.
4. Open Copilot Chat.
5. Select the **flight-recorder** custom agent from the agent picker. If it is not listed, reload the VS Code window after pulling the agent file.
6. Enter a normal development request, for example:

   > Fix issue #42, run the relevant tests, and explain any operation that is blocked.

7. Approve MCP tool calls when prompted.
8. The custom agent returns the run ID and trace summary after completing the task. Ask `Show the full Flight Recorder trace for that run` to inspect the recorded evidence.

To use the tools without the custom agent, remain in normal **Agent** mode and prompt explicitly:

> Use the flightrecorder tools to start a Redacted run, perform this task, record significant tool and test results, complete the run, and analyze it.

Use the tools button in Copilot Chat to confirm that all six `flightrecorder` tools are enabled.

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

4. Select the repository custom agent:

   ```text
   /agent
   ```

   Choose **flight-recorder**. Restart Copilot CLI first if the agent was added while the CLI was already running.

5. Enter a normal task, for example:

   > Fix issue #42, run the relevant tests, and explain any operation that is blocked.

6. Approve tool calls when prompted. The agent completes and analyzes the trace before presenting its final response.

You can also invoke the agent directly from PowerShell:

```powershell
copilot --agent flight-recorder --prompt "Fix issue #42 and run the relevant tests"
```

For prompt mode in a repository that has not already been trusted interactively, set `GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP=true` before invoking Copilot so it can load the workspace MCP configuration.

### Troubleshooting

- **Connection refused:** verify that the API terminal says it is listening on `http://localhost:5205`.
- **Server not listed in VS Code:** run **Developer: Reload Window**, then **MCP: List Servers**.
- **Server not listed in Copilot CLI:** start the CLI from the repository root, accept folder trust, and run `/mcp show flightrecorder`.
- **Tools are unavailable:** confirm your Copilot organization policy allows MCP servers and that the server is enabled in the tools picker.
- **No trace was created:** select the **flight-recorder** custom agent or explicitly tell normal Agent mode to use the recorder tools.

## Data persistence

The current implementation stores data in memory. All recorded runs disappear when the API process stops or restarts.
