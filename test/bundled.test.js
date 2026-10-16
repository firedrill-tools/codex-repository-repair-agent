import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCodex as runRepairCodex } from "../src/repair.js";
const runCodex = (workspace, config) =>
  runRepairCodex(workspace, "repair", config);
import { createWorkspace } from "../src/repair.js";
import { runProcess, processAlive } from "../src/processes.js";
import { childEnvironment } from "../src/commands.js";
import { bundledProvider, nodeCommand } from "./helpers/bundled-provider.js";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function assertDrained(observed) {
  assert.equal(observed.cli.source, "published @openai/codex bin");
  assert.equal(observed.cli.lifecycle.relay_exit_confirmed, true);
  assert.equal(observed.cli.lifecycle.group_exit_confirmed, true);
  assert.equal(observed.cli.lifecycle.descendants_exit_confirmed, true);
  assert.equal(observed.sdk_operations_drained, true);
  assert.equal(observed.runtime_home_removed, true);
}
test(
  "actual bundled SDK/CLI executes an upgrade through controlled HTTP SSE and normal private CLI validation",
  { timeout: 120000 },
  async (t) => {
    const source = `const fs=require('node:fs');const file='src/quote.js';fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('subtotalCents >= 5000','discountedCents >= 5000'));console.log('bundled-upgrade-proof');`;
    const provider = await bundledProvider(t, nodeCommand(source));
    const env = {
      ...childEnvironment(),
      OPENAI_API_KEY: "synthetic-not-a-paid-key",
    };
    const result = await runProcess({
      program: process.execPath,
      args: [
        fileURLToPath(new URL("../src/cli.js", import.meta.url)),
        "--model",
        "synthetic-offline",
        "--provider-base-url",
        provider.baseUrl,
        "--timeout-ms",
        "90000",
        "--output-root",
        provider.directory,
      ],
      cwd: provider.directory,
      env,
      timeoutMs: 110000,
    });
    const summary = JSON.parse(result.stdout),
      report = JSON.parse(fs.readFileSync(summary.reportPath));
    const toolEvidence = report.agentResult?.events
      .filter((event) =>
        ["command_execution", "error"].includes(event.item?.type),
      )
      .map((event) => ({
        type: event.type,
        item: {
          ...event.item,
          aggregated_output: event.item.aggregated_output?.slice(-4000),
        },
      }));
    assert.equal(
      result.exitCode,
      0,
      JSON.stringify({
        summary,
        toolEvidence,
        agentError: report.agentResult?.error,
        toolResults: provider.requests
          .flatMap((r) => r.input ?? [])
          .filter((i) => i.type === "function_call_output")
          .map((i) => ({
            ...i,
            output: (typeof i.output === "string"
              ? i.output
              : JSON.stringify(i.output)
            ).slice(-4000),
          })),
      }),
    );
    t.after(() => {
      for (const dir of [report.workspace, report.verification?.checkDir])
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });
    assert.equal(
      report.passed,
      true,
      JSON.stringify({ error: report.agentError, runner: report.runnerError }),
    );
    assert.equal(report.agent_kind, "native_sdk");
    assert.equal(report.agentResult.completed, true);
    assert.equal(report.verification.passed, true);
    assert.ok(provider.posts >= 2);
    assert.deepEqual(provider.faults, []);
    assert.equal(provider.requests[0].model, "synthetic-offline");
    // Linux may omit command items from CLI JSONL. The original upstream tool-result
    // request and independently validated source establish actual tool execution.
    const toolOutputs = provider.requests
      .flatMap((request) => request.input ?? [])
      .filter((item) => item.type === "function_call_output")
      .map((item) =>
        typeof item.output === "string"
          ? item.output
          : JSON.stringify(item.output),
      );
    assert.ok(
      toolOutputs.some(
        (output) =>
          output.includes("bundled-upgrade-proof") &&
          output.includes("Process exited with code 0"),
      ),
      JSON.stringify(toolOutputs),
    );
    assert.ok(report.agentResult.diagnostics.length > 0);
    assert.equal(
      report.agentResult.cli.stdin.sha256,
      report.agentResult.prompt_sha256,
    );
    assertDrained(report.agentResult);
  },
);
test(
  "actual bundled CLI cancellation drains its separate native tool job and TERM-ignoring grandchild",
  { timeout: 120000 },
  async (t) => {
    const provider = await bundledProvider(t, "placeholder", {
        holdAfterTool: true,
      }),
      workspace = await createWorkspace(),
      record = path.join(workspace, "job.json");
    // The command runs inside the disposable checkout; host process ancestry, never model output, authorizes cleanup.
    const worker = `const fs=require('node:fs'),{spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});process.send("ready");setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({pid:process.pid,grandchild:child.pid})));setInterval(()=>{},1000);`;
    // Provider takes the command by reference to keep setup paths owned by this fixture.
    // Replace the initial command before any request is dispatched.
    provider.setCommand(nodeCommand(worker));
    const controller = new AbortController();
    let observed;
    t.after(() => {
      // Only supervisor-observed host PIDs are identities; tool files can contain namespace PIDs.
      for (const member of observed?.cli?.lifecycle.tree?.members ??
        observed?.cli?.state?.process?.tree?.members ??
        [])
        if (member.pid > 1 && processAlive(member.pid))
          try {
            process.kill(member.pid, "SIGKILL");
          } catch {}
      fs.rmSync(workspace, { recursive: true, force: true });
    });
    const began = performance.now();
    const poll = setInterval(() => {
      if (fs.existsSync(record))
        controller.abort(new Error("Controlled bundled cancellation"));
      else if (provider.posts && performance.now() - began > 25000)
        controller.abort(
          new Error(
            "Bundled tool readiness failed: " +
              JSON.stringify(
                observed?.events
                  .filter((event) =>
                    ["command_execution", "error"].includes(event.item?.type),
                  )
                  .map((event) => ({
                    ...event,
                    item: {
                      ...event.item,
                      aggregated_output:
                        event.item.aggregated_output?.slice(-4000),
                    },
                  })),
              ),
          ),
        );
    }, 50);
    t.after(() => clearInterval(poll));
    await assert.rejects(
      runCodex(workspace, {
        apiKey: "synthetic-not-a-paid-key",
        model: "synthetic-offline",
        baseUrl: provider.baseUrl,
        timeoutMs: 90000,
        signal: controller.signal,
        onObservation: (value) => {
          observed = structuredClone(value);
        },
      }),
      /Controlled bundled cancellation/,
    );
    clearInterval(poll);
    assertDrained(observed);
    assert.equal(observed.completed, false);
    assert.ok(observed.cli.state.process.tree.observed_groups.length >= 2);
    assert.equal(observed.cli.state.process.tree.freeze_completed, true);
    const tree = observed.cli.state.process.tree;
    assert.ok(tree.members.length >= 4);
    for (const member of tree.members)
      assert.equal(processAlive(member.pid), false);
    assert.deepEqual(provider.faults, []);
    await sleep(50);
  },
);
