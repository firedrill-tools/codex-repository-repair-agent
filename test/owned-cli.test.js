import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { childEnvironment } from "../src/commands.js";
import { verifyWorkspace } from "../src/repair.js";
import { fixture, cleanup, exited } from "./helpers/owned.js";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
function start(t, f, extra = []) {
  const env = childEnvironment();
  delete env.CODEX_API_KEY;
  env.OPENAI_API_KEY = "synthetic-only-cli-key";
  const child = spawn(
    process.execPath,
    [
      cli,
      "--codex-path",
      f.cliPath,
      "--model",
      "synthetic-offline",
      "--output-root",
      path.join(f.directory, "runs"),
      ...extra,
    ],
    {
      cwd: f.directory,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
      killSignal: "SIGKILL",
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (bytes) => {
    stdout += bytes;
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });
  return {
    child,
    completed: once(child, "close").then(([code, signal]) => ({
      code,
      signal,
      stdout,
      stderr,
    })),
  };
}
async function ready(f, stage, completed) {
  let timer;
  try {
    await Promise.race([
      completed.then((result) => {
        throw new Error(
          `CLI stopped before fixture readiness: ${result.stderr} ${result.stdout}`,
        );
      }),
      new Promise((resolve, reject) => {
        const began = performance.now();
        timer = setInterval(() => {
          try {
            const record = JSON.parse(fs.readFileSync(f.record));
            if (!stage || record.stage === stage) {
              resolve();
              return;
            }
          } catch {}
          if (performance.now() - began > 10000)
            reject(new Error("Target readiness timed out"));
        }, 20);
      }),
    ]);
  } finally {
    clearInterval(timer);
  }
}

test(
  "normal owned CLI uses actual SDK/public relay and preserves complete private successful evidence",
  { timeout: 30000 },
  async (t) => {
    const f = fixture(t, "upgrade"),
      operation = start(t, f),
      result = await operation.completed;
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const output = JSON.parse(result.stdout),
      report = JSON.parse(fs.readFileSync(output.reportPath));
    cleanup(t, report);
    assert.equal(report.passed, true);
    assert.equal(report.agent_kind, "native_sdk");
    assert.equal(
      report.agentResult.process_ownership,
      "owned public executable relay",
    );
    assert.equal(
      report.commands.every(
        (record) => record.result?.lifecycle.group_exit_confirmed,
      ),
      true,
    );
    assert.equal(fs.statSync(output.reportPath).mode & 0o777, 0o600);
    exited(f, report.agentResult);
  },
);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  test(
    `normal owned CLI ${signal} drains a signal-ignoring target and publishes failure`,
    { timeout: 30000 },
    async (t) => {
      const f = fixture(t, "ignore"),
        operation = start(t, f);
      await ready(f, null, operation.completed);
      operation.child.kill(signal);
      const result = await operation.completed;
      assert.equal(result.signal, null);
      assert.equal(
        result.code,
        signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129,
        result.stderr + result.stdout,
      );
      const output = JSON.parse(result.stdout),
        report = JSON.parse(fs.readFileSync(output.reportPath));
      cleanup(t, report);
      assert.equal(report.passed, false);
      assert.equal(report.status, "failed");
      exited(f, report.agentResult);
      const before = fs.readFileSync(output.reportPath);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(fs.readFileSync(output.reportPath), before);
    },
  );
test(
  "normal owned CLI cancellation after an upgrade retains original edits and stops further command dispatch",
  { timeout: 30000 },
  async (t) => {
    const f = fixture(t, "upgrade-hold"),
      operation = start(t, f);
    await ready(f, "upgraded", operation.completed);
    operation.child.kill("SIGTERM");
    const result = await operation.completed;
    assert.equal(result.code, 143, result.stderr + result.stdout);
    const output = JSON.parse(result.stdout),
      report = JSON.parse(fs.readFileSync(output.reportPath));
    cleanup(t, report);
    assert.equal(report.passed, false);
    assert.deepEqual(report.verification.paths, ["src/quote.js"]);
    assert.equal(report.verification.publicChecks, null);
    exited(f, report.agentResult);
    const confirmed = await verifyWorkspace(
      report.workspace,
      "repair",
      report.baseline,
    );
    if (confirmed.checkDir)
      t.after(() =>
        fs.rmSync(confirmed.checkDir, { recursive: true, force: true }),
      );
    assert.equal(confirmed.passed, true, JSON.stringify(confirmed.error));
  },
);
