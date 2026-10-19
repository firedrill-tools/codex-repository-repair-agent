import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runProcess } from "../src/processes.js";
import { childEnvironment } from "../src/commands.js";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "firedrill-repair-package-")),
  owned = [];
const env = childEnvironment(),
  digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = async (program, args, cwd, expected = 0) => {
  const result = await runProcess({
    program,
    args,
    cwd,
    env,
    timeoutMs: 180000,
  });
  if (
    result.error ||
    result.signal ||
    result.exitCode !== expected ||
    !result.lifecycle.group_exit_confirmed ||
    !result.lifecycle.descendants_exit_confirmed
  )
    throw new Error(JSON.stringify({ program, args, ...result }));
  return result.stdout;
};
try {
  const archive = path.join(temp, "source.tar.gz"),
    again = path.join(temp, "again.tar.gz");
  const packed = JSON.parse(
    await run(process.execPath, ["scripts/package.js", archive], root),
  );
  await run(process.execPath, ["scripts/package.js", again], root);
  assert.equal(
    digest(fs.readFileSync(archive)),
    digest(fs.readFileSync(again)),
    "Source archive must be deterministic",
  );
  await run("tar", ["-xzf", archive, "-C", temp], temp);
  const directory = path.join(temp, "package"),
    manifest = JSON.parse(
      fs.readFileSync(path.join(directory, "SOURCE_MANIFEST.json")),
    );
  function verifyFiles() {
    const all = [];
    function walk(relative = "") {
      for (const name of fs
        .readdirSync(path.join(directory, relative))
        .sort()) {
        if (name === "node_modules" || name === ".runs") continue;
        if (
          !relative &&
          ["node_modules", "SOURCE_MANIFEST.json"].includes(name)
        )
          continue;
        const file = relative ? `${relative}/${name}` : name,
          stat = fs.lstatSync(path.join(directory, file));
        if (stat.isSymbolicLink())
          throw new Error("Extracted source contains an alias");
        if (stat.isDirectory()) walk(file);
        else {
          assert.ok(stat.isFile());
          all.push(file);
        }
      }
    }
    walk();
    assert.deepEqual(
      all.sort(),
      manifest.files.map((item) => item.path).sort(),
      "Archive source inventory differs",
    );
    for (const file of manifest.files) {
      const target = path.join(directory, file.path),
        bytes = fs.readFileSync(target);
      assert.equal(bytes.length, file.bytes);
      assert.equal(digest(bytes), file.sha256, file.path);
      assert.equal(fs.statSync(target).mode & 0o777, file.mode, file.path);
    }
  }
  verifyFiles();
  await run(
    "npm",
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    directory,
  );
  if (process.platform === "linux" && process.env.GITHUB_ACTIONS === "true")
    await run(
      process.execPath,
      ["scripts/codex-ci-profile.js", "install"],
      directory,
    );
  await run(process.execPath, ["src/cli.js", "--help"], directory);
  await run(process.execPath, ["src/datasets.js", "--help"], directory);
  await run("npm", ["run", "fixtures:build"], directory);
  verifyFiles();
  const cases = JSON.parse(
    await run(process.execPath, ["src/datasets.js", "list"], directory),
  );
  assert.equal(cases.length, 7);
  for (const item of cases) {
    const selection = JSON.parse(
      await run(
        process.execPath,
        ["src/datasets.js", "init", item.id],
        directory,
      ),
    );
    owned.push(selection.workspace);
    assert.equal(selection.dataset.case_id, item.id);
    assert.equal(
      fs.existsSync(path.join(selection.workspace, "grader")),
      false,
    );
    await run(
      "npm",
      ["test"],
      selection.workspace,
      item.id === "already-repaired" ? 0 : 1,
    );
  }
  const negative = JSON.parse(
    await run(
      process.execPath,
      [
        "src/cli.js",
        "--scenario",
        "repair",
        "--output-root",
        path.join(temp, "reports"),
      ],
      directory,
      1,
    ),
  );
  owned.push(negative.workspace);
  const failed = JSON.parse(fs.readFileSync(negative.reportPath));
  if (failed.verification?.checkDir) owned.push(failed.verification.checkDir);
  assert.match(negative.agentError, /OPENAI_API_KEY required/);
  assert.equal(failed.status, "failed");
  assert.ok(fs.existsSync(path.join(directory, "firedrill", "scenario.json")));
  assert.equal(fs.existsSync(path.join(directory, "firedrill", "node_modules")), false);
  await run("npm", ["ci", "--prefix", "firedrill", "--ignore-scripts", "--no-audit", "--no-fund"], directory);
  console.log(await run("npm", ["test", "--prefix", "firedrill"], directory));
  const suite = await run("npm", ["test"], directory);
  verifyFiles();
  console.log(suite.split("\n").slice(-12).join("\n"));
  console.log(
    JSON.stringify({
      source_sha256: packed.sha256,
      files: manifest.files.length + 1,
      cases: cases.length,
      fresh_locked_install: true,
      full_suite: true,
      original_cli_and_native_tool_checks: true,
    }),
  );
} finally {
  for (const directory of owned)
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  fs.rmSync(temp, { recursive: true, force: true });
}
