const { join } = require("node:path");
const { validateServerUrl } = require("./webview.cjs");
const { registerMcp } = require("./mcp.cjs");

const prerequisiteCodes = new Set([
  "DOCKER_MISSING", "COMPOSE_MISSING", "DOCKER_UNAVAILABLE", "UNSUPPORTED_ENGINE", "REMOTE_DOCKER"
]);

function dockerGuide(platform, code) {
  if (code === "COMPOSE_MISSING") return "https://docs.docker.com/compose/install/";
  if (code === "REMOTE_DOCKER") return "https://docs.docker.com/engine/manage-resources/contexts/";
  if (platform === "win32") return "https://docs.docker.com/desktop/setup/install/windows-install/";
  if (platform === "darwin") return "https://docs.docker.com/desktop/setup/install/mac-install/";
  return "https://docs.docker.com/engine/install/";
}

function validatePort(value) {
  return /^[1-9]\d{0,4}$/.test(value) && Number(value) >= 1024 && Number(value) <= 65535
    ? undefined : "Enter a port between 1024 and 65535.";
}

function registerLocalSetup(vscode, context, { open, getOrigin, createRecorder, platform = process.platform }) {
  let output;
  let recorder;
  const version = context.extension?.packageJSON.version ?? require("./package.json").version;
  const getOutput = () => {
    if (!output) {
      output = vscode.window.createOutputChannel("Flight Recorder");
      context.subscriptions.push(output);
    }
    return output;
  };
  const log = text => getOutput().appendLine(String(text));

  function ensureLocal() {
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before setting up the recorder.");
    if (vscode.env.remoteName || (vscode.UIKind && vscode.env.uiKind === vscode.UIKind.Web)) {
      throw new Error("Local recorder management is available in desktop VS Code only. Open a local window; remote viewer support is unchanged.");
    }
    if (!["win32", "darwin", "linux"].includes(platform)) {
      throw new Error("Local setup supports Windows, macOS, and Linux.");
    }
  }

  function runtime() {
    ensureLocal();
    if (!recorder) {
      const options = {
        storagePath: join(context.globalStorageUri.fsPath, "local-recorder"),
        bundlePath: join(context.extensionUri.fsPath, "recorder"),
        version,
        log
      };
      recorder = createRecorder ? createRecorder(options)
        : new (require("./local-recorder.cjs").LocalRecorder)(options);
    }
    return recorder;
  }

  async function run(title, action) {
    ensureLocal();
    getOutput().show(true);
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: `Flight Recorder: ${title}`, cancellable: true
    }, async (_progress, token) => {
      const controller = new AbortController();
      const cancellation = token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) controller.abort();
      try {
        return await action(runtime(), controller.signal);
      } finally {
        cancellation.dispose();
      }
    });
  }

  const mcp = registerMcp(vscode, context, {
    ensureLocal, getOrigin, log,
    getVersion: () => {
      const current = context.globalState.get("localRecorder.current");
      return current?.origin === validateServerUrl(getOrigin()).origin && current.managed ? current.version : undefined;
    },
    probe: origin => run("Checking MCP endpoint", (local, signal) => local.probe(origin, { signal }))
  });

  const offerRestart = current => vscode.window.showQuickPick([
    { label: "Manual start (default)", description: "Do not restart automatically with Docker", enabled: false },
    { label: "Restart with Docker", description: "unless-stopped; Docker must start at sign-in/boot", enabled: true }
  ], { title: `Flight Recorder: Restart policy${current === undefined ? "" : ` (currently ${current ? "enabled" : "off"})`}` });

  async function finish(state, offerConnection = true) {
    const origin = validateServerUrl(state.origin).origin;
    await vscode.commands.executeCommand("setContext", "flightRecorder.ready", true);
    if (origin !== validateServerUrl(getOrigin()).origin) {
      const selected = await vscode.window.showInformationMessage(
        `Recorder is ready at ${origin}. Change the saved Flight Recorder server URL to use it?`,
        { modal: true }, "Use This Recorder"
      );
      if (selected !== "Use This Recorder") {
        await vscode.window.showInformationMessage(`Recorder is ready at ${origin}. Your existing server URL was preserved.`);
        return;
      }
      await vscode.workspace.getConfiguration("flightRecorder").update(
        "serverUrl", origin, vscode.ConfigurationTarget.Global
      );
    }
    await context.globalState.update("localRecorder.current", {
      origin, managed: state.owned === true, version: state.version
    });
    mcp.refresh();
    log(`Ready: ${origin}; ${state.owned ? `managed release ${state.version}, restart ${state.restart ? "unless-stopped" : "off"}` : "externally managed"}.`);
    if (offerConnection) {
      const choice = await vscode.window.showInformationMessage(
        `Flight Recorder is ready at ${origin}. Trace data persists independently of VS Code.`,
        "Connect to Copilot", "Open Recorder"
      );
      if (choice === "Connect to Copilot") await mcp.connect();
    }
    await open();
  }

  async function setup() {
    ensureLocal();
    await run("Checking Docker prerequisites", (local, signal) => local.preflight({ signal }));
    await vscode.commands.executeCommand("setContext", "flightRecorder.dockerReady", true);
    const installed = await run("Checking installation", (local, signal) => local.status({ signal }));
    if (installed.owned && installed.state !== "not-installed") {
      const choice = await vscode.window.showInformationMessage(
        `A managed recorder is installed at ${installed.origin}. Bundled release: ${version}. Data will be preserved.`,
        { modal: true }, "Start Existing", "Rebuild Installed Version"
      );
      if (!choice) return;
      const state = await run(choice, (local, signal) =>
        choice === "Rebuild Installed Version" ? local.rebuild({ signal }) : local.start({ signal }));
      return finish(state);
    }

    let port = validateServerUrl(getOrigin()).port || "5080";
    for (;;) {
      const input = await vscode.window.showInputBox({
        title: "Flight Recorder: Local port", prompt: "Bind only to this computer's loopback interface.",
        value: port, validateInput: validatePort
      });
      if (input === undefined) return;
      if (validatePort(input)) throw new Error(validatePort(input));
      port = input;
      const restart = await offerRestart();
      if (!restart) return;
      const choice = await vscode.window.showInformationMessage(
        `Build bundled release ${version} and run it on loopback port ${port}? ` +
        "Docker will download uncached images and packages using the bundled NuGet.Config. " +
        `Source/state: ${join(context.globalStorageUri.fsPath, "local-recorder")}. ` +
        "Traces use a persistent Docker volume. No host SDKs are installed. " +
        `Restart with Docker: ${restart.enabled ? "enabled (unless-stopped)" : "off"}.`,
        { modal: true }, "Build and Start"
      );
      if (choice !== "Build and Start") return;
      let state;
      try {
        state = await run("Building and starting recorder", (local, signal) =>
          local.setup({ port: Number(port), restart: restart.enabled, signal }));
      } catch (error) {
        if (error.code !== "PORT_IN_USE") throw error;
        const collision = await vscode.window.showWarningMessage(
          `Port ${port} is in use. Nothing on that port will be stopped or replaced.`,
          "Use Existing Recorder", "Choose Another Port"
        );
        if (collision === "Choose Another Port") continue;
        if (collision !== "Use Existing Recorder") return;
        const origin = `http://localhost:${port}`;
        await run("Verifying existing recorder", (local, signal) => local.probe(origin, { signal }));
        state = { origin, owned: false };
      }
      return finish(state);
    }
  }

  async function managed(local, signal) {
    const selected = validateServerUrl(getOrigin()).origin;
    const current = context.globalState.get("localRecorder.current");
    if (current?.origin === selected && current.managed === false) {
      throw new Error("This recorder is externally managed. Use Set Up Local Recorder to select an owned installation.");
    }
    const state = await local.status({ signal });
    if (!state.owned || state.state === "not-installed") {
      throw new Error("No managed recorder is installed. Use Set Up Local Recorder; an external recorder cannot be managed here.");
    }
    if (validateServerUrl(state.origin).origin !== selected) {
      throw new Error("The selected server is not this extension's managed recorder. Use Set Up Local Recorder to select it.");
    }
    return state;
  }

  async function lifecycle(action) {
    const state = await run(action, async (local, signal) => {
      await managed(local, signal);
      if (action === "rebuild") {
        const choice = await vscode.window.showInformationMessage(
          `Rebuild from bundled release ${version}? The existing image is built before replacement. ` +
          "Trace data is preserved, but database downgrades are not supported.",
          { modal: true }, "Rebuild"
        );
        if (choice !== "Rebuild") return undefined;
      }
      return local[action]({ signal });
    });
    if (!state) return;
    if (action === "stop") {
      await vscode.commands.executeCommand("setContext", "flightRecorder.ready", false);
      await vscode.window.showInformationMessage("Recorder stopped. Trace data is preserved; unless-stopped will not restart an explicitly stopped container.");
    } else {
      await finish(state, false);
    }
  }

  async function restartPolicy() {
    const state = await run("Checking restart policy", (local, signal) => managed(local, signal));
    const choice = await offerRestart(state.restart);
    if (!choice) return;
    await run("Updating restart policy", async (local, signal) => {
      await managed(local, signal);
      return local.setRestart(choice.enabled, { signal });
    });
    await vscode.window.showInformationMessage(
      choice.enabled
        ? "Restart with Docker enabled. Docker itself must start at sign-in/boot; OS startup settings were not changed."
        : "Automatic restart disabled. Start the recorder explicitly when needed.",
      "Docker Startup Guide"
    ).then(async selected => {
      if (selected === "Docker Startup Guide") {
        await vscode.env.openExternal(vscode.Uri.parse("https://docs.docker.com/engine/containers/start-containers-automatically/"));
      }
    });
  }

  const commands = {
    "flightRecorder.setup": setup,
    "flightRecorder.start": () => lifecycle("start"),
    "flightRecorder.stop": () => lifecycle("stop"),
    "flightRecorder.restart": () => lifecycle("restart"),
    "flightRecorder.rebuild": () => lifecycle("rebuild"),
    "flightRecorder.configureRestart": restartPolicy,
    "flightRecorder.connectCopilot": () => mcp.connect(),
    "flightRecorder.disconnectCopilot": () => mcp.disconnect(),
    "flightRecorder.status": async () => {
      const state = await run("Checking status", (local, signal) => local.status({ signal }));
      log(JSON.stringify(state, null, 2));
      await vscode.window.showInformationMessage(`Flight Recorder: ${state.state}${state.origin ? ` at ${state.origin}` : ""}. See the Output channel for details.`);
    },
    "flightRecorder.logs": () => run("Reading logs", async (local, signal) => {
      await managed(local, signal);
      log(await local.logs({ signal }));
    }),
    "flightRecorder.dockerGuide": () => vscode.env.openExternal(vscode.Uri.parse(dockerGuide(platform)))
  };

  for (const [id, handler] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
      try {
        await handler();
      } catch (error) {
        log(`${error.code ?? "ERROR"}: ${error.message}`);
        if (error.code === "CANCELLED" || error.name === "AbortError") {
          await vscode.window.showInformationMessage("Recorder operation cancelled. Use Show Status to check any resources already created.");
          return;
        }
        const prerequisite = prerequisiteCodes.has(error.code);
        const choice = await vscode.window.showErrorMessage(`Flight Recorder: ${error.message}`,
          ...(prerequisite ? ["Open Docker Guide", "Retry", "Show Output"] : ["Show Output"]));
        if (choice === "Open Docker Guide") {
          await vscode.env.openExternal(vscode.Uri.parse(dockerGuide(platform, error.code)));
        } else if (choice === "Retry") {
          await vscode.commands.executeCommand(id);
        } else if (choice === "Show Output") {
          getOutput().show();
        }
      }
    }));
  }
}

module.exports = { registerLocalSetup, dockerGuide, validatePort };
