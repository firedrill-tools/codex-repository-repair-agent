import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runProcess, processAlive } from "../src/processes.js";
import { childEnvironment } from "../src/commands.js";
const run = (source, options = {}) =>
  runProcess({
    program: process.execPath,
    args: ["-e", source],
    cwd: os.tmpdir(),
    env: childEnvironment(),
    ...options,
  });
test("normal owned command drains original output and confirms group and child exit", async () => {
  const result = await run(
    'process.stdout.write("out");process.stderr.write("err")',
  );
  assert.equal(result.error, null);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.equal(result.exitCode, 0);
  assert.equal(result.lifecycle.group_exit_confirmed, true);
  assert.equal(result.lifecycle.close_observed, true);
});
test(
  "SIGTERM-ignoring command is forcibly killed and confirmed before deadline failure returns",
  { timeout: 10000 },
  async () => {
    const result = await run(
      'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)',
      { timeoutMs: 750 },
    );
    assert.ok(result.error);
    assert.equal(result.lifecycle.kill_sent, true);
    assert.equal(result.lifecycle.group_exit_confirmed, true);
    assert.equal(processAlive(result.lifecycle.pid), false);
  },
);
test(
  "same-group grandchild is terminated when its parent ignores cancellation",
  { timeout: 10000 },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deps-group-")),
      record = path.join(directory, "child");
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const source = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(record)},String(child.pid));setInterval(()=>{},1000);`;
    const result = await run(source, { timeoutMs: 1000 });
    assert.equal(result.lifecycle.kill_sent, true);
    assert.equal(result.lifecycle.group_exit_confirmed, true);
    assert.equal(processAlive(Number(fs.readFileSync(record, "utf8"))), false);
  },
);
test("parent cancellation is observed while a command is running and cleanup completes", async () => {
  const controller = new AbortController(),
    timer = setTimeout(
      () => controller.abort(new Error("Parent cancelled command")),
      200,
    );
  try {
    const result = await run(
      'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
      { signal: controller.signal },
    );
    assert.match(result.error.message, /Parent cancelled/);
    assert.equal(result.lifecycle.parent_listener_removed, true);
    assert.equal(result.lifecycle.group_exit_confirmed, true);
  } finally {
    clearTimeout(timer);
  }
});
test("stdout and stderr overflow retain only bounded bytes and stop the owned group", async () => {
  for (const stream of ["stdout", "stderr"]) {
    const result = await run(
      `process.${stream}.write('x'.repeat(2000000));setInterval(()=>{},1000)`,
      { stdoutLimit: 1024, stderrLimit: 1024 },
    );
    assert.ok(result.error);
    assert.equal(Buffer.byteLength(result[stream]), 1024);
    assert.equal(result.lifecycle.group_exit_confirmed, true);
  }
});
test("pre-cancelled command and failed spawn create no unconfirmed process", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Already cancelled"));
  const cancelled = await run("process.exit(0)", { signal: controller.signal });
  assert.equal(cancelled.lifecycle.spawned, false);
  assert.equal(cancelled.lifecycle.pid, null);
  const missing = await runProcess({
    program: "/definitely-not-an-executable",
    cwd: os.tmpdir(),
    env: childEnvironment(),
  });
  assert.ok(missing.error);
  assert.equal(missing.lifecycle.group_exit_confirmed, true);
});

test("validator commands remove provider keys without mutating the caller environment", async () => {
  const before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "synthetic-validator-secret";
  try {
    const result = await run(
      "process.stdout.write(String(Boolean(process.env.OPENAI_API_KEY)))",
    );
    assert.equal(result.stdout, "false");
    assert.equal(process.env.OPENAI_API_KEY, "synthetic-validator-secret");
  } finally {
    if (before === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = before;
  }
});

test(
  "cancellation owns a separate job group and its TERM-ignoring grandchild",
  { timeout: 15000 },
  async (t) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "deps-separate-job-"),
    );
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const record = path.join(directory, "job.json"),
      controller = new AbortController();
    const worker = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify({pid:process.pid,grandchild:child.pid}));setInterval(()=>{},1000);`;
    const source = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});spawn(process.execPath,['-e',${JSON.stringify(worker)}],{detached:true,stdio:'ignore'});setInterval(()=>{},1000);`;
    t.after(() => {
      if (fs.existsSync(record))
        for (const pid of Object.values(JSON.parse(fs.readFileSync(record))))
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
    });
    const result = await run(source, {
      timeoutMs: 10000,
      signal: controller.signal,
      onState: (state) => {
        if (state.tree?.observed_groups.length >= 2 && fs.existsSync(record))
          controller.abort(new Error("Separate job cancellation"));
      },
    });
    assert.match(result.error.message, /Separate job cancellation/);
    assert.equal(result.lifecycle.descendants_exit_confirmed, true);
    assert.equal(result.lifecycle.tree.freeze_completed, true);
    assert.ok(result.lifecycle.tree.observed_groups.length >= 2);
    for (const pid of Object.values(JSON.parse(fs.readFileSync(record))))
      assert.equal(processAlive(pid), false);
  },
);

test(
  "a command that exits with a previously observed separate job fails and drains that job",
  { timeout: 15000 },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deps-residue-")),
      record = path.join(directory, "job"),
      exitFile = path.join(directory, "exit");
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const worker = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(record)},String(process.pid));setInterval(()=>{},1000);`;
    const source = `const fs=require('node:fs'),{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(worker)}],{detached:true,stdio:'ignore'});child.unref();setInterval(()=>{if(fs.existsSync(${JSON.stringify(exitFile)}))process.exit(0)},20);`;
    t.after(() => {
      if (fs.existsSync(record))
        try {
          process.kill(Number(fs.readFileSync(record)), "SIGKILL");
        } catch {}
    });
    const result = await run(source, {
      timeoutMs: 10000,
      onState: (state) => {
        if (state.tree?.observed_groups.length >= 2)
          fs.writeFileSync(exitFile, "exit");
      },
    });
    assert.match(result.error.message, /outlived/);
    assert.equal(result.lifecycle.descendants_exit_confirmed, true);
    assert.equal(processAlive(Number(fs.readFileSync(record))), false);
  },
);
