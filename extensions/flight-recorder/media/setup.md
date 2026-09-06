# From an empty folder to your first trace

**Install extension -> start recorder -> connect Copilot -> record a task -> inspect it.**
Connecting the tools alone does not record your work.

## 1. Start the recorder

Open your empty folder with **File > Open Folder...** in local desktop VS Code,
and trust it if you created it. Start Docker Desktop with Linux containers, or
your local Linux Docker Engine. Docker with Compose v2 or newer is required.
Setup offers official installation guidance if it is missing; it does not install
Docker or change OS settings. Docker Desktop licensing may apply.

Open the Command Palette (**Ctrl+Shift+P**, or **Cmd+Shift+P** on macOS) and run
**Flight Recorder: Set Up Local Recorder**. Use port **5080**, **Manual start
(default)**, and **Build and Start** for a first try. If the port is busy, reuse a
verified existing recorder or choose a free port such as **5082**. If your managed
installation already exists, choose **Start Existing**.

The first build can take several minutes. Watch **View > Output > Flight Recorder**.
Select **Use This Recorder** if asked to use the new endpoint. Wait for the ready
message, then choose **Open Recorder**. An empty run list is normal.

No repository checkout, Git initialization, host SDKs, or workspace files are needed.
The extension builds bundled source; uncached images/packages require internet.
NuGet restores honor the bundled approved `NuGet.Config`.

## 2. Connect Copilot

Sign in to Copilot if needed. Run **Flight Recorder: Connect to Copilot** and confirm
the endpoint. In **MCP: List Servers**, select **Flight Recorder (local)** and
start/trust its connection if prompted. In **Copilot Chat > Agent > Configure Tools**,
enable the recorder tools while keeping normal approval prompts.

Verify that the tools picker includes `start_flight_run`, `record_flight_event`,
`complete_flight_run`, `get_flight_trace`, `analyze_flight_run`, and `list_flight_runs`
(possibly with server-prefixed names). No special custom agent or manual MCP files
are required. If that endpoint is already manually configured, use that connection
instead of registering it twice.

## 3. Ask for the first recorded task

Paste this into normal Copilot **Agent** mode:

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

Approve the file edit and MCP calls when prompted. You should get a README and
a run ID. Run **Flight Recorder: Select Run**, choose **First Flight Recorder task**,
and check the recorded events and completed status. Copilot merely saying it
recorded something is not enough; look for actual tool calls and the saved run.

## When you come back

Ensure Docker is running, then use **Show Local Recorder Status**, **Start Local
Recorder** if stopped, and **Open Recorder**. The same local profile reuses its
installation and saved endpoint across folders; there is no need to rebuild.
Reconnect MCP if the endpoint changes and check tool availability in the new chat.

Recording is explicit unless you add a policy to your own project's
`.github/copilot-instructions.md`; installing this extension does not do that.
Trace history belongs to the recorder, not the folder. Stop/start preserves it.
Optional **Configure Restart with Docker** uses `unless-stopped`: Docker itself
must start at sign-in/boot, and manually stopped containers stay stopped.

## If a step does not work

- Commands missing: use the Command Palette, a trusted local window, and the profile
  where the extension is enabled.
- Setup failed: read **View > Output > Flight Recorder** and **Show Local Recorder
  Logs**; do not bypass approved package sources.
- Tools missing: inspect **MCP: List Servers** and Agent mode's tools picker.
  Organization restrictions still apply.
- Run missing: explicitly request recording and check that Copilot and the viewer
  use the same recorder URL.
