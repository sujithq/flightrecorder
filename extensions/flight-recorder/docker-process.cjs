"use strict";

const { spawn: nodeSpawn } = require("node:child_process");

class RecorderError extends Error {
  constructor(code, message, guide) {
    super(message);
    this.name = "RecorderError";
    this.code = code;
    if (guide) this.guide = guide;
  }
}

// Diagnostics are deliberately not a transcript of HTTP responses or process input.
function sanitize(text) {
  return String(text)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
    .replace(/((?:password|passwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/([A-Z]:[\\/]Users[\\/])[^\\/\r\n]+/gi, "$1[redacted]")
    .replace(/(\/(?:Users|home)\/)[^/\r\n]+/g, "$1[redacted]");
}

/**
 * execute(file, args, {cwd, env, signal, timeoutMs, onOutput}) -> {stdout, stderr}.
 * The injectable spawn has node:child_process.spawn's signature. Only this child
 * is signalled on cancellation/timeout; daemon-side work may still have occurred.
 */
function createExecutor({ spawn = nodeSpawn, maxOutputBytes = 4 * 1024 * 1024 } = {}) {
  return (file, args, options = {}) => new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new RecorderError("CANCELLED", "Operation cancelled."));
      return;
    }
    let child;
    let timer;
    let killTimer;
    let settled = false;
    let total = 0;
    const output = { stdout: "", stderr: "" };
    const lines = { stdout: "", stderr: "" };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      for (const stream of ["stdout", "stderr"]) {
        if (lines[stream]) options.onOutput?.(sanitize(lines[stream]));
      }
      if (error) {
        // Capture sanitized command diagnostics for error classification only.
        error.stdout = sanitize(output.stdout);
        error.stderr = sanitize(output.stderr);
        reject(error);
      } else resolve(output);
    };
    const terminate = (error) => {
      // Never signal a PID found by name, a daemon, or another operation's child.
      if (child && child.exitCode == null) {
        try { child.kill(); } catch (killError) {
          options.onOutput?.(`Unable to signal owned command: ${sanitize(killError.code || "process error")}`);
        }
        // On POSIX a child can ignore SIGTERM. Escalate only that same child,
        // never a process tree or a daemon. Windows kill already terminates it.
        killTimer = setTimeout(() => {
          if (child.exitCode == null) {
            try { child.kill("SIGKILL"); } catch {
              options.onOutput?.("Unable to terminate the owned Docker client.");
            }
          }
        }, 1_000);
        killTimer.unref();
      }
      finish(error);
    };
    const abort = () => terminate(new RecorderError("CANCELLED", "Operation cancelled; Docker state will be checked on the next operation."));
    try {
      child = spawn(file, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      finish(new RecorderError(error.code === "ENOENT" ? "DOCKER_MISSING" : "COMMAND_FAILED", "Unable to launch Docker."));
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => finish(new RecorderError(
      error.code === "ENOENT" ? "DOCKER_MISSING" : "COMMAND_FAILED", "Unable to execute Docker.")));
    child.once("close", (code) => {
      clearTimeout(killTimer);
      finish(code === 0 ? undefined : new RecorderError("COMMAND_FAILED", `Docker command exited with status ${code ?? "unknown"}.`));
    });
    for (const name of ["stdout", "stderr"]) {
      const stream = child[name];
      if (!stream) {
        terminate(new RecorderError("COMMAND_FAILED", `Docker ${name} stream is unavailable.`));
        return;
      }
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        if (settled) return;
        total += Buffer.byteLength(chunk);
        if (total > maxOutputBytes) {
          terminate(new RecorderError("COMMAND_FAILED", "Docker output exceeded the diagnostic limit."));
          return;
        }
        output[name] += chunk;
        lines[name] += chunk;
        const parts = lines[name].split(/\r?\n/);
        lines[name] = parts.pop();
        for (const line of parts) options.onOutput?.(sanitize(line));
      });
      stream.once("error", () => terminate(new RecorderError("COMMAND_FAILED", `Unable to read Docker ${name}.`)));
    }
    timer = setTimeout(() => terminate(new RecorderError("COMMAND_TIMEOUT", "Docker command timed out.")), options.timeoutMs ?? 30_000);
    if (options.signal?.aborted) abort();
  });
}

module.exports = { RecorderError, createExecutor, sanitize };
