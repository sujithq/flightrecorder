export function mockVscode({ origin = "http://localhost:5080", remoteName, trusted = true } = {}) {
  const handlers = new Map();
  const state = new Map();
  const contexts = new Map();
  const writes = [];
  const messages = [];
  const output = [];
  const external = [];
  const providers = new Map();
  const answers = { information: [], warning: [], error: [], pick: [], input: [] };
  const configListeners = [];
  const disposable = () => ({ dispose() {} });
  let configuredOrigin = origin;
  let cancelled = false;
  let changes = 0;
  const message = kind => async (...args) => {
    messages.push({ kind, args });
    return answers[kind].shift();
  };
  const vscode = {
    workspace: {
      isTrusted: trusted,
      getConfiguration: () => ({
        get: (_key, fallback) => configuredOrigin ?? fallback,
        async update(key, value, target) {
          writes.push({ key, value, target });
          configuredOrigin = value;
          configListeners.forEach(listener => listener({ affectsConfiguration: () => true }));
        }
      }),
      onDidChangeConfiguration(listener) { configListeners.push(listener); return disposable(); }
    },
    env: { remoteName, uiKind: 1, async openExternal(uri) { external.push(uri.toString()); return true; } },
    UIKind: { Desktop: 1, Web: 2 },
    ConfigurationTarget: { Global: 1 },
    ProgressLocation: { Notification: 15 },
    Uri: { parse: value => new URL(value) },
    EventEmitter: class {
      event = () => disposable();
      fire() { changes++; }
      dispose() {}
    },
    McpHttpServerDefinition: class {
      constructor(label, uri, headers, version) { Object.assign(this, { label, uri, headers, version }); }
    },
    lm: {
      registerMcpServerDefinitionProvider(id, provider) { providers.set(id, provider); return disposable(); }
    },
    commands: {
      registerCommand(id, handler) { handlers.set(id, handler); return disposable(); },
      async executeCommand(id, ...args) {
        if (id === "setContext") { contexts.set(args[0], args[1]); return; }
        if (!handlers.has(id)) throw new Error(`Unexpected command: ${id}`);
        return handlers.get(id)(...args);
      }
    },
    window: {
      showInformationMessage: message("information"),
      showWarningMessage: message("warning"),
      showErrorMessage: message("error"),
      showQuickPick: message("pick"),
      showInputBox: message("input"),
      createOutputChannel() {
        return { appendLine: text => output.push(text), show() {}, dispose() {} };
      },
      async withProgress(_options, callback) {
        return callback({ report() {} }, {
          isCancellationRequested: cancelled,
          onCancellationRequested: () => disposable()
        });
      }
    }
  };
  const context = {
    subscriptions: [],
    extension: { packageJSON: { version: "0.2.0" } },
    extensionUri: { fsPath: "C:\\Release Files\\flight-recorder" },
    globalStorageUri: { fsPath: "C:\\User Files\\flight-recorder" },
    globalState: {
      get: (key, fallback) => state.has(key) ? state.get(key) : fallback,
      async update(key, value) { if (value === undefined) state.delete(key); else state.set(key, value); }
    }
  };
  return {
    vscode, context, handlers, state, contexts, writes, messages, output, external, providers, answers,
    origin: () => configuredOrigin, changes: () => changes,
    setCancelled(value) { cancelled = value; },
    changeOrigin(value) {
      configuredOrigin = value;
      configListeners.forEach(listener => listener({ affectsConfiguration: () => true }));
    }
  };
}
