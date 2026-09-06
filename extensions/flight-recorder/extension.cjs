const vscode = require("vscode");
const { randomBytes } = require("node:crypto");
const { validateServerUrl, withRun, panelHtml } = require("./webview.cjs");

function activate(context) {
  let panel;

  function serverUrl() {
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before opening the recorder.");
    return validateServerUrl(vscode.workspace.getConfiguration("flightRecorder").get("serverUrl", "http://localhost:5205"));
  }

  async function open(runId) {
    const url = withRun(serverUrl(), runId);
    const forwarded = await vscode.env.asExternalUri(vscode.Uri.parse(url.href));
    const html = panelHtml(forwarded.toString(), randomBytes(24).toString("base64"));
    if (!panel) {
      panel = vscode.window.createWebviewPanel("flightRecorder", "Agent Flight Recorder", vscode.ViewColumn.Active, {
        enableScripts: true, localResourceRoots: [], retainContextWhenHidden: false
      });
      panel.iconPath = new vscode.ThemeIcon("pulse");
      context.subscriptions.push(panel.onDidDispose(() => { panel = undefined; }));
    }
    panel.webview.html = html;
    panel.reveal();
  }

  async function selectRun() {
    const url = new URL("/api/runs", serverUrl());
    const response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: "error" });
    if (!response.ok) throw new Error(`Recorder returned HTTP ${response.status}. Check the server URL and start the API.`);
    const runs = await response.json();
    if (!Array.isArray(runs)) throw new Error("The recorder returned an invalid run list.");
    if (!runs.length) {
      await vscode.window.showInformationMessage("No recorded runs. Start a workflow or create a demo run in the recorder.");
      return open();
    }
    const statuses = ["Running", "Succeeded", "Failed", "Blocked", "Approval required"];
    const picked = await vscode.window.showQuickPick(runs.map(run => ({
      label: String(run.request),
      description: `${statuses[run.status] ?? run.status} | ${run.entryPointAgent}`,
      detail: String(run.id),
      runId: run.id
    })), { title: "Flight Recorder: Select Run", matchOnDescription: true, matchOnDetail: true });
    if (picked) await open(picked.runId);
  }

  const handle = handler => async (...args) => {
    try { await handler(...args); }
    catch (error) { await vscode.window.showErrorMessage(`Flight Recorder: ${error.message}`); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("flightRecorder.open", handle(open)),
    vscode.commands.registerCommand("flightRecorder.openRun", handle(selectRun)),
    new vscode.Disposable(() => panel?.dispose())
  );
}

module.exports = { activate };