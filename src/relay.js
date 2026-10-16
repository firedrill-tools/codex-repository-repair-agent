import fs from "node:fs";
import path from "node:path";
import { runProcess } from "./processes.js";
function publish(file, value) {
  const staged = `${file}.tmp`;
  const fd = fs.openSync(staged, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(staged, file);
  const directory = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}
export async function relay() {
  const configFile = process.env.FIREDRILL_RELAY_CONFIG,
    config = JSON.parse(fs.readFileSync(configFile, "utf8")),
    directory = path.dirname(configFile),
    stateFile = path.join(directory, "state.json");
  const controller = new AbortController(),
    handlers = new Map(
      ["SIGTERM", "SIGINT", "SIGHUP"].map((name) => [
        name,
        () => controller.abort(new Error(`Relay received ${name}`)),
      ]),
    );
  for (const [name, handler] of handlers) process.on(name, handler);
  const state = {
    schema_version: 1,
    relay_pid: process.pid,
    status: "prepared",
    program: config.program,
    args: [...config.prefix, ...process.argv.slice(2)],
    process: null,
    result: null,
  };
  const opened = [];
  let result;
  try {
    publish(stateFile, state);
    const make = (name) => {
      const fd = fs.openSync(path.join(directory, name), "wx", 0o600);
      opened.push(fd);
      return (bytes) => {
        let offset = 0;
        while (offset < bytes.length) {
          const count = fs.writeSync(fd, bytes, offset, bytes.length - offset);
          if (!count) throw new Error("Relay recording write made no progress");
          offset += count;
        }
        fs.fsyncSync(fd);
      };
    };
    const stdout = make("stdout.bin"),
      stderr = make("stderr.bin"),
      stdin = make("stdin.bin"),
      env = { ...process.env };
    delete env.FIREDRILL_RELAY_CONFIG;
    if (config.startupDelayMs)
      await new Promise((resolve) =>
        setTimeout(resolve, config.startupDelayMs),
      );
    result = await runProcess({
      program: config.program,
      args: state.args,
      cwd: config.cwd,
      env,
      signal: controller.signal,
      timeoutMs: config.timeoutMs,
      stdoutLimit: 1048576,
      stderrLimit: 65536,
      inputStream: process.stdin,
      onStdin: stdin,
      onStdout: (bytes) => {
        stdout(bytes);
        process.stdout.write(bytes);
      },
      onStderr: (bytes) => {
        stderr(bytes);
        process.stderr.write(bytes);
      },
      onState: (value) => {
        state.process = value;
        state.status = "running";
        publish(stateFile, state);
      },
    });
    state.result = { ...result, stdout: undefined, stderr: undefined };
    state.process = result.lifecycle;
    state.status = "finished";
    publish(stateFile, state);
    process.exitCode = result.error
      ? 1
      : result.signal
        ? 1
        : (result.exitCode ?? 1);
  } catch (error) {
    state.status = "failed";
    state.error = { name: error.name, message: error.message };
    try {
      publish(stateFile, state);
    } catch {}
    process.stderr.write(`Owned relay failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    for (const fd of opened) fs.closeSync(fd);
    for (const [name, handler] of handlers)
      process.removeListener(name, handler);
  }
}
