import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Codex } from "@openai/codex-sdk";
import { runScenario, runCodex } from "../src/repair.js";

async function fixture(t, mode) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "firedrill-codex-native-"));
  const child = path.join(temp, "synthetic-codex");
  // This executable replaces only the native CLI process in the actual SDK.
  // No provider credentials or production scripted path is involved.
  await writeFile(
    child,
    `#!${process.execPath}\n${String.raw`
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2), mode = process.env.SYNTHETIC_MODE;
const directory = args[args.indexOf('--cd') + 1];
fs.writeFileSync(process.env.CHILD_RECORD, JSON.stringify({ pid: process.pid, args, runtime_home: process.env.CODEX_HOME || null, has_provider_key: Boolean(process.env.CODEX_API_KEY), env_keys: Object.keys(process.env) }));
process.stdin.resume(); process.stdin.on('end', () => {
  const send = (value) => console.log(JSON.stringify(value));
  send({ type: 'thread.started', thread_id: 'synthetic-thread' }); send({ type: 'turn.started' });
  if (mode === 'repair' || mode === 'failed-after-edit') {
    const file = path.join(directory, 'src/quote.js');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('subtotalCents >= 5000', 'discountedCents >= 5000'));
    send({ type: 'item.completed', item: { id: 'file-1', type: 'file_change', status: 'completed', changes: [{ path: 'src/quote.js', kind: 'update' }] } });
  }
  if (mode === 'failed-after-edit') { send({ type: 'turn.failed', error: { message: 'synthetic failure after edit' } }); return; }
  if (mode === 'external-tool') send({ type: 'item.started', item: { id: 'external-1', type: 'mcp_tool_call', server: 'synthetic', tool: 'unknown_action', status: 'in_progress' } });
  if (mode === 'pending') send({ type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', status: 'in_progress', command: 'npm test' } });
  send({ type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: mode === 'blank' ? ' ' : 'Controlled final answer' } });
  if (mode === 'missing-terminal') return;
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'malformed') { console.log('{invalid'); return; }
  send({ type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 1 } });
});
`}`,
    { mode: 0o700 },
  );
  const record = path.join(temp, "child.json");
  const sdk = new Codex({
    codexPathOverride: child,
    env: { PATH: process.env.PATH, SYNTHETIC_MODE: mode, CHILD_RECORD: record },
  });
  t.after(() => rm(temp, { recursive: true, force: true }));
  return { sdk, temp, record, child };
}
async function stopped(record) {
  const { pid } = JSON.parse(await readFile(record));
  for (let tries = 0; tries < 60; tries++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`owned SDK child ${pid} remains running`);
}

test("actual native SDK protocol completes a bounded repair and retains SDK usage provenance", async (t) => {
  const f = await fixture(t, "repair");
  const report = await runScenario({
    outputRoot: f.temp,
    agent: (workspace, scenario, options) =>
      runCodex(workspace, scenario, { ...options, sdk: f.sdk }),
  });
  t.after(async () => {
    await rm(report.workspace, { recursive: true, force: true });
    if (report.verification?.checkDir)
      await rm(report.verification.checkDir, { recursive: true, force: true });
  });
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(report.agentResult.completed, true);
  assert.equal(report.agentResult.threadId, "synthetic-thread");
  assert.equal(report.agentResult.cleanup_requested, true);
  assert.equal(report.agentResult.usage.input_tokens, 20);
  assert.equal(report.agentResult.usage.cache_write_input_tokens, 0); // actual SDK normalized this absent child field
  assert.match(report.agentResult.usage_source, /SDK-defaulted/);
  assert.equal(report.agentResult.provider_usage.totals, null);
  assert.deepEqual(report.verification.paths, ["src/quote.js"]);
  const { args } = JSON.parse(await readFile(f.record));
  assert.ok(args.includes("workspace-write"));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes("sandbox_workspace_write.network_access=false"));
  assert.ok(args.includes('web_search="disabled"'));
  assert.deepEqual(JSON.parse(await readFile(report.reportPath)), report);
  await stopped(f.record);
});

for (const mode of [
  "missing-terminal",
  "blank",
  "pending",
  "malformed",
  "failed-after-edit",
  "hang",
  "external-tool",
])
  test(`native ${mode} cannot pass and retains partial observations`, async (t) => {
    const f = await fixture(t, mode);
    const report = await runScenario({
      scenario: mode === "failed-after-edit" ? "repair" : "incomplete",
      outputRoot: f.temp,
      timeoutMs: mode === "hang" ? 1000 : 5000,
      agent: (workspace, scenario, options) =>
        runCodex(workspace, scenario, { ...options, sdk: f.sdk }),
    });
    t.after(async () => {
      await rm(report.workspace, { recursive: true, force: true });
      if (report.verification?.checkDir)
        await rm(report.verification.checkDir, {
          recursive: true,
          force: true,
        });
    });
    assert.equal(report.passed, false);
    assert.ok(report.agentError);
    assert.equal(report.agentResult.completed, false);
    assert.ok(report.agentResult.events.length >= 2);
    assert.equal(report.agentResult.cleanup_requested, true);
    if (mode === "failed-after-edit") {
      assert.equal(report.verification.passed, true);
      assert.deepEqual(report.verification.paths, ["src/quote.js"]);
      assert.equal(report.agentResult.events.at(-1).type, "turn.failed");
    }
    if (mode === "missing-terminal")
      assert.match(report.agentError, /without turn.completed/);
    if (mode === "external-tool") {
      assert.equal(report.agentResult.external_effect_status, "unknown");
      assert.equal(report.agentResult.events.at(-1).item.type, "mcp_tool_call");
    }
    assert.deepEqual(JSON.parse(await readFile(report.reportPath)), report);
    await stopped(f.record);
  });

test("normal runtime isolates Codex configuration and removes its owned home without changing caller settings", async (t) => {
  const f = await fixture(t, "repair");
  let configuration;
  const report = await runScenario({
    outputRoot: f.temp,
    agent: (workspace, scenario, options) =>
      runCodex(workspace, scenario, {
        ...options,
        apiKey: "synthetic-not-a-secret",
        sdkFactory: (input) => {
          configuration = input;
          return new Codex({
            ...input,
            codexPathOverride: f.child,
            env: {
              ...input.env,
              SYNTHETIC_MODE: "repair",
              CHILD_RECORD: f.record,
            },
          });
        },
      }),
  });
  t.after(async () => {
    await rm(report.workspace, { recursive: true, force: true });
    if (report.verification?.checkDir)
      await rm(report.verification.checkDir, { recursive: true, force: true });
  });
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.deepEqual(
    Object.keys(configuration.env)
      .filter((key) => !["SystemRoot", "WINDIR"].includes(key))
      .sort(),
    ["CODEX_HOME", "PATH"],
  );
  assert.equal(report.agentResult.runtime_home_removed, true);
  await assert.rejects(
    stat(configuration.env.CODEX_HOME),
    (error) => error.code === "ENOENT",
  );
  const record = JSON.parse(await readFile(f.record));
  assert.equal(record.runtime_home, configuration.env.CODEX_HOME);
  assert.equal(record.has_provider_key, true);
  await stopped(f.record);
});

test("owned runtime startup failure retains evidence and removes its private configuration home", async (t) => {
  const f = await fixture(t, "repair");
  let runtimeHome;
  const report = await runScenario({
    outputRoot: f.temp,
    agent: (workspace, scenario, options) =>
      runCodex(workspace, scenario, {
        ...options,
        apiKey: "synthetic-not-a-secret",
        sdkFactory: (configuration) => {
          runtimeHome = configuration.env.CODEX_HOME;
          throw new Error("synthetic SDK startup failure");
        },
      }),
  });
  t.after(async () => {
    await rm(report.workspace, { recursive: true, force: true });
    if (report.verification?.checkDir)
      await rm(report.verification.checkDir, { recursive: true, force: true });
  });
  assert.equal(report.passed, false);
  assert.match(report.agentError, /SDK startup/);
  assert.equal(report.agentResult.runtime_home_removed, true);
  await assert.rejects(stat(runtimeHome), (error) => error.code === "ENOENT");
});
