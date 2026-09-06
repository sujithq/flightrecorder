const assert = require("node:assert/strict");
const vscode = require("vscode");

async function run() {
  const extension = vscode.extensions.getExtension("sujithq.flight-recorder");
  assert.ok(extension, "The packaged extension must be installed or loaded from an extracted VSIX.");
  await extension.activate();
  assert.equal(extension.isActive, true);
  const commands = new Set(await vscode.commands.getCommands(true));
  for (const command of extension.packageJSON.contributes.commands) {
    assert.ok(commands.has(command.command), `Command not registered: ${command.command}`);
  }
  assert.equal(typeof vscode.lm.registerMcpServerDefinitionProvider, "function");
  assert.ok(extension.packageJSON.contributes.mcpServerDefinitionProviders
    .some(provider => provider.id === "flightRecorder.local"));
  console.log("Packaged Flight Recorder activated; all commands and the MCP provider registered without invoking setup.");
}

module.exports = { run };
