import { spawn } from "node:child_process";
import { ProcessTree } from "./process-tree.js";
import { processAlive, groupAlive } from "./pids.js";
export { processAlive, groupAlive };
const info = (error) => ({
  name: error?.name ?? "Error",
  message: error?.message ?? String(error),
  code: error?.code ?? null,
});
export async function runProcess({
  program,
  args = [],
  cwd,
  env,
  signal,
  timeoutMs = 30000,
  stdoutLimit = 1048576,
  stderrLimit = 1048576,
  stdinLimit = 16384,
  inputStream,
  onStdin,
  onStdout,
  onStderr,
  onState,
  termGraceMs = 200,
  cleanupMs = 5000,
}) {
  if (process.platform === "win32")
    throw new Error("Owned POSIX process groups required");
  for (const [name, value, max] of [
    ["timeoutMs", timeoutMs, 300000],
    ["stdoutLimit", stdoutLimit, 1048576],
    ["stderrLimit", stderrLimit, 1048576],
    ["stdinLimit", stdinLimit, 1048576],
  ])
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new Error(`Invalid ${name}`);
  const lifecycle = {
    prepared_at: new Date().toISOString(),
    pid: null,
    pgid: null,
    spawned: false,
    exit_observed: false,
    close_observed: false,
    group_exit_confirmed: false,
    descendants_exit_confirmed: false,
    term_sent: false,
    kill_sent: false,
    reason: null,
    parent_listener_removed: false,
    tree: null,
  };
  if (signal?.aborted) {
    lifecycle.reason = info(signal.reason ?? new Error("Process cancelled"));
    lifecycle.group_exit_confirmed = true;
    lifecycle.descendants_exit_confirmed = true;
    lifecycle.parent_listener_removed = true;
    return {
      exitCode: null,
      signal: null,
      error: lifecycle.reason,
      stdout: "",
      stderr: "",
      lifecycle,
    };
  }
  return await new Promise((resolve) => {
    const stdout = [],
      stderr = [];
    let outBytes = 0,
      errBytes = 0,
      inBytes = 0,
      child,
      tree,
      error = null,
      exitCode = null,
      exitSignal = null,
      stopAt = null,
      termAt = null,
      exitedAt = null,
      settled = false,
      checking = false,
      freezeDone = true,
      nextSample = 0,
      timer,
      interval;
    const notify = () => {
      if (settled) return;
      try {
        onState?.(structuredClone(lifecycle));
      } catch (fault) {
        stop(fault);
      }
    };
    function stop(reason) {
      if (settled || stopAt !== null) return;
      error ??= info(reason);
      lifecycle.reason ??= info(reason);
      stopAt = performance.now();
      freezeDone = false;
      void (async () => {
        try {
          if (tree) {
            await tree.freeze({ deadline: stopAt + 1500 });
            lifecycle.tree = tree.status();
            tree.terminate();
            lifecycle.term_sent = true;
          }
          termAt = performance.now();
        } catch (fault) {
          lifecycle.inventory_error = info(fault);
          error ??= info(fault);
          tree?.kill();
          lifecycle.kill_sent = true;
        } finally {
          freezeDone = true;
          notify();
          void check(true);
        }
      })();
    }
    const cancelled = () =>
      stop(signal.reason ?? new Error("Process cancelled"));
    const inputData = (bytes) => {
      if (settled || stopAt !== null) return;
      const buffer = Buffer.from(bytes);
      inBytes += buffer.length;
      if (inBytes > stdinLimit) {
        stop(new Error("Process stdin byte limit exceeded"));
        return;
      }
      try {
        onStdin?.(buffer);
        if (!child.stdin.write(buffer)) {
          inputStream.pause();
          child.stdin.once("drain", () => {
            if (!settled && stopAt === null) inputStream.resume();
          });
        }
      } catch (fault) {
        stop(fault);
      }
    };
    const inputEnd = () => child?.stdin?.end();
    function finish() {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
      lifecycle.parent_listener_removed = true;
      inputStream?.removeListener("data", inputData);
      inputStream?.removeListener("end", inputEnd);
      if (child) {
        child.removeAllListeners("error");
        child.on("error", () => {});
        child.stdout?.removeAllListeners("data");
        child.stderr?.removeAllListeners("data");
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        if (!lifecycle.close_observed) child.unref();
      }
      lifecycle.finished_at = new Date().toISOString();
      try {
        onState?.(structuredClone(lifecycle));
      } catch (fault) {
        error ??= info(fault);
      }
      resolve({
        exitCode,
        signal: exitSignal,
        error,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        lifecycle: structuredClone(lifecycle),
      });
    }
    async function check(force = false) {
      if (settled || checking) return;
      checking = true;
      try {
        const now = performance.now();
        if (
          tree &&
          (force ||
            now >= nextSample ||
            stopAt !== null ||
            lifecycle.close_observed)
        ) {
          await tree.sample();
          nextSample = performance.now() + 100;
          const previousGroups = JSON.stringify(
            lifecycle.tree?.observed_groups,
          );
          lifecycle.tree = tree.status();
          if (previousGroups !== JSON.stringify(lifecycle.tree.observed_groups))
            notify();
          lifecycle.descendants_exit_confirmed = lifecycle.tree.exit_confirmed;
        } else if (!tree) lifecycle.descendants_exit_confirmed = true;
        lifecycle.group_exit_confirmed = !groupAlive(lifecycle.pgid);
        if (
          lifecycle.exit_observed &&
          !lifecycle.descendants_exit_confirmed &&
          stopAt === null &&
          performance.now() - exitedAt > 200
        )
          stop(new Error("Owned descendants outlived the command"));
        if (
          stopAt !== null &&
          freezeDone &&
          termAt !== null &&
          !lifecycle.descendants_exit_confirmed
        ) {
          if (performance.now() - termAt >= termGraceMs) {
            tree?.kill();
            lifecycle.kill_sent = true;
          } else tree?.terminate();
        }
        if (
          lifecycle.close_observed &&
          lifecycle.group_exit_confirmed &&
          lifecycle.descendants_exit_confirmed &&
          freezeDone
        )
          finish();
        else if (
          stopAt !== null &&
          freezeDone &&
          performance.now() - stopAt >= cleanupMs
        ) {
          error ??= info(
            new Error("Process tree cleanup could not be confirmed"),
          );
          finish();
        }
      } catch (fault) {
        lifecycle.inventory_error = info(fault);
        if (tree) tree.complete = false;
        lifecycle.descendants_exit_confirmed = false;
        stop(fault);
        if (
          stopAt !== null &&
          freezeDone &&
          performance.now() - stopAt >= cleanupMs
        )
          finish();
      } finally {
        checking = false;
      }
    }
    try {
      child = spawn(program, args, {
        cwd,
        env,
        detached: true,
        stdio: [inputStream ? "pipe" : "ignore", "pipe", "pipe"],
      });
      lifecycle.pid = child.pid ?? null;
      lifecycle.pgid = child.pid ?? null;
      if (child.pid) tree = new ProcessTree(child.pid);
      child.on("error", (fault) => {
        error ??= info(fault);
        stop(fault);
      });
      child.once("spawn", () => {
        lifecycle.spawned = true;
        notify();
        void check(true);
      });
      child.once("exit", (code, killed) => {
        exitCode = code;
        exitSignal = killed;
        lifecycle.exit_observed = true;
        exitedAt = performance.now();
        void check(true);
      });
      child.once("close", () => {
        lifecycle.close_observed = true;
        void check(true);
      });
      const capture = (chunks, maximum, kind, callback) => (bytes) => {
        if (settled) return;
        const buffer = Buffer.from(bytes),
          retained = kind === "stdout" ? outBytes : errBytes,
          part = buffer.subarray(0, Math.max(0, maximum - retained));
        if (part.length) {
          chunks.push(part);
          if (kind === "stdout") outBytes += part.length;
          else errBytes += part.length;
          try {
            callback?.(part);
          } catch (fault) {
            stop(fault);
          }
        }
        if (buffer.length > part.length)
          stop(new Error(`Process ${kind} byte limit exceeded`));
      };
      child.stdout.on("data", capture(stdout, stdoutLimit, "stdout", onStdout));
      child.stderr.on("data", capture(stderr, stderrLimit, "stderr", onStderr));
      child.stdin?.on("error", (fault) => {
        if (stopAt === null && !lifecycle.exit_observed) stop(fault);
      });
      if (inputStream) {
        inputStream.on("data", inputData);
        inputStream.once("end", inputEnd);
        if (inputStream.readableEnded) inputEnd();
      }
      signal?.addEventListener("abort", cancelled, { once: true });
      if (signal?.aborted) cancelled();
      timer = setTimeout(
        () => stop(new Error("Process deadline exceeded")),
        timeoutMs,
      );
      interval = setInterval(() => {
        void check();
      }, 20);
    } catch (fault) {
      error = info(fault);
      lifecycle.reason = info(fault);
      lifecycle.close_observed = true;
      lifecycle.group_exit_confirmed = true;
      lifecycle.descendants_exit_confirmed = true;
      finish();
    }
  });
}
