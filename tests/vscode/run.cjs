const assert = require("node:assert/strict");
const vscode = require("vscode");
const fs = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");

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
  const readers = require(path.join(extension.extensionPath, "usage-sources.cjs"));
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "recorder-host-usage-")));
  try {
    const sourcePath = path.join(directory, "synthetic.json");
    await fs.writeFile(sourcePath, JSON.stringify({ requests: [{
      requestId: "synthetic-host-request", modelId: "test-model",
      result: { usage: { promptTokens: 11, completionTokens: 2 } }
    }] }));
    const usage = await readers.readSource({ kind: "vscode-chat", path: sourcePath });
    assert.equal(usage.observations[0].inputTokens, 11);
    assert.equal(usage.observations[0].outputTokens, 2);
    let DatabaseSync;
    try { ({ DatabaseSync } = require("node:sqlite")); }
    catch (error) { if (error.code !== "ERR_UNKNOWN_BUILTIN_MODULE") throw error; }
    if (DatabaseSync) {
      const databasePath = path.join(directory, "synthetic.db");
      const sessionId = "11111111-2222-3333-4444-555555555555";
      const database = new DatabaseSync(databasePath);
      try {
        database.exec("CREATE TABLE assistant_usage_events (session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, total_nano_aiu INTEGER)");
        database.prepare("INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?, ?)").run(sessionId, "test-model", 11, 2, 1000000000);
      } finally { database.close(); }
      const usage = await readers.readSource({ kind: "copilot-cli", path: databasePath, sessionId });
      assert.equal(usage.observations[0].inputTokens, 11);
      assert.equal(usage.observations[0].nanoAiu, 1000000000);
      console.log("Local usage collectors verified in VS Code: Chat JSON and SQLite usage parsed from synthetic fixtures.");
    } else {
      console.log("Local Chat JSON collector verified; this VS Code host lacks SQLite and requires the documented JSONL fallback.");
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

module.exports = { run };
