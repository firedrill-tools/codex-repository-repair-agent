import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { processAlive, groupAlive } from "./pids.js";
import { ProcessTree } from "./process-tree.js";
const require = createRequire(import.meta.url),
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fileHash(file, signal) {
  const digest = createHash("sha256"),
    stream = fs.createReadStream(file, { highWaterMark: 65536, signal });
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest("hex");
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const keys = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];
const classify = (usage) =>
  Object.fromEntries(
    keys.map((key) => {
      const value = usage?.[key];
      return [
        key,
        {
          source: "original CLI JSONL",
          state:
            value === undefined
              ? "unknown"
              : Number.isSafeInteger(value) && value >= 0
                ? "observed"
                : "invalid",
          value: Number.isSafeInteger(value) && value >= 0 ? value : null,
        },
      ];
    }),
  );
export class RelayOwner {
  constructor(directory, configuration) {
    this.directory = directory;
    this.configuration = configuration;
    this.stopPromise = null;
    this.lifecycle = {
      owner: "application",
      stop_requested: false,
      term_sent: false,
      kill_sent: false,
      relay_exit_confirmed: null,
      group_exit_confirmed: null,
      descendants_exit_confirmed: null,
    };
  }
  static async create({ cwd, cliPath, timeoutMs, startupDelayMs = 0, signal }) {
    let program,
      prefix,
      source,
      version = null;
    if (cliPath) {
      program = fs.realpathSync(path.resolve(cliPath));
      prefix = [];
      source = "explicit public executable override";
      if (!fs.statSync(program).isFile())
        throw new Error("Codex executable override must be a file");
    } else {
      const metadata = require.resolve("@openai/codex/package.json"),
        pkg = JSON.parse(fs.readFileSync(metadata));
      if (pkg.version !== "0.162.1" || typeof pkg.bin?.codex !== "string")
        throw new Error("Published Codex CLI version needs requalification");
      program = process.execPath;
      prefix = [path.resolve(path.dirname(metadata), pkg.bin.codex)];
      source = "published @openai/codex bin";
      version = pkg.version;
    }
    const directory = await fsp.mkdtemp(
      path.join(os.tmpdir(), "firedrill-repair-relay-"),
    );
    const configuration = {
      program,
      prefix,
      cwd: path.resolve(cwd),
      timeoutMs,
      startupDelayMs,
    };
    try {
      await fsp.writeFile(
        path.join(directory, "config.json"),
        JSON.stringify(configuration),
        { flag: "wx", mode: 0o600 },
      );
      const launcher = path.join(directory, "codex-relay"),
        entry = fileURLToPath(new URL("./relay.js", import.meta.url));
      const module = path.join(directory, "entry.mjs");
      await fsp.writeFile(
        module,
        `import {relay} from ${JSON.stringify(new URL("./relay.js", import.meta.url).href)};await relay();\n`,
        { flag: "wx", mode: 0o600 },
      );
      await fsp.writeFile(
        launcher,
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(module)} "$@"\n`,
        { flag: "wx", mode: 0o700 },
      );
      const owner = new RelayOwner(directory, configuration);
      owner.launcher = launcher;
      owner.source = source;
      owner.version = version;
      const entrypoint = prefix[0] ?? program;
      owner.prepared = {
        program,
        prefix: [...prefix],
        working_directory: configuration.cwd,
        timeout_ms: timeoutMs,
        entrypoint,
        entrypoint_sha256: await fileHash(entrypoint, signal),
        node_path: process.execPath,
        node_version: process.version,
        launcher_path: launcher,
        launcher_sha256: hash(fs.readFileSync(launcher)),
      };
      return owner;
    } catch (error) {
      await fsp.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  state() {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(this.directory, "state.json"), "utf8"),
      );
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  read() {
    const file = (name, limit) => {
      let bytes;
      try {
        const target = path.join(this.directory, name),
          stat = fs.lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
          throw new Error("Invalid bounded relay file");
        bytes = fs.readFileSync(target);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        bytes = Buffer.alloc(0);
      }
      return {
        bytes,
        base64: bytes.toString("base64"),
        sha256: hash(bytes),
        byte_length: bytes.length,
      };
    };
    const stdout = file("stdout.bin", 1048576),
      stderr = file("stderr.bin", 65536),
      stdin = file("stdin.bin", 16384),
      records = [];
    let text = null,
      decodeError = null;
    try {
      text = new TextDecoder("utf8", { fatal: true }).decode(stdout.bytes);
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      for (const [index, line] of lines.entries()) {
        let body = null,
          parseError = null;
        try {
          body = JSON.parse(line, (_key, value) => {
            if (typeof value === "number" && !Number.isFinite(value))
              throw new Error("Nonfinite CLI number");
            return value;
          });
        } catch (error) {
          parseError = error.message;
        }
        records.push({
          index,
          text: line,
          sha256: hash(Buffer.from(line)),
          body,
          parse_error: parseError,
        });
      }
    } catch (error) {
      decodeError = error.message;
    }
    const reports = records
      .filter((record) =>
        ["turn.completed", "turn.failed", "error"].includes(record.body?.type),
      )
      .map((record) => ({
        index: record.index,
        event_type: record.body.type,
        usage: record.body.usage ?? null,
        fields: classify(record.body.usage),
      }));
    return {
      source: this.source,
      prepared: this.prepared,
      declared_cli_version: this.version,
      state: this.state(),
      stdout: {
        base64: stdout.base64,
        sha256: stdout.sha256,
        byte_length: stdout.byte_length,
      },
      stderr: {
        base64: stderr.base64,
        sha256: stderr.sha256,
        byte_length: stderr.byte_length,
      },
      stdin: {
        base64: stdin.base64,
        sha256: stdin.sha256,
        byte_length: stdin.byte_length,
      },
      records,
      usage_reports: reports,
      decode_error: decodeError,
      lifecycle: { ...this.lifecycle },
    };
  }
  async stop(reason = "owner cleanup") {
    if (!this.dispatched) {
      Object.assign(this.lifecycle, {
        not_dispatched: true,
        relay_exit_confirmed: true,
        group_exit_confirmed: true,
        descendants_exit_confirmed: true,
      });
      return;
    }
    if (this.stopPromise) return this.stopPromise;
    this.lifecycle.stop_requested = true;
    this.lifecycle.stop_reason = String(reason);
    this.stopPromise = (async () => {
      const began = performance.now();
      let tree,
        sent = false,
        emergency = false,
        escalatedAt = null;
      for (;;) {
        const state = this.state();
        if (state) {
          const relay = state.relay_pid;
          if (!tree)
            tree = new ProcessTree(relay, {
              rootGroupOwned: false,
              seedGroups:
                state.process?.tree?.groups ??
                (state.process?.pgid ? [state.process.pgid] : []),
              seedMembers: state.process?.tree?.members ?? [],
            });
          try {
            await tree.sample();
          } catch (error) {
            this.lifecycle.inventory_error = {
              name: error.name,
              message: error.message,
            };
            tree.complete = false;
          }
          this.lifecycle.tree = tree.status();
          this.lifecycle.relay_exit_confirmed = !processAlive(relay);
          this.lifecycle.group_exit_confirmed = !groupAlive(
            state.process?.pgid,
          );
          this.lifecycle.descendants_exit_confirmed =
            this.lifecycle.tree.exit_confirmed;
          if (
            this.lifecycle.relay_exit_confirmed &&
            this.lifecycle.group_exit_confirmed &&
            this.lifecycle.descendants_exit_confirmed
          )
            break;
          // Let the relay freeze its target and tool jobs before any target is killed.
          if (!sent) {
            sent = true;
            tree.signal(relay, "SIGTERM", false);
            this.lifecycle.term_sent = true;
          }
          if (!emergency && performance.now() - began >= 2000) {
            emergency = true;
            try {
              await tree.freeze();
            } catch (error) {
              this.lifecycle.quarantine_error = {
                name: error.name,
                message: error.message,
              };
            }
            tree.terminate();
            escalatedAt = performance.now();
            this.lifecycle.emergency_tree_cleanup = true;
          }
          if (emergency && performance.now() - escalatedAt >= 200) {
            tree.kill();
            this.lifecycle.kill_sent = true;
          }
        }
        if (performance.now() - began > 5000) break;
        await sleep(25);
      }
    })();
    return this.stopPromise;
  }
  async finish({ failed = false } = {}) {
    if (!this.dispatched) {
      Object.assign(this.lifecycle, {
        not_dispatched: true,
        relay_exit_confirmed: true,
        group_exit_confirmed: true,
        descendants_exit_confirmed: true,
      });
      return this.read();
    }
    const state = this.state();
    if (state && !this.stopPromise) {
      this.lifecycle.relay_exit_confirmed = !processAlive(state.relay_pid);
      this.lifecycle.group_exit_confirmed = !groupAlive(state.process?.pgid);
      this.lifecycle.descendants_exit_confirmed =
        state.process?.descendants_exit_confirmed === true;
      this.lifecycle.tree = state.process?.tree ?? null;
    }
    if (
      failed ||
      this.lifecycle.relay_exit_confirmed !== true ||
      this.lifecycle.group_exit_confirmed !== true ||
      this.lifecycle.descendants_exit_confirmed !== true
    )
      await this.stop(
        failed ? "native operation failed" : "owned residue after SDK EOF",
      );
    const report = this.read();
    if (
      this.lifecycle.relay_exit_confirmed !== true ||
      this.lifecycle.group_exit_confirmed !== true ||
      this.lifecycle.descendants_exit_confirmed !== true
    )
      report.cleanup_error = "Owned relay/process tree exit was not confirmed";
    if (report.state?.result?.error)
      report.execution_error = report.state.result.error;
    if (!failed && report.state?.status !== "finished")
      report.execution_error ??= {
        message: "Relay did not publish a terminal lifecycle",
      };
    return report;
  }
  async dispose() {
    await fsp.rm(this.directory, { recursive: true, force: true });
    this.lifecycle.control_directory_removed = true;
  }
}
