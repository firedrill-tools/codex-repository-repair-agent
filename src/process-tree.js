import { spawn } from "node:child_process";
import { groupAlive } from "./pids.js";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function processTable() {
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat="], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    let size = 0,
      error = null,
      done = false;
    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      error ??= new Error("Process inventory deadline exceeded");
      kill();
    }, 1000);
    const forced = setTimeout(() => {
      if (done) return;
      done = true;
      kill();
      child.unref();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(error ?? new Error("Process inventory exit unconfirmed"));
    }, 2000);
    child.on("error", (fault) => {
      error ??= fault;
    });
    child.stdout.on("data", (bytes) => {
      size += bytes.length;
      if (size > 4194304) {
        error ??= new Error("Process inventory byte limit exceeded");
        kill();
      } else output.push(bytes);
    });
    child.stderr.resume();
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forced);
      if (done) return;
      done = true;
      if (error || code !== 0 || signal) {
        reject(error ?? new Error("Process inventory failed"));
        return;
      }
      const rows = new Map();
      for (const line of Buffer.concat(output).toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/);
        if (!match) {
          reject(new Error("Invalid process inventory row"));
          return;
        }
        const pid = Number(match[1]),
          ppid = Number(match[2]),
          pgid = Number(match[3]);
        if (![pid, ppid, pgid].every(Number.isSafeInteger)) {
          reject(new Error("Unsafe process inventory identity"));
          return;
        }
        rows.set(pid, { pid, ppid, pgid, state: match[4] });
      }
      resolve(rows);
    });
  });
}
export class ProcessTree {
  constructor(
    root,
    { rootGroupOwned = true, seedGroups = [], seedMembers = [] } = {},
  ) {
    this.root = root;
    this.rootGroupOwned = rootGroupOwned;
    this.excludedGroup = null;
    this.groups = new Set(seedGroups);
    this.observedGroups = new Set(seedGroups);
    this.retiredGroups = new Set();
    if (rootGroupOwned) {
      this.groups.add(root);
      this.observedGroups.add(root);
    }
    this.members = new Map(seedMembers.map((row) => [row.pid, { ...row }]));
    this.retired = new Set();
    this.lastRows = null;
    this.samples = 0;
    this.complete = true;
    this.signalErrors = [];
    this.frozen = false;
    this.sent = new Set();
    this.samplePromise = null;
  }
  refresh(rows) {
    const root = rows.get(this.root);
    if (!this.rootGroupOwned && root) this.excludedGroup = root.pgid;
    const owned = new Set();
    if (root) owned.add(this.root);
    for (const [pid, previous] of this.members) {
      const row = rows.get(pid);
      if (!row) {
        this.retired.add(pid);
        continue;
      }
      if (
        !this.retired.has(pid) &&
        (row.pgid === previous.pgid ||
          row.ppid === previous.ppid ||
          row.ppid === 1)
      )
        owned.add(pid);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows.values())
        if (owned.has(row.ppid) && !owned.has(row.pid)) {
          owned.add(row.pid);
          changed = true;
        }
    }
    const safeGroups = new Set(
      [...owned].filter((pid) => rows.get(pid)?.pgid === pid),
    );
    for (const pid of owned) {
      const row = rows.get(pid);
      if (!row) continue;
      if (this.members.size >= 1024 && !this.members.has(pid))
        throw new Error("Owned process count exceeds1024");
      this.members.set(pid, { ...row });
      this.retired.delete(pid);
      if (
        (pid !== this.root || this.rootGroupOwned) &&
        row.pgid > 1 &&
        row.pgid !== this.excludedGroup &&
        (this.groups.has(row.pgid) || safeGroups.has(row.pgid))
      ) {
        this.groups.add(row.pgid);
        this.observedGroups.add(row.pgid);
        this.retiredGroups.delete(row.pgid);
      }
    }
    for (const group of this.groups)
      if (
        ![...rows.values()].some((row) => row.pgid === group) &&
        !groupAlive(group)
      ) {
        this.groups.delete(group);
        this.retiredGroups.add(group);
      }
    this.lastRows = rows;
    this.samples++;
    return this.status();
  }
  async sample() {
    if (this.samplePromise) return this.samplePromise;
    this.samplePromise = processTable()
      .then((rows) => this.refresh(rows))
      .finally(() => {
        this.samplePromise = null;
      });
    return this.samplePromise;
  }
  status() {
    const groups = [...this.groups]
        .filter(Number.isSafeInteger)
        .sort((a, b) => a - b),
      members = [...this.members.values()].map((row) => ({
        ...row,
        current_state: this.lastRows?.get(row.pid)?.state ?? null,
      }));
    const live = [],
      defunct = [];
    if (this.lastRows) {
      for (const row of this.lastRows.values())
        if (
          groups.includes(row.pgid) ||
          (this.members.has(row.pid) && !this.retired.has(row.pid)) ||
          (row.pid === this.root && !this.rootGroupOwned)
        ) {
          if (row.state.startsWith("Z")) defunct.push(row.pid);
          else live.push(row.pid);
        }
    }
    return {
      root_pid: this.root,
      root_group_owned: this.rootGroupOwned,
      groups,
      observed_groups: [...this.observedGroups],
      retired_groups: [...this.retiredGroups],
      members,
      samples: this.samples,
      inventory_complete: this.complete,
      freeze_completed: this.frozen,
      live_pids: live,
      defunct_pids: defunct,
      exit_confirmed: Boolean(this.lastRows && this.complete && !live.length),
      signal_errors: [...this.signalErrors],
    };
  }
  signal(number, name, isGroup) {
    if (!Number.isSafeInteger(number) || number <= 1) return;
    const key = `${isGroup ? "group" : "pid"}:${number}:${name}`;
    if (name !== "SIGSTOP" && name !== "SIGCONT" && this.sent.has(key)) return;
    try {
      process.kill(isGroup ? -number : number, name);
      this.sent.add(key);
    } catch (error) {
      if (!["ESRCH", "EPERM"].includes(error.code)) throw error;
      if (error.code === "EPERM")
        this.signalErrors.push({
          number,
          is_group: isGroup,
          signal: name,
          code: error.code,
        });
    }
  }
  signalAll(name) {
    for (const group of this.groups)
      if (group !== this.excludedGroup) this.signal(group, name, true);
    if (!this.rootGroupOwned) this.signal(this.root, name, false);
    for (const row of this.members.values())
      if (
        !this.groups.has(row.pgid) &&
        row.pid !== this.root &&
        !this.retired.has(row.pid)
      )
        this.signal(row.pid, name, false);
  }
  async freeze({ deadline = performance.now() + 1500 } = {}) {
    // Stop the parent before inspecting: ordinary jobs must not be reparented away first.
    if (this.rootGroupOwned) this.signal(this.root, "SIGSTOP", true);
    else this.signal(this.root, "SIGSTOP", false);
    this.signalAll("SIGSTOP");
    let previous = null;
    try {
      for (let round = 0; round < 16; round++) {
        await this.sample();
        this.signalAll("SIGSTOP");
        const signature = JSON.stringify({
          groups: [...this.groups].sort((a, b) => a - b),
          live: this.status().live_pids.sort((a, b) => a - b),
        });
        const stopped = this.status().live_pids.every((pid) =>
          /^[Tt]/.test(this.lastRows.get(pid)?.state ?? ""),
        );
        if (previous === signature && stopped) {
          this.frozen = true;
          return this.status();
        }
        if (performance.now() >= deadline)
          throw new Error("Process quarantine deadline exceeded");
        previous = signature;
        await sleep(5);
      }
      throw new Error("Owned process tree did not quiesce");
    } catch (error) {
      this.complete = false;
      this.signalAll("SIGKILL");
      throw error;
    }
  }
  terminate() {
    this.signalAll("SIGTERM");
    this.signalAll("SIGCONT");
  }
  kill() {
    this.signalAll("SIGKILL");
    this.signalAll("SIGCONT");
  }
  async absent() {
    await this.sample();
    return this.status().exit_confirmed;
  }
}
