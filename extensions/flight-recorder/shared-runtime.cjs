const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { mkdir } = require("node:fs/promises");
const { promisify } = require("node:util");
const { validateServerUrl } = require("./webview.cjs");

const exec = promisify(execFile);

const profiles = Object.freeze({
  "flightRecorder.chat": Object.freeze({
    name: "Flight Recorder",
    instructions: "Answer accurately and concisely. Do not use tools or modify files. State uncertainty explicitly."
  }),
  "flightRecorder.review": Object.freeze({
    name: "Flight Recorder Review",
    instructions: "Review the supplied material for correctness, regressions, security risks, and missing tests. Lead with concrete findings. Do not modify files."
  })
});

function asError(error, message) {
  return error instanceof Error ? error : new Error(message, { cause: error });
}

function throwIfAborted(signal) {
  if (signal.aborted) throw new Error("Request cancelled.");
}

function cancellationPromise(signal) {
  if (signal.aborted) return Promise.reject(new Error("Request cancelled."));
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("Request cancelled.")), { once: true }));
}

function chatHistory(vscode, context, prompt) {
  const messages = [];
  for (const turn of context?.history ?? []) {
    if (turn instanceof vscode.ChatRequestTurn) messages.push(`User: ${turn.prompt}`);
    if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response.map(part => part?.value?.value).filter(value => typeof value === "string").join("");
      if (text) messages.push(`Assistant: ${text}`);
    }
  }
  messages.push(`User: ${prompt}`);
  return messages.join("\n\n");
}

async function recorderRequest(origin, route, { method = "GET", body, fetchImpl, signal } = {}) {
  const response = await fetchImpl(new URL(route, origin), {
    method, redirect: "error", signal,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Flight Recorder returned HTTP ${response.status}.`);
  }
  return response.status === 204 ? undefined : response.json();
}

async function discoverCopilotCli(execFile = exec) {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const { stdout } = await execFile(command, ["copilot"], { windowsHide: true, encoding: "utf8" });
  const paths = stdout.split(/\r?\n/u).map(value => value.trim()).filter(Boolean);
  const path = process.platform === "win32"
    ? paths.find(value => /\.exe$/iu.test(value) && !/[\\/]WindowsApps[\\/]/iu.test(value))
      ?? paths.find(value => /\.exe$/iu.test(value)) ?? paths[0]
    : paths[0];
  if (!path) throw new Error("GitHub Copilot CLI was not found on PATH.");
  return path;
}

class SharedCopilotRuntime {
  constructor({ vscode, getOrigin, getPrices = () => undefined, loadSdk, attachUsage, storagePath, fetchImpl = fetch, findCli = discoverCopilotCli }) {
    this.vscode = vscode;
    this.getOrigin = getOrigin;
    this.getPrices = getPrices;
    this.loadSdk = loadSdk;
    this.attachUsage = attachUsage;
    this.storagePath = storagePath;
    this.fetchImpl = fetchImpl;
    this.findCli = findCli;
    this.clientPromise = undefined;
    this.disposed = false;
  }

  async client() {
    if (this.disposed) throw new Error("The shared Copilot runtime is stopped.");
    if (!this.clientPromise) this.clientPromise = this.startClient().catch(error => {
      this.clientPromise = undefined;
      throw error;
    });
    return this.clientPromise;
  }

  async startClient() {
    if (this.storagePath) await mkdir(this.storagePath, { recursive: true });
    const [{ CopilotClient, RuntimeConnection }, cliPath] = await Promise.all([this.loadSdk(), this.findCli()]);
    const client = new CopilotClient({
      connection: RuntimeConnection.forStdio({ path: cliPath }),
      mode: "empty", useLoggedInUser: true,
      baseDirectory: this.storagePath
    });
    await client.start();
    return client;
  }

  async handle(participantId, request, context, stream, cancellation) {
    const profile = profiles[participantId];
    if (!profile) throw new Error("Unknown Flight Recorder participant.");
    if (this.disposed) throw new Error("The shared Copilot runtime is stopped.");
    const origin = validateServerUrl(this.getOrigin()).origin;
    const controller = new AbortController();
    const cancel = cancellation?.onCancellationRequested?.(() => controller.abort());
    let run;
    let task;
    let session;
    let capture;
    try {
      run = await recorderRequest(origin, "/api/runs", { method: "POST", fetchImpl: this.fetchImpl, signal: controller.signal, body: {
        request: `${profile.name} chat request`, entryPointAgent: participantId,
        requestingIdentity: "vscode-chat-participant", recordingMode: 1
      } });
      const taskId = randomUUID();
      task = await recorderRequest(origin, `/api/runs/${run.id}/events`, { method: "POST", fetchImpl: this.fetchImpl,
        signal: controller.signal, body: {
          type: 0, status: 0, name: `${profile.name} turn`, taskId,
          attributes: { "flightrecorder.task.lifecycle": "start", "flightrecorder.task.source": "prompt",
            "flightrecorder.attribution.method": "explicit-task", "flightrecorder.attribution.confidence": "1.0" }
        } });
      throwIfAborted(controller.signal);
      const client = await this.client();
      throwIfAborted(controller.signal);
      session = await client.createSession({
        model: request.model?.family,
        availableTools: [], excludedTools: ["builtin:*", "mcp:*", "custom:*"],
        systemMessage: { mode: "replace", content: profile.instructions },
        skipCustomInstructions: true, streaming: false,
        onPermissionRequest: () => ({ kind: "denied-no-approval-rule-and-could-not-request-from-user" })
      });
      throwIfAborted(controller.signal);
      capture = await this.attachUsage(session, {
        runId: run.id, parentEventId: task.id, taskId, serverUrl: origin,
        transport: "otlp", prices: this.getPrices(),
        agentName: participantId.replaceAll(/[^a-z0-9._-]/giu, "-")
      });
      throwIfAborted(controller.signal);
      const response = await Promise.race([
        session.sendAndWait({ prompt: chatHistory(this.vscode, context, request.prompt) }),
        cancellationPromise(controller.signal)
      ]);
      if (!response?.data?.content) throw new Error("Copilot returned no assistant response.");
      stream.markdown(response.data.content);
      await capture.detach();
      capture = undefined;
      await recorderRequest(origin, `/api/runs/${run.id}/events`, { method: "POST", fetchImpl: this.fetchImpl, body: {
        type: 0, status: 1, name: `Complete: ${profile.name} turn`, taskId,
        attributes: { "flightrecorder.task.lifecycle": "complete", "flightrecorder.attribution.method": "explicit-task",
          "flightrecorder.attribution.confidence": "1.0" }
      } });
      await recorderRequest(origin, `/api/runs/${run.id}/complete`, { method: "POST", fetchImpl: this.fetchImpl });
      return { metadata: { flightRecorderRunId: run.id } };
    } catch (cause) {
      const error = asError(cause, "Shared Copilot runtime failed.");
      if (run?.id) {
        try {
          const taskAttributes = task?.taskId ? {
            "flightrecorder.task.lifecycle": "complete", "flightrecorder.attribution.method": "explicit-task",
            "flightrecorder.attribution.confidence": "1.0"
          } : undefined;
          await recorderRequest(origin, `/api/runs/${run.id}/events`, { method: "POST", fetchImpl: this.fetchImpl, body: {
            type: 0, status: controller.signal.aborted ? 3 : 2, name: `${profile.name} turn failed`,
            taskId: task?.taskId, parentEventId: task?.id, output: error.message, attributes: taskAttributes
          } });
          await recorderRequest(origin, `/api/runs/${run.id}/complete`, { method: "POST", fetchImpl: this.fetchImpl });
        } catch { }
      }
      throw error;
    } finally {
      cancel?.dispose?.();
      if (capture) try { await capture.detach(); } catch { }
      if (session) try { await session.disconnect(); } catch { }
    }
  }

  async dispose() {
    this.disposed = true;
    const pending = this.clientPromise;
    this.clientPromise = undefined;
    if (!pending) return;
    try { await (await pending).stop(); } catch { }
  }
}

function registerSharedRuntime(vscode, context, options) {
  const runtime = new SharedCopilotRuntime({ vscode, ...options });
  for (const id of Object.keys(profiles)) {
    const participant = vscode.chat.createChatParticipant(id, async (request, history, stream, token) => {
      try { return await runtime.handle(id, request, history, stream, token); }
      catch (error) { return { errorDetails: { message: error.message } }; }
    });
    participant.iconPath = new vscode.ThemeIcon("pulse");
    context.subscriptions.push(participant);
  }
  context.subscriptions.push({ dispose: () => { void runtime.dispose(); } });
  return runtime;
}

module.exports = { SharedCopilotRuntime, registerSharedRuntime, profiles, discoverCopilotCli };