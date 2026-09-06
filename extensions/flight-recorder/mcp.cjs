const { validateServerUrl } = require("./webview.cjs");

const providerId = "flightRecorder.local";
const approvalKey = "localRecorder.mcpApproval";

function registerMcp(vscode, context, { ensureLocal, getOrigin, getVersion, probe, log }) {
  const supported = typeof vscode.lm?.registerMcpServerDefinitionProvider === "function";
  const changed = supported ? new vscode.EventEmitter() : undefined;
  const refresh = () => changed?.fire();

  if (supported) {
    context.subscriptions.push(changed, vscode.lm.registerMcpServerDefinitionProvider(providerId, {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions() {
        if (!vscode.workspace.isTrusted || vscode.env.remoteName) return [];
        const approval = context.globalState.get(approvalKey);
        if (!approval) return [];
        try {
          const origin = validateServerUrl(getOrigin()).origin;
          if (origin !== approval.origin) return [];
          return [new vscode.McpHttpServerDefinition(
            "Flight Recorder (local)", vscode.Uri.parse(`${origin}/mcp`), {}, getVersion() ?? approval.version
          )];
        } catch (error) {
          log(`Cannot publish the MCP endpoint: ${error.message}`);
          return [];
        }
      }
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("flightRecorder.serverUrl")) {
        if (context.globalState.get(approvalKey)) {
          log("Recorder URL changed. Use Connect to Copilot to approve a different MCP endpoint.");
        }
        refresh();
      }
    }));
  }

  return {
    refresh,
    async connect() {
      ensureLocal();
      if (!supported) throw new Error("MCP registration requires VS Code 1.101 or later with MCP support enabled.");
      const origin = validateServerUrl(getOrigin()).origin;
      const choice = await vscode.window.showInformationMessage(
        `Connect Copilot to ${origin}/mcp? VS Code still controls server trust and tool approvals. ` +
        "Skip this if you already configured this server manually. This does not enable automatic recording.",
        { modal: true }, "Connect"
      );
      if (choice !== "Connect") return;
      await probe(origin);
      await context.globalState.update(approvalKey, { origin, version: getVersion() });
      refresh();
      await vscode.commands.executeCommand("setContext", "flightRecorder.mcpConnected", true);
      await vscode.window.showInformationMessage(
        "Flight Recorder MCP is available. Use MCP: List Servers and the Copilot tools picker to trust and enable it."
      );
    },
    async disconnect() {
      ensureLocal();
      await context.globalState.update(approvalKey, undefined);
      refresh();
      await vscode.commands.executeCommand("setContext", "flightRecorder.mcpConnected", false);
      await vscode.window.showInformationMessage(
        "Extension-provided MCP connection disabled. Manual MCP configurations were not changed."
      );
    }
  };
}

module.exports = { registerMcp, providerId, approvalKey };
