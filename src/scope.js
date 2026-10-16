import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { command, succeeded } from "./commands.js";
export const allowed = new Set(["src/quote.js"]);
const originals = new Map();
export const hash = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || value instanceof Uint8Array
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const metadata = (entry) =>
  Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "bytes"));
export function snapshot(workspace) {
  const root = path.resolve(workspace),
    info = fs.lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Workspace must be an owned directory");
  const entries = [],
    problems = [];
  let total = 0;
  function walk(directory, prefix = "") {
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name,
        target = path.join(directory, name),
        stat = fs.lstatSync(target);
      if (entries.length >= 512) throw new Error("Source exceeds512 entries");
      if (!prefix && (name === ".git" || name === "node_modules")) {
        if (!stat.isDirectory() || stat.isSymbolicLink())
          problems.push(relative);
        continue;
      }
      if (
        stat.isSymbolicLink() ||
        (!stat.isFile() && !stat.isDirectory()) ||
        (stat.isFile() && stat.nlink !== 1)
      ) {
        entries.push({
          path: relative,
          type: "unsupported",
          mode: stat.mode & 0o777,
        });
        problems.push(relative);
        continue;
      }
      if (stat.isDirectory()) {
        entries.push({
          path: relative,
          type: "directory",
          mode: stat.mode & 0o777,
        });
        walk(target, relative);
      } else {
        if (stat.size > 1048576 || (total += stat.size) > 8388608)
          throw new Error("Source exceeds bounded file/total bytes");
        const fd = fs.openSync(
          target,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        let bytes;
        try {
          const opened = fs.fstatSync(fd);
          if (
            !opened.isFile() ||
            opened.nlink !== 1 ||
            opened.ino !== stat.ino ||
            opened.dev !== stat.dev
          )
            throw new Error("Source changed while opening");
          bytes = Buffer.alloc(stat.size + 1);
          let offset = 0;
          while (offset < bytes.length) {
            const count = fs.readSync(
              fd,
              bytes,
              offset,
              bytes.length - offset,
              offset,
            );
            if (!count) break;
            offset += count;
          }
          bytes = bytes.subarray(0, offset);
          const after = fs.fstatSync(fd);
          if (
            after.size !== stat.size ||
            after.mtimeMs !== stat.mtimeMs ||
            bytes.length !== stat.size
          )
            throw new Error("Source changed while reading");
        } finally {
          fs.closeSync(fd);
        }
        entries.push({
          path: relative,
          type: "file",
          mode: stat.mode & 0o777,
          size: bytes.length,
          sha256: hash(bytes),
          bytes,
        });
      }
    }
  }
  walk(root);
  const tree = entries.map(metadata);
  return {
    workspace: root,
    device: info.dev,
    inode: info.ino,
    mode: info.mode & 0o777,
    entries,
    tree,
    snapshot_sha256: hash(tree),
    problems,
  };
}
export async function rememberBaseline(workspace, options = {}) {
  const source = snapshot(workspace),
    head = await (options.runCommand ?? command)(
      "git",
      ["rev-parse", "--verify", "HEAD"],
      source.workspace,
      { signal: options.signal },
    );
  if (
    !succeeded(head) ||
    !/^[a-f0-9]{40,64}$/.test(head.stdout.trim()) ||
    source.problems.length
  )
    throw new Error("Original source/commit is invalid");
  const baseline = {
    schema_version: 1,
    workspace: source.workspace,
    device: source.device,
    inode: source.inode,
    mode: source.mode,
    commit: head.stdout.trim(),
    tree: source.tree,
    snapshot_sha256: source.snapshot_sha256,
  };
  originals.set(source.workspace, structuredClone(baseline));
  return structuredClone(baseline);
}
export function captureBaseline(workspace) {
  const baseline = originals.get(path.resolve(workspace));
  if (!baseline)
    throw new Error(
      "Original baseline required; trusted original source only; current HEAD is not an original baseline",
    );
  return structuredClone(baseline);
}
export async function changedPaths(
  workspace,
  baseline = captureBaseline(workspace),
  captured,
  options = {},
) {
  if (
    !baseline ||
    baseline.schema_version !== 1 ||
    baseline.workspace !== path.resolve(workspace) ||
    hash(baseline.tree) !== baseline.snapshot_sha256 ||
    !/^[a-f0-9]{40,64}$/.test(baseline.commit)
  )
    throw new Error("Invalid original baseline");
  const source = captured ?? snapshot(workspace),
    paths = new Set(source.problems),
    original = new Map(baseline.tree.map((item) => [item.path, item])),
    current = new Map(source.tree.map((item) => [item.path, item]));
  if (
    source.device !== baseline.device ||
    source.inode !== baseline.inode ||
    source.mode !== baseline.mode
  )
    paths.add("<workspace-identity>");
  for (const name of new Set([...original.keys(), ...current.keys()]))
    if (canonical(original.get(name)) !== canonical(current.get(name)))
      paths.add(name);
  if (options.signal?.aborted) return [...paths].sort();
  const tracked = await (options.runCommand ?? command)(
    "git",
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-only",
      "-z",
      baseline.commit,
      "--",
    ],
    source.workspace,
    { signal: options.signal },
  );
  if (!succeeded(tracked))
    throw new Error("Unable to inspect original Git baseline");
  for (const name of tracked.stdout.split("\0").filter(Boolean))
    paths.add(name);
  return [...paths].sort();
}
export async function inspectScope(
  workspace,
  baseline = captureBaseline(workspace),
  options = {},
) {
  const source = snapshot(workspace),
    paths = await changedPaths(workspace, baseline, source, options),
    original = new Map(baseline.tree.map((item) => [item.path, item]));
  const invalidPaths = paths.filter((name) => {
    const entry = source.tree.find((item) => item.path === name),
      before = original.get(name);
    return (
      !allowed.has(name) ||
      entry?.type !== "file" ||
      entry.mode !== before?.mode
    );
  });
  return { source, paths, invalidPaths };
}
export function materialize(source, directory) {
  for (const entry of source.entries) {
    const target = path.join(directory, entry.path);
    if (entry.type === "directory") {
      fs.mkdirSync(target, { mode: entry.mode });
      fs.chmodSync(target, entry.mode);
    } else if (entry.type === "file") {
      fs.writeFileSync(target, entry.bytes, { flag: "wx", mode: entry.mode });
      fs.chmodSync(target, entry.mode);
    } else throw new Error("Uncopyable candidate source");
  }
}
export function sameSource(left, right) {
  return (
    left.snapshot_sha256 === right.snapshot_sha256 &&
    left.device === right.device &&
    left.inode === right.inode
  );
}
