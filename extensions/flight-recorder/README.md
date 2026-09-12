# Agent Flight Recorder for VS Code

Build and run the recorder locally with Docker, optionally connect its MCP tools
to Copilot, and inspect agent graphs, policy decisions, timelines, evidence, and
trace comparisons in an editor panel.

**Already installed? Start with [Quickstart: an empty folder to your first trace](#quickstart-an-empty-folder-to-your-first-trace).**

## Install from a GitHub release

1. Download the VSIX and its `.sha256` file from a published
   [GitHub release](https://github.com/sujithq/flightrecorder/releases).
2. Verify the checksum. In PowerShell use `Get-FileHash <file.vsix> -Algorithm SHA256`
   and compare it with the checksum file. On Linux use `sha256sum --check <file.vsix.sha256>`;
   on macOS use `shasum -a 256 -c <file.vsix.sha256>`.
3. In VS Code **1.101 or later**, run **Extensions: Install from VSIX** and select the downloaded file.
4. Open a trusted local desktop window and run **Flight Recorder: Set Up Local Recorder**,
   or open the extension's setup walkthrough.

The VSIX includes the release's API/web source and Docker build inputs. No repository
clone, host Git, Node.js, or .NET SDK is required. Docker downloads uncached base images
and dependencies during the build, so bundled source is not an offline installation.
NuGet restores use the bundled approved `NuGet.Config`; feed failures are reported
instead of being bypassed with other sources.

## Quickstart: an empty folder to your first trace

The three steps are **start the service**, **connect Copilot**, and **ask it to record
a task**. Installing the extension or connecting MCP alone does not record anything.

### 1. Open your folder and start the recorder

1. In desktop VS Code, use **File > Open Folder...** to open your new empty local
   folder. Trust it if you created it and are comfortable allowing code execution.
   Do not use a Remote SSH, WSL, dev-container, or browser window for local setup.
2. Start Docker Desktop with Linux containers, or your local Linux Docker Engine.
   If Docker is not installed, setup provides the [installation guide](#docker-prerequisites).
3. Open the **Command Palette** with **Ctrl+Shift+P** (Windows/Linux) or **Cmd+Shift+P**
   (macOS). Run **Flight Recorder: Set Up Local Recorder**.
4. Accept port **5080**, choose **Manual start (default)** for a first try, then
   **Build and Start**. If 5080 is occupied, reuse a verified existing recorder or
   choose a free port such as **5082**. Do not start a second service on the same port.
   If setup finds an installation it already owns, choose **Start Existing** instead.
5. Wait for the build and readiness checks; the first build can take several minutes.
   Progress appears in **View > Output > Flight Recorder**. Select **Use This Recorder**
   if asked to use the newly created endpoint. Remember the URL shown by setup.

**Checkpoint:** setup reports that the recorder is ready. Choose **Open Recorder**
or run **Flight Recorder: Open Recorder**. An empty run list is expected.
No clone, Git initialization, terminal build commands, host .NET/Node.js, or files in
your new folder are required. The extension builds its own bundled source and uses
the bundled approved `NuGet.Config`.

### 2. Connect normal Copilot Agent mode

1. Sign in to GitHub Copilot in VS Code if needed. Run **Flight Recorder: Connect to
   Copilot** from the Command Palette (or choose **Connect to Copilot** after setup).
   Confirm **Connect** for the endpoint shown.
2. Run **MCP: List Servers**, select **Flight Recorder (local)**, and start/trust that
   connection if prompted. This connects VS Code to the HTTP service; it does not
   install or start Docker.
3. Open **Copilot Chat**, select **Agent**, and use its **Configure Tools** button
   to enable the Flight Recorder tools. Follow your organization's approval rules.

**Checkpoint:** the tools picker lists `start_flight_run`, `record_flight_event`,
`complete_flight_run`, `get_flight_trace`, `analyze_flight_run`, and `list_flight_runs`
under the recorder server. Displayed tool names may include a server prefix.

You do not need this repository's **flight-recorder** custom agent, a
`.github/agents` folder, or a manually created MCP configuration. If you already
configured this endpoint manually, use that connection rather than adding a duplicate.

### 3. Record your first task

Paste this into Copilot Chat in **Agent** mode:

```text
Use the available Flight Recorder MCP tools to record this task:
Create README.md in this empty folder with a heading "My first recorded project"
and one sentence explaining that this is a Flight Recorder onboarding check.

Before editing, start one Redacted run with request "First Flight Recorder task" using
a non-sensitive requesting identity such as "local-developer". Record the actual
file-edit outcome and any checks you perform. Do not record secrets or invent
tool results, token counts, or costs. Complete and analyze the run when finished,
then return its run ID. If recording is unavailable, report that explicitly.
```

Approve the file edit and recorder tool calls when prompted. This creates a real,
small task; you do not need demo data or an application scaffold first.

**Checkpoint:** your folder contains `README.md`, and Copilot returns a run ID after
actual recorder tool calls. A text-only claim that something was recorded is not proof.
Run **Flight Recorder: Select Run**, choose **First Flight Recorder task**, and verify
that its events and completed status appear. The viewer and Copilot must use the
same endpoint selected during setup.

### Next time you open VS Code or another folder

- Ensure Docker is running. Use **Show Local Recorder Status** and, if stopped,
  **Start Local Recorder**, then **Open Recorder**. A new folder in the same local
  VS Code profile does not require rebuilding or reinstalling the service.
- The MCP opt-in and selected URL are saved for the local profile. Reconnect if you
  change the endpoint; check trust and tool selection for your new chat/workspace.
- Ask for recording explicitly for each task, or deliberately add a recording policy
  to your project's `.github/copilot-instructions.md`. The extension does not add that
  policy, and it does not inherit this repository's instructions in another folder.
  See the [shared policy in this repository](https://github.com/sujithq/flightrecorder/blob/main/.github/copilot-instructions.md#local-flight-recorder-policy)
  for local scope, privacy, and single-owner delegation guidance.
- Optionally use **Configure Restart with Docker** later. Docker must itself start at
  sign-in/boot; an explicitly stopped recorder remains stopped with `unless-stopped`.
- Traces belong to the recorder instance, not the opened folder. Expect the same run
  history when connecting from another folder; stop/start does not delete traces.

For this guide inside VS Code, run **Welcome: Open Walkthrough...** and select
**Set up your local Flight Recorder**. You can also read the extension's **Details**
page in the Extensions sidebar.

## Docker prerequisites

- **Windows:** install [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/),
  complete its host/virtualization requirements, start it, and use Linux containers.
- **macOS:** install and start [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/)
  for the appropriate CPU architecture.
- **Linux:** install a local [Docker Engine](https://docs.docker.com/engine/install/)
  and [Compose v2](https://docs.docker.com/compose/install/), start the engine, and follow
  the official guidance for user access to it.

Docker Desktop may require a paid subscription for your organization. The extension
does not install Docker, elevate permissions, alter daemon settings, or switch Docker
contexts. It reports missing prerequisites and offers guidance and Retry.
Automatic provisioning from Remote SSH, WSL, dev containers, or remote Docker endpoints
is not supported in this release; open a local desktop window instead.

## Set up and operate

Setup asks for a loopback port (default **5080**), restart preference, and confirmation
before building or creating resources. It stages source under the extension's global
storage and uses a separately owned Docker installation with persistent trace storage.
It verifies the viewer, API, and MCP endpoint before reporting readiness.

If a port is occupied, choose another port or reuse a verified existing recorder.
The extension never silently stops, replaces, or manages an external deployment.
It also asks before changing an explicitly saved `flightRecorder.serverUrl`.

Commands available in the Command Palette:

| Command | Behavior |
| --- | --- |
| Set Up Local Recorder | Check prerequisites, build bundled source, and run with consent. |
| Start / Stop / Restart Local Recorder | Operate only on the selected extension-owned instance. |
| Rebuild / Update Local Recorder | Explicitly build the installed VSIX's source, then replace the owned container. |
| Show Local Recorder Status / Logs | Inspect actual state or container diagnostics. |
| Configure Restart with Docker | Choose manual startup or Docker's `unless-stopped` policy. |
| Open Recorder / Select Run | Open the existing viewer. |
| Connect to / Disconnect from Copilot | Opt in/out of the extension-provided MCP connection. |

No image is built and no service or Docker application is started merely by activating
the extension or discovering MCP tools. Closing VS Code does not stop the recorder.

### Data and upgrades

Traces live in a persistent Docker volume, not in the extension installation directory.
Stop, restart, rebuild, and installing a newer VSIX do not intentionally delete this volume.
The repository's separate Compose deployment is left untouched.

After installing an updated VSIX, explicitly use **Rebuild / Update Local Recorder**.
The viewer shows **Recorder vX.Y.Z** below its title, on desktop and mobile. This
comes from the running API, not the VSIX currently installed in the editor, so it
keeps showing the old release until the server is updated. Use **Refresh runs** or
reload the viewer after an upgrade to refresh the label.

An unversioned source deployment shows **Development build**; an older/unreachable
API without version metadata shows **Version unavailable** rather than guessing.
The extension supplies release metadata automatically for newly created/rebuilt
managed containers. Existing containers need **Rebuild / Update Local Recorder**
once to acquire the metadata/endpoint; installing the VSIX alone does not add them.

Source version and hashes are checked before building. Build failure leaves the current
running container in place. Startup failures are surfaced in the Output channel; database
downgrades and automatic rollback are not supported. The extension does not automatically
delete data or remove Docker resources when uninstalled.

### Optional restart

Managed installations default to restart **off**. Enabling restart selects
[`unless-stopped`](https://docs.docker.com/engine/containers/start-containers-automatically/):
Docker can restart the container when its engine starts, unless you explicitly stopped it.

Docker itself must start at sign-in/boot. On Docker Desktop, configure its sign-in
startup preference yourself; on Linux, follow the engine/service startup guidance.
The extension changes no operating-system startup settings and does not promise
startup before login. An explicitly stopped container requires an explicit start.

## Connect Copilot

After setup, optionally choose **Connect to Copilot**. The extension publishes the
selected loopback `/mcp` endpoint using VS Code's MCP provider API, while VS Code keeps
server-trust and tool-call approvals. Use **MCP: List Servers** and the Copilot tools picker.

Skip registration if you already configured the same server manually. The extension
does not edit workspace/user MCP files or remove manual configurations. Changing the
server URL requires reconnecting to approve the new endpoint. Copilot CLI configuration
remains manual.

Making MCP tools available is not automatic recording or interception of agent traffic.
Use your workspace's recording policy or explicitly ask Copilot to record a workflow.
Only loopback URLs are accepted; this prototype has no authentication layer.

## Use the shared instrumented runtime

The extension contributes two Copilot Chat participants backed by one shared
Copilot SDK client in the current VS Code window:

- `@flightrecorder` provides concise, read-only general answers.
- `@flightrecorder-review` reviews supplied text for defects, risks, and missing tests.

Install GitHub Copilot CLI, sign in, start the local recorder, and invoke either
participant in Copilot Chat. Each request creates a separate Redacted recorder run
and task, creates an isolated SDK session, attaches OTLP usage capture before the
model call, returns the answer, flushes usage, and completes the run. Open Recorder
to inspect measured tokens reported by the SDK. Both participants share one SDK
client process for efficiency; they never share SDK sessions or conversation state.

The participants use the model family selected in the Chat UI when the SDK supports
that model. They deliberately expose no tools, load no workspace custom instructions,
deny permission requests, and do not modify files. Conversation history included by
VS Code for the current participant is sent to its isolated SDK request but is not
recorded as event content. Cancelling a request disconnects its session.

Measured token capture needs no price configuration. Estimated USD remains off unless
`flightRecorder.copilotUsdPrices` contains a complete entry keyed by the exact model
reported by the SDK. Use independently verified rates and cache-accounting semantics;
invalid, incomplete, expired, or mismatched entries produce no estimate rather than a
zero. The full field contract is documented in the SDK integration guide.

The VSIX bundles the SDK client, but it does not bundle a platform runtime or sign
users in. `copilot` must be available on `PATH`; the shared client uses the CLI's
logged-in identity. The runtime starts lazily on the first participant request and
stops when the extension host closes. Built-in Copilot and unrelated participants
still bypass this runtime and therefore do not gain per-turn usage recording.

### Why usage may say "Not reported"

Built-in Copilot Chat does not push per-call token usage to the recorder through its
recording instructions. The extension-owned participants above use an instrumented
SDK session instead. **Collect Local Copilot Usage** can opt into reading a
selected persisted session instead; supported fields vary by runtime. The viewer
shows **Not reported** for omitted token/cost fields, preserves explicitly reported
zero, and labels known subtotals **partial** when recorded model-call usage is incomplete.
It does not equate missing values to free work or calculate savings from incomplete data.

Developers controlling a Copilot SDK session can opt into the
[SDK usage adapter](https://github.com/sujithq/flightrecorder/blob/main/integrations/copilot-sdk/README.md).
It forwards supported usage events and can estimate USD cost only with explicit model
prices and a recorded pricing basis. This is an application integration, not automatic
capture from every VS Code chat, and it is not a Copilot billing statement.

Legacy records cannot distinguish default zeros from measured zero. The updated API
treats those old zeros as unknown, retains positive evidence, and labels missing legacy
pricing basis. Installing a newer VSIX alone does not update the API: run **Rebuild /
Update Local Recorder**, then refresh the MCP connection so agents use the new nullable
metric schema instead of cached zero defaults.

## Collect usage from your normal Copilot sessions

1. First update the recorder with **Rebuild / Update Local Recorder**.
2. Run **Flight Recorder: Collect Local Copilot Usage** and approve read-only
   discovery of your local session storage. Nothing is scanned on activation.
3. Explicitly select a discovered session or a Chat JSON/JSONL / CLI database file.
   Database sources require a session selection too.
4. Choose **Measured usage only**, or explicitly allow approximate visible-text
   estimates. Conversation text is never sent to the recorder.
5. Choose a **dedicated session-usage run** (recommended), confirm the binding,
   and select **Start Collection**. Open the recorder and inspect imported events.
6. Use **Stop Local Usage Collection** when done; this completes only a successful
   dedicated run owned by the collector. Reloading the window stops collection.

**Show Local Usage Collection Status** reports state; **Import Bound Session Usage
Now** immediately imports and resumes after a resolved failure. Polling is every ten
seconds in this window only; bindings are not persisted or synced.

The viewer keeps **measured tokens**, **text-estimated tokens**, **API price estimates**
and **Copilot credit-equivalent usage** separate. An unchanged snapshot does not
add usage again. Runs cannot mix overlapping SDK/manual measurements or another
session source with local imports. These are entire-session observations, not an
automatic mapping of all activity to your latest task.

Unknown storage schemas, missing token fields, unsupported SQLite runtimes, or
partially written files are reported. This collector is read-only, bounded, local
desktop only, and requires the extension host's built-in SQLite support for `.db`
sources. It does not install database tooling or promise every Copilot version has
the same telemetry. See the [local collection guide](https://github.com/sujithq/flightrecorder/blob/main/docs/local-usage.md)
for source formats, billing units, attribution and recovery.

## Existing and remote recorders

You can still start the repository Compose deployment yourself or select a native
development server on port 5205 using `flightRecorder.serverUrl`. **Open Recorder** and
**Select Run** preserve explicit settings and use VS Code port forwarding for remote
workspace viewers. Local setup and extension-provided local MCP are disabled in remote
sessions; configure remote MCP separately.

## Troubleshooting

- **Docker/Compose missing or engine stopped:** follow the prerequisite guide and retry;
  installing the VSIX does not install or start Docker.
- **Docker permissions, Windows-container mode, or remote context:** correct the local
  Docker configuration yourself. No elevation or context switch is performed for you.
- **Image/package download failure:** inspect the Output channel and your network/proxy
  access, including the approved NuGet feed. Do not substitute unapproved feeds.
- **Port conflict:** select a free port or explicitly reuse an existing verified recorder.
- **Cancelled/interrupted setup:** use **Show Local Recorder Status** before retrying.
  A cancelled CLI operation may already have created resources in Docker.
- **API or MCP not ready:** inspect status and logs. A browser GET to `/mcp` can return 405;
  MCP uses POST, and setup verifies the protocol instead.
- **Viewer cannot connect:** check the configured URL and explicitly start the service.
  Reopen the panel after a stopped service is restarted.
- **No Flight Recorder commands:** confirm the extension is enabled in this local
  VS Code profile, the workspace is trusted, and you are using the Command Palette,
  not the Extensions marketplace search box.
- **No recorder tools in Copilot:** run **Connect to Copilot**, inspect **MCP: List
  Servers**, and check Agent mode's tools picker. If your organization blocks MCP,
  request administrator guidance rather than bypassing the restriction.
- **No first run:** verify that Copilot actually called `start_flight_run`, use the
  [first-task prompt](#3-record-your-first-task), and compare the viewer's selected
  URL with the MCP connection. Setting up the service does not generate a run.

## Build from source

At the repository root, install the declared tooling with `npm ci`, then run
`npm run package:vscode`. Install the versioned VSIX from `artifacts` with
**Extensions: Install from VSIX**. The packaging step stages an allowlisted source
bundle; it does not require compiling the API on the host.

Use `npm run test:vsix-setup` after packaging to validate the extracted artifact
with an isolated Docker installation. A source-only Extension Development Host
does not contain a generated recorder bundle; use the packaged VSIX to test setup.
