# Agent Flight Recorder for VS Code

Build and run the recorder locally with Docker, optionally connect its MCP tools
to Copilot, and inspect agent graphs, policy decisions, timelines, evidence, and
trace comparisons in an editor panel.

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

## Build from source

At the repository root, install the declared tooling with `npm ci`, then run
`npm run package:vscode`. Install the versioned VSIX from `artifacts` with
**Extensions: Install from VSIX**. The packaging step stages an allowlisted source
bundle; it does not require compiling the API on the host.

Use `npm run test:vsix-setup` after packaging to validate the extracted artifact
with an isolated Docker installation. A source-only Extension Development Host
does not contain a generated recorder bundle; use the packaged VSIX to test setup.