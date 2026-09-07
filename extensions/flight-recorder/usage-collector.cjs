const path = require("node:path");
const os = require("node:os");
const { validateServerUrl } = require("./webview.cjs");

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const observationFields = [
  "id", "model", "timestamp", "quality", "inputTokens", "outputTokens",
  "estimatedInputTokens", "estimatedOutputTokens", "cacheReadTokens", "cacheWriteTokens", "nanoAiu"
];

class CollectionError extends Error {
  constructor(message, status) { super(message); this.name = "CollectionError"; this.status = status; }
}

async function recorderRequest(origin, route, { fetchImpl = fetch, method = "GET", body, signal } = {}) {
  const url = new URL(route, validateServerUrl(origin));
  if (url.origin !== validateServerUrl(origin).origin || !url.pathname.startsWith("/api/")) {
    throw new CollectionError("Usage collection requires a loopback recorder API.");
  }
  const timeout = AbortSignal.timeout(15000);
  const response = await fetchImpl(url, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" }, redirect: "error", cache: "no-store",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });
  if (!response.ok) {
    await response.body?.cancel();
    const hint = response.status === 404 ? "Update the recorder API or select a run that still exists."
      : response.status === 409 ? "The run/source changed or contains overlapping usage. Select a dedicated run; nothing was overwritten."
        : response.status === 400 ? "The source snapshot was rejected. Check supported format and count limits."
          : "Check the recorder and retry explicitly.";
    throw new CollectionError(`Recorder HTTP ${response.status}. ${hint}`, response.status);
  }
  if (response.status === 204) return null;
  const reader = response.body?.getReader();
  if (!reader) throw new CollectionError("Recorder response has no body.");
  let text = "";
  let size = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new CollectionError("Recorder response exceeded the collection size limit.");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); }
    catch { throw new CollectionError("Recorder returned an invalid JSON acknowledgement."); }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

function importBody(snapshot, expectedRevision) {
  if (!snapshot || !digest.test(snapshot.sourceId) || !digest.test(snapshot.revision) ||
      !["vscode-chat", "copilot-cli"].includes(snapshot.sourceKind) ||
      !Array.isArray(snapshot.observations) || !snapshot.observations.length || snapshot.observations.length > 1000) {
    throw new CollectionError("No supported usage observations were found. No usage was imported.");
  }
  return {
    sourceKind: snapshot.sourceKind, format: snapshot.format, revision: snapshot.revision, expectedRevision,
    observations: snapshot.observations.map(item => Object.fromEntries(observationFields
      .filter(key => item[key] !== undefined).map(key => [key, item[key]])))
  };
}

class UsageCollection {
  constructor({ source, sourceId, runId, origin, allowEstimates = false, readSource, fetchImpl = fetch,
    ensureAllowed = () => {}, report = () => {}, onError = () => {}, intervalMs = 10000,
    schedule = setInterval, unschedule = clearInterval }) {
    if (!uuid.test(runId) || !digest.test(sourceId)) throw new CollectionError("Choose a valid recorder run and source.");
    this.source = source;
    this.sourceId = sourceId;
    this.runId = runId;
    this.origin = validateServerUrl(origin).origin;
    this.allowEstimates = allowEstimates;
    this.readSource = readSource;
    this.fetchImpl = fetchImpl;
    this.ensureAllowed = ensureAllowed;
    this.report = report;
    this.onError = onError;
    this.schedule = schedule;
    this.unschedule = unschedule;
    this.intervalMs = intervalMs;
    this.inFlight = null;
    this.timer = null;
    this.closed = false;
    this.lastResult = null;
    this.lastError = null;
    this.controller = new AbortController();
  }

  pause() {
    if (this.timer !== null) this.unschedule(this.timer);
    this.timer = null;
  }

  async sync() {
    if (this.closed) throw new CollectionError("Usage collection is stopped.");
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.importSnapshot().then(result => {
      this.lastError = null;
      this.lastResult = result;
      this.report(result);
      return result;
    }).catch(error => {
      this.lastError = error;
      this.pause();
      throw error;
    }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async importSnapshot() {
    this.ensureAllowed(this.origin);
    const options = { fetchImpl: this.fetchImpl, signal: this.controller.signal };
    const run = await recorderRequest(this.origin, `/api/runs/${this.runId}`, options);
    if (run?.id?.toLowerCase() !== this.runId.toLowerCase()) throw new CollectionError("Recorder returned a different run.");
    if (run.usageImports != null && !Array.isArray(run.usageImports)) throw new CollectionError("Unsupported import cursor metadata.");
    const cursors = run.usageImports ?? [];
    if (cursors.some(cursor => cursor.sourceId !== this.sourceId)) {
      throw new CollectionError("This run is already bound to another session. Choose a dedicated run.", 409);
    }
    const cursor = cursors.find(item => item.sourceId === this.sourceId);
    this.ensureAllowed(this.origin);
    const snapshot = await this.readSource(this.source, { allowEstimates: this.allowEstimates });
    if (snapshot.sourceId !== this.sourceId) throw new CollectionError("Source identity changed. Select the session again.");
    if (this.closed || this.controller.signal.aborted) throw new CollectionError("Collection stopped before import.");
    this.ensureAllowed(this.origin);
    const body = importBody(snapshot, cursor?.revision ?? null);
    const acknowledgement = await recorderRequest(this.origin,
      `/api/runs/${this.runId}/usage-imports/${this.sourceId}`, { ...options, method: "PUT", body });
    if (!acknowledgement || acknowledgement.sourceId !== this.sourceId || acknowledgement.revision !== snapshot.revision ||
        typeof acknowledgement.changed !== "boolean" || acknowledgement.importedCount !== body.observations.length) {
      throw new CollectionError("Recorder import acknowledgement did not match the snapshot. Verify the run before retrying.");
    }
    const qualities = { measured: 0, estimated: 0, unavailable: 0 };
    for (const item of body.observations) if (Object.hasOwn(qualities, item.quality)) qualities[item.quality]++;
    return { ...acknowledgement, qualities, warnings: snapshot.warnings ?? [] };
  }

  async start() {
    await this.sync();
    if (this.closed) return;
    this.pause();
    this.timer = this.schedule(() => {
      void this.sync().catch(error => this.onError(error));
    }, this.intervalMs);
    this.timer?.unref?.();
  }

  async stop() {
    this.pause();
    this.closed = true;
    // Wait for the owned request rather than claiming cancellation undid a server write.
    if (this.inFlight) await this.inFlight;
  }

  dispose() {
    this.pause();
    this.closed = true;
    this.controller.abort();
  }
}

function collectionMessage(error) {
  if (error instanceof CollectionError || error?.name === "SourceError") return error.message;
  return "Local usage collection failed. Check source access and recorder availability; no raw session content is shown.";
}

function registerUsageCollection(vscode, context, { getOrigin, open, sourceApi, fetchImpl = fetch,
  schedule, unschedule } = {}) {
  let output;
  let collection;
  let ownedRun = false;
  let selecting = false;
  let cancelledSelection = false;
  let disposed = false;
  const sources = () => sourceApi ?? require("./usage-sources.cjs");
  const log = message => {
    if (!output) {
      output = vscode.window.createOutputChannel("Flight Recorder Usage");
      context.subscriptions.push(output);
    }
    output.appendLine(message);
  };
  const ensureLocal = origin => {
    if (!vscode.workspace.isTrusted || vscode.env.remoteName ||
        (vscode.UIKind && vscode.env.uiKind === vscode.UIKind.Web)) {
      throw new CollectionError("Usage collection requires a trusted local desktop window.");
    }
    if (disposed) throw new CollectionError("Usage collector has been disposed.");
    const configured = validateServerUrl(getOrigin()).origin;
    if (origin && origin !== configured) throw new CollectionError("Recorder URL changed. Stop collection and explicitly bind the new endpoint.");
    return configured;
  };
  const request = (origin, route, options) => recorderRequest(origin, route, { fetchImpl, ...options });
  const onError = error => {
    log(collectionMessage(error));
    void vscode.window.showErrorMessage(`Flight Recorder Usage paused: ${collectionMessage(error)}`);
  };

  async function chooseSource() {
    const mode = await vscode.window.showQuickPick([
      { label: "Discover local Copilot sessions", mode: "discover" },
      { label: "Choose a VS Code Chat JSON / JSONL file", mode: "vscode-chat" },
      { label: "Choose a Copilot CLI database / events file", mode: "copilot-cli" }
    ], { title: "Flight Recorder: Select usage source" });
    if (!mode) return;
    let selected;
    if (mode.mode === "discover") {
      const discovered = await sources().discoverSources({
        vscodeUserPath: path.dirname(path.dirname(context.globalStorageUri.fsPath)),
        copilotHome: path.join(os.homedir(), ".copilot")
      });
      if (!discovered.length) throw new CollectionError("No supported session files found in this profile. Choose a file manually or use a newer supported Copilot runtime.");
      const item = await vscode.window.showQuickPick(discovered.map(source => ({
        label: source.label, description: source.kind, detail: source.path, source
      })), { title: "Choose the session you intend to record (paths stay local)", matchOnDescription: true });
      selected = item?.source;
    } else {
      const files = await vscode.window.showOpenDialog({
        canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
        title: "Choose your local Copilot usage source",
        filters: { "Copilot sessions": mode.mode === "vscode-chat" ? ["json", "jsonl"] : ["db", "jsonl"] }
      });
      if (files?.[0]) selected = { kind: mode.mode, path: files[0].fsPath };
    }
    if (selected && path.extname(selected.path).toLowerCase() === ".db" && !selected.sessionId) {
      const sessions = await sources().listDatabaseSessions(selected.path);
      if (!sessions.length) throw new CollectionError("This database contains no supported usage sessions.");
      const item = await vscode.window.showQuickPick(sessions.map(source => ({
        label: source.label, description: source.modifiedAt, source
      })), { title: "Select a Copilot database session (not the newest automatically)" });
      selected = item?.source;
    }
    return selected;
  }

  async function enable() {
    ensureLocal();
    if (selecting || collection) throw new CollectionError("A collector is already selected or running. Stop it before selecting another session.");
    selecting = true;
    cancelledSelection = false;
    const stillSelecting = () => {
      ensureLocal();
      if (cancelledSelection) throw new CollectionError("Session selection was cancelled. No collection will start.");
    };
    try {
      const consent = await vscode.window.showInformationMessage(
        "Allow read-only access to your local Copilot session storage? Session files can contain private conversations. " +
        "Only allowlisted model/count/billing metadata and opaque IDs are sent to your selected local recorder, never text or file paths. " +
        "Collection is opt-in for this window, not across all users or profiles.",
        { modal: true }, "Choose Session"
      );
      if (consent !== "Choose Session") return;
      stillSelecting();
      const source = await chooseSource();
      if (!source) return;
      stillSelecting();
      const estimates = await vscode.window.showQuickPick([
        { label: "Measured usage only", description: "Missing fields stay unavailable", allow: false },
        { label: "Also estimate visible text when measurements are absent",
          description: "Approximate characters / 4, not full model context or billed usage", allow: true }
      ], { title: "Flight Recorder: Usage quality" });
      if (!estimates) return;
      stillSelecting();
      const snapshot = await sources().readSource(source, { allowEstimates: estimates.allow });
      importBody(snapshot, null);
      stillSelecting();
      const origin = ensureLocal();
      const runs = await request(origin, "/api/runs");
      if (!Array.isArray(runs)) throw new CollectionError("Recorder returned an invalid run list.");
      const run = await vscode.window.showQuickPick([
        { label: "Create a dedicated session-usage run (recommended)", create: true },
        ...runs.filter(item => uuid.test(item.id)).map(item => ({
          label: `Existing run ${item.id.slice(0, 8)}`, description: String(item.request),
          detail: item.id, runId: item.id
        }))
      ], { title: "Bind this entire Copilot session to a recorder run" });
      if (!run) return;
      stillSelecting();
      const confirm = await vscode.window.showInformationMessage(
        `Import the entire selected session into ${run.create ? "a new dedicated run" : run.runId} at ${origin}? ` +
        "This is not automatically limited to one task. Do not combine it with SDK/manual token records for the same calls. " +
        "Repeated snapshots update the same observations. Only one session source per run is supported.",
        { modal: true }, "Start Collection"
      );
      if (confirm !== "Start Collection") return;
      stillSelecting();
      ensureLocal(origin);
      let runId = run.runId;
      if (run.create) {
        const created = await request(origin, "/api/runs", { method: "POST", body: {
          request: "Imported Copilot session usage", entryPointAgent: "local-usage-collector",
          requestingIdentity: "local-developer", recordingMode: 1
        } });
        if (!uuid.test(created?.id)) throw new CollectionError("Recorder did not return a valid run ID.");
        runId = created.id;
      }
      if (cancelledSelection || disposed) {
        log(`Selection cancelled. Run ${runId} was not bound or completed; inspect it before retrying.`);
        return;
      }
      ownedRun = run.create === true;
      collection = new UsageCollection({
        source, sourceId: snapshot.sourceId, runId, origin, allowEstimates: estimates.allow,
        readSource: sources().readSource, fetchImpl, ensureAllowed: ensureLocal, schedule, unschedule, onError,
        report(result) {
          const quality = result.qualities;
          log(`${result.changed ? "Updated" : "Unchanged"} run ${runId}: ${quality.measured} measured, ${quality.estimated} estimated, ${quality.unavailable} unavailable observations.`);
          for (const warning of result.warnings) log(warning);
        }
      });
      log(`Bound ${source.kind} to run ${runId}. Polling every 10 seconds while this window remains open.`);
      await collection.start();
      await vscode.window.showInformationMessage(
        "Local usage collection is active. View imported events and their quality in the recorder. Stop collection before finishing this run.",
        "Open Recorder"
      ).then(async selected => { if (selected === "Open Recorder") await open(runId); });
    } finally { selecting = false; }
  }

  async function stop() {
    cancelledSelection = true;
    if (!collection) {
      await vscode.window.showInformationMessage("No local usage collection is active.");
      return;
    }
    const stopped = collection;
    try { await stopped.stop(); }
    catch (error) { log(`Final import did not complete: ${collectionMessage(error)}`); }
    const complete = ownedRun && !stopped.lastError;
    collection = undefined;
    ownedRun = false;
    if (complete) {
      ensureLocal(stopped.origin);
      await request(stopped.origin, `/api/runs/${stopped.runId}/complete`, { method: "POST" });
    }
    log(`Collection stopped for run ${stopped.runId}. Local binding discarded. ${complete ? "Collector-owned run completed." : "Run lifecycle unchanged."}`);
    await vscode.window.showInformationMessage(
      `Collection stopped. ${complete ? "The dedicated usage run is completed." : "The selected run was not completed; review any import errors."}`
    );
  }

  const commands = {
    "flightRecorder.collectUsage": enable,
    "flightRecorder.importUsage": async () => {
      ensureLocal();
      if (!collection) throw new CollectionError("Choose Collect Local Copilot Usage first.");
      await collection.start();
    },
    "flightRecorder.stopUsage": stop,
    "flightRecorder.usageStatus": async () => {
      log(collection
        ? `Run ${collection.runId}; ${collection.timer ? "polling" : "paused"}; ${collection.lastError ? collectionMessage(collection.lastError) : "no import error"}. Source path and session selection are kept only in this window.`
        : "Collection is off. No source discovery or session reads occur on extension activation.");
      output.show();
    }
  };
  for (const [id, handler] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
      try { await handler(); }
      catch (error) { onError(error); }
    }));
  }
  context.subscriptions.push({ dispose() { disposed = true; collection?.dispose(); collection = undefined; } });
}

module.exports = { UsageCollection, registerUsageCollection, recorderRequest, importBody, CollectionError };
