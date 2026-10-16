import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  runCodex as runRepairCodex,
  runScenario as runMaintenance,
} from "../src/repair.js";
const runCodex = (workspace, config) =>
  runRepairCodex(workspace, "repair", config);
import { processAlive, groupAlive } from "../src/processes.js";
import { fixture, options, cleanup, exited } from "./helpers/owned.js";

test("owned real SDK relay upgrades through original CLI bytes and separates SDK-defaulted cache usage", async (t) => {
  const f = fixture(t, "upgrade"),
    report = await runMaintenance({
      outputRoot: f.directory,
      agent: (workspace, scenario, config) =>
        runCodex(workspace, { ...config, ...options(f) }),
    });
  cleanup(t, report);
  assert.equal(
    report.passed,
    true,
    JSON.stringify({
      agentError: report.agentError,
      runnerError: report.runnerError,
      verification: report.verification?.error,
      observation: report.agentResult?.error,
    }),
  );
  const observed = report.agentResult,
    cli = observed.cli,
    last = cli.usage_reports.at(-1);
  assert.equal(observed.usage.cache_write_input_tokens, 0);
  assert.equal(last.fields.cache_write_input_tokens.state, "unknown");
  assert.equal(last.fields.total_tokens.value, 99);
  assert.equal(cli.records.at(-1).body.unknown.preserved, true);
  assert.equal(cli.stdin.sha256, observed.prompt_sha256);
  assert.ok(
    Buffer.from(cli.stdout.base64, "base64")
      .toString()
      .includes('"unknown":{"preserved":true}'),
  );
  assert.equal(
    report.commands.every(
      (record) =>
        record.status === "finished" &&
        record.result.lifecycle.group_exit_confirmed,
    ),
    true,
  );
  assert.equal(
    JSON.stringify(report).includes("synthetic-not-a-paid-key"),
    false,
  );
  exited(f, observed);
});
for (const mode of ["ignore", "grandchild", "late"])
  test(
    `owned ${mode} target is killed and drained after its deadline`,
    { timeout: 20000 },
    async (t) => {
      const f = fixture(t, mode);
      let observed;
      await assert.rejects(
        runCodex(f.directory, {
          ...options(f),
          timeoutMs: 1500,
          onObservation: (value) => {
            observed = structuredClone(value);
          },
        }),
        /deadline/,
      );
      assert.equal(observed.completed, false);
      assert.ok(
        observed.cli.lifecycle.kill_sent ||
          observed.cli.state.process.kill_sent,
      );
      exited(f, observed);
      const before = JSON.stringify(observed);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(JSON.stringify(observed), before);
    },
  );
for (const mode of [
  "missing-terminal",
  "missing-usage",
  "bad-json",
  "bad-utf8",
  "stderr-overflow",
  "stdout-overflow",
])
  test(
    `owned ${mode} preserves bounded original evidence and cannot succeed`,
    { timeout: 20000 },
    async (t) => {
      const f = fixture(t, mode);
      let observed;
      await assert.rejects(
        runCodex(f.directory, {
          ...options(f),
          onObservation: (value) => {
            observed = structuredClone(value);
          },
        }),
      );
      assert.equal(observed.completed, false);
      assert.ok(observed.cli.stdout.byte_length <= 1048576);
      assert.ok(observed.cli.stderr.byte_length <= 65536);
      exited(f, observed);
      if (mode === "bad-json")
        assert.ok(observed.cli.records.some((record) => record.parse_error));
      if (mode === "missing-usage")
        assert.equal(
          observed.cli.usage_reports.at(-1).fields.input_tokens.state,
          "unknown",
        );
    },
  );
for (const mode of ["zero", "invalid"])
  test(`owned ${mode} CLI reports retain their original counter meaning independently`, async (t) => {
    const f = fixture(t, mode),
      observed = await runCodex(f.directory, options(f)),
      fields = observed.cli.usage_reports.at(-1).fields;
    assert.equal(
      fields.input_tokens.state,
      mode === "zero" ? "observed" : "invalid",
    );
    assert.equal(fields.input_tokens.value, mode === "zero" ? 0 : null);
    assert.equal(observed.cost_usd, null);
    exited(f, observed);
  });
test("owned failed CLI report after a real upgrade retains original failed usage and compatible effects", async (t) => {
  const f = fixture(t, "failed-after-edit"),
    report = await runMaintenance({
      outputRoot: f.directory,
      agent: (workspace, scenario, config) =>
        runCodex(workspace, { ...config, ...options(f) }),
    });
  cleanup(t, report);
  assert.equal(report.passed, false);
  assert.equal(report.verification.passed, true);
  assert.equal(
    report.agentResult.cli.usage_reports.at(-1).fields.input_tokens.value,
    7,
  );
  assert.equal(report.agentResult.usage, null);
  exited(f, report.agentResult);
});

test("published Codex CLI entry point executes its version command in an owned group without a model", async (t) => {
  const { createRequire } = await import("node:module"),
    { runProcess } = await import("../src/processes.js"),
    { childEnvironment } = await import("../src/commands.js"),
    require = createRequire(import.meta.url),
    metadata = require.resolve("@openai/codex/package.json"),
    pkg = JSON.parse(fs.readFileSync(metadata));
  const f = fixture(t, "unused"),
    env = childEnvironment();
  env.CODEX_HOME = f.directory;
  const result = await runProcess({
    program: process.execPath,
    args: [path.resolve(path.dirname(metadata), pkg.bin.codex), "--version"],
    cwd: f.directory,
    env,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /0\.162\.1/);
  assert.equal(result.lifecycle.group_exit_confirmed, true);
});

test(
  "owned cancellation during delayed relay startup cannot dispatch a late target",
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t, "upgrade"),
      controller = new AbortController();
    let observed, controlDirectory;
    const operation = runCodex(f.directory, {
      ...options(f),
      signal: controller.signal,
      startupDelayMs: 2000,
      onObservation: (value) => {
        observed = structuredClone(value);
        if (value.cli?.prepared?.launcher_path)
          controlDirectory = path.dirname(value.cli.prepared.launcher_path);
      },
    });
    const deadline = performance.now() + 5000;
    while (
      !controlDirectory ||
      !fs.existsSync(path.join(controlDirectory, "state.json"))
    ) {
      if (performance.now() > deadline)
        throw new Error("Relay startup did not register");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort(new Error("Cancelled relay startup"));
    await assert.rejects(operation, /Cancelled relay startup/);
    assert.equal(observed.completed, false);
    assert.equal(observed.cli.lifecycle.group_exit_confirmed, true);
    assert.equal(observed.cli.lifecycle.relay_exit_confirmed, true);
    assert.equal(fs.existsSync(f.record), false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(f.record), false);
  },
);

test("owned executable startup failure retains lifecycle and removes private configuration", async (t) => {
  const f = fixture(t, "unused");
  fs.chmodSync(f.cliPath, 0o600);
  let observed;
  await assert.rejects(
    runCodex(f.directory, {
      ...options(f),
      onObservation: (value) => {
        observed = structuredClone(value);
      },
    }),
  );
  assert.equal(observed.completed, false);
  assert.equal(observed.cli.state.result.error.code, "EACCES");
  assert.equal(observed.cli.lifecycle.group_exit_confirmed, true);
  assert.equal(observed.runtime_home_removed, true);
  assert.equal(fs.existsSync(f.record), false);
});

test("owned recording failure after original CLI edits retains private failed evidence and prevents validation", async (t) => {
  const { saveReport } = await import("../src/evidence.js"),
    f = fixture(t, "upgrade");
  let tripped = false;
  const report = await runMaintenance({
    outputRoot: f.directory,
    agent: (workspace, scenario, config) =>
      runCodex(workspace, { ...config, ...options(f) }),
    writer: (file, value) => {
      if (
        !tripped &&
        value.agentResult?.cli?.records.some(
          (record) => record.body?.item?.type === "file_change",
        )
      ) {
        tripped = true;
        throw new Error("Original CLI recording unavailable");
      }
      saveReport(file, value);
    },
  });
  cleanup(t, report);
  assert.equal(report.passed, false);
  assert.equal(report.verification, null);
  assert.match(report.evidenceError, /recording unavailable/);
  assert.ok(
    report.agentResult.cli.records.some(
      (record) => record.body?.item?.type === "file_change",
    ),
  );
  exited(f, report.agentResult);
  const durable = JSON.parse(fs.readFileSync(report.reportPath));
  assert.equal(durable.status, "failed");
});

test("owned recording failure before SDK dispatch creates no target and removes private configuration", async (t) => {
  const f = fixture(t, "unused");
  let observed;
  await assert.rejects(
    runCodex(f.directory, {
      ...options(f),
      onObservation: (value) => {
        observed = structuredClone(value);
        throw new Error("Recorder failed before SDK dispatch");
      },
    }),
    (error) => {
      observed = error.observation;
      return /before SDK dispatch/.test(error.message);
    },
  );
  assert.equal(observed.completed, false);
  assert.equal(observed.cli.lifecycle.not_dispatched, true);
  assert.equal(observed.runtime_home_removed, true);
  assert.equal(fs.existsSync(f.record), false);
});

test(
  "cancelled delayed original-evidence write drains before the final failed receipt is published",
  { timeout: 20000 },
  async (t) => {
    const { saveReport } = await import("../src/evidence.js"),
      f = fixture(t, "upgrade-hold"),
      controller = new AbortController();
    let delayed = false;
    const report = await runMaintenance({
      outputRoot: f.directory,
      signal: controller.signal,
      agent: (workspace, scenario, config) =>
        runCodex(workspace, { ...config, ...options(f) }),
      writer: async (file, value) => {
        if (!delayed && value.agentResult?.events.length >= 3) {
          delayed = true;
          setTimeout(
            () => controller.abort(new Error("Cancel delayed recording")),
            25,
          );
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        saveReport(file, value);
      },
    });
    cleanup(t, report);
    assert.equal(report.status, "failed");
    assert.equal(report.passed, false);
    assert.equal(report.agentResult.sdk_operations_drained, true);
    exited(f, report.agentResult);
    const before = fs.readFileSync(report.reportPath);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(fs.readFileSync(report.reportPath), before);
  },
);

test(
  "uncooperative caller SDK remains caller-owned and cannot hang cleanup or claim drained work",
  { timeout: 15000 },
  async () => {
    let observed;
    const sdk = {
      startThread: () => ({
        id: "caller",
        runStreamed: async () => ({
          events: {
            next: () => new Promise(() => {}),
            return: async () => ({ done: true }),
          },
        }),
      }),
    };
    await assert.rejects(
      runCodex(os.tmpdir(), {
        sdk,
        timeoutMs: 20,
        onObservation: (value) => {
          observed = structuredClone(value);
        },
      }),
      /deadline/,
    );
    assert.equal(observed.completed, false);
    assert.equal(observed.process_ownership, "caller SDK");
    assert.equal(observed.sdk_operations_drained, false);
    assert.equal(observed.cli, undefined);
  },
);

test(
  "parent emergency cleanup drains separate jobs when the relay is itself stopped",
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t, "detached-grandchild"),
      controller = new AbortController();
    let observed, relay, target;
    t.after(() => {
      for (const pid of [relay, target?.pid, target?.grandchild])
        if (pid)
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
    });
    const operation = runCodex(f.directory, {
      ...options(f),
      timeoutMs: 15000,
      signal: controller.signal,
      onObservation: (value) => {
        observed = structuredClone(value);
        relay = value.cli?.state?.relay_pid ?? relay;
      },
    });
    const deadline = performance.now() + 7000;
    while (
      !relay ||
      !fs.existsSync(f.record) ||
      !JSON.parse(fs.readFileSync(f.record)).grandchild
    ) {
      if (performance.now() > deadline)
        throw new Error("Separate job was not prepared");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    target = JSON.parse(fs.readFileSync(f.record));
    process.kill(relay, "SIGSTOP");
    controller.abort(new Error("Stopped relay cancellation"));
    await assert.rejects(operation, /Stopped relay cancellation/);
    assert.equal(observed.cli.lifecycle.emergency_tree_cleanup, true);
    assert.equal(observed.cli.lifecycle.descendants_exit_confirmed, true);
    assert.ok(observed.cli.lifecycle.tree.observed_groups.length >= 2);
    exited(f, observed);
  },
);

test("unsafe provider base URL is rejected before SDK dispatch and credentials stay out of evidence", async () => {
  for (const baseUrl of [
    "http://example.com/v1",
    "https://user:synthetic-secret@example.com/v1",
    "https://example.com/v1?token=synthetic-secret",
    "https://example.com/v1#synthetic-secret",
  ]) {
    let called = false,
      observed;
    await assert.rejects(
      runCodex(os.tmpdir(), {
        apiKey: "synthetic-key",
        baseUrl,
        sdkFactory: () => {
          called = true;
          throw new Error("must not dispatch");
        },
        onObservation: (value) => {
          observed = structuredClone(value);
        },
      }),
      /Provider base URL/,
    );
    assert.equal(called, false);
    assert.equal(observed.provider_base_url, null);
    assert.equal(JSON.stringify(observed).includes("synthetic-secret"), false);
  }
});
