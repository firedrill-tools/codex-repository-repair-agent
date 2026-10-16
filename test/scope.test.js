import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  createWorkspace,
  captureBaseline,
  runScenario,
  verifyWorkspace,
} from "../src/repair.js";
import { command } from "../src/commands.js";
const fix = (workspace) => {
  const file = path.join(workspace, "src/quote.js");
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, "utf8")
      .replace("subtotalCents >= 5000", "discountedCents >= 5000"),
  );
  return { completed: true, finalResponse: "Controlled bounded repair" };
};
async function fixture(t) {
  const workspace = await createWorkspace();
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return { workspace, baseline: captureBaseline(workspace) };
}
test("original filesystem authority detects the reproduced assume-unchanged protected edit", async (t) => {
  const { workspace, baseline } = await fixture(t);
  fix(workspace);
  execFileSync(
    "git",
    ["update-index", "--assume-unchanged", "--", "README.md"],
    { cwd: workspace },
  );
  fs.appendFileSync(
    path.join(workspace, "README.md"),
    "\nProtected hidden edit\n",
  );
  const checked = await verifyWorkspace(workspace, "repair", baseline);
  assert.equal(checked.passed, false);
  assert.deepEqual(checked.invalidPaths, ["README.md"]);
  assert.equal(checked.publicChecks, null);
  assert.equal(checked.privateChecks, null);
});
for (const mutation of [
  "hidden-test",
  "hardlink",
  "source-symlink",
  "directory-mode",
  "allowed-mode",
  "package-script",
])
  test(`${mutation} is rejected before validation executes`, async (t) => {
    const { workspace, baseline } = await fixture(t);
    fix(workspace);
    if (mutation === "hidden-test") {
      execFileSync(
        "git",
        ["update-index", "--assume-unchanged", "--", "test/quote.test.js"],
        { cwd: workspace },
      );
      fs.appendFileSync(
        path.join(workspace, "test/quote.test.js"),
        '\nthrow new Error("protected test must not execute");\n',
      );
    }
    if (mutation === "hardlink")
      fs.linkSync(
        path.join(workspace, "src/quote.js"),
        path.join(workspace, "alias"),
      );
    if (mutation === "source-symlink") {
      fs.renameSync(
        path.join(workspace, "src/quote.js"),
        path.join(workspace, "quote-target.js"),
      );
      fs.symlinkSync(
        "../quote-target.js",
        path.join(workspace, "src/quote.js"),
      );
    }
    if (mutation === "directory-mode")
      fs.chmodSync(path.join(workspace, "src"), 0o700);
    if (mutation === "allowed-mode")
      fs.chmodSync(path.join(workspace, "src/quote.js"), 0o700);
    if (mutation === "package-script") {
      const file = path.join(workspace, "package.json"),
        pkg = JSON.parse(fs.readFileSync(file));
      pkg.scripts.test = 'node -e "process.exit(0)"';
      fs.writeFileSync(file, JSON.stringify(pkg));
    }
    const checked = await verifyWorkspace(workspace, "repair", baseline);
    assert.equal(checked.passed, false);
    assert.ok(checked.invalidPaths.length);
    assert.equal(checked.publicChecks, null);
    assert.equal(checked.privateChecks, null);
  });
test("a no-edit clarification cannot change the otherwise allowed application file", async (t) => {
  const workspace = await createWorkspace("incomplete");
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const baseline = captureBaseline(workspace);
  fix(workspace);
  const checked = await verifyWorkspace(workspace, "incomplete", baseline);
  assert.equal(checked.passed, false);
  assert.deepEqual(checked.invalidPaths, ["src/quote.js"]);
  assert.equal(checked.publicChecks, null);
});
test("moving original candidate while fresh checks run invalidates the attempt", async (t) => {
  const { workspace, baseline } = await fixture(t);
  fix(workspace);
  let changed = false;
  const checked = await verifyWorkspace(workspace, "repair", baseline, {
    runCommand: async (name, args, cwd, options) => {
      const result = await command(name, args, cwd, options);
      if (name === "npm") {
        fs.appendFileSync(
          path.join(workspace, "src/quote.js"),
          "\n// changed during validation\n",
        );
        changed = true;
      }
      return result;
    },
  });
  if (checked.checkDir)
    t.after(() =>
      fs.rmSync(checked.checkDir, { recursive: true, force: true }),
    );
  assert.equal(changed, true);
  assert.equal(checked.passed, false);
  assert.match(checked.error.message, /Candidate source changed/);
  assert.equal(checked.privateChecks, null);
});
test("private source copy preserves modes under a restrictive caller umask", async (t) => {
  const { workspace, baseline } = await fixture(t);
  fix(workspace);
  const mask = process.umask(0o077);
  let checked;
  try {
    checked = await verifyWorkspace(workspace, "repair", baseline);
  } finally {
    process.umask(mask);
  }
  if (checked.checkDir)
    t.after(() =>
      fs.rmSync(checked.checkDir, { recursive: true, force: true }),
    );
  assert.equal(checked.passed, true, JSON.stringify(checked));
  assert.equal(
    fs.statSync(path.join(checked.checkDir, "src/quote.js")).mode & 0o777,
    baseline.tree.find((item) => item.path === "src/quote.js").mode,
  );
});
test("untrusted current checkout cannot invent original baseline authority", () => {
  assert.throws(
    () => captureBaseline(os.tmpdir()),
    /Original baseline required/,
  );
});
test("recording failure after native-independent edits prevents all further validation dispatch", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "repair-recording-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { saveReport } = await import("../src/evidence.js");
  let tripped = false;
  const report = await runScenario({
    outputRoot: directory,
    writer: (file, value) => {
      if (!tripped && value.agentResult?.edited) {
        tripped = true;
        throw new Error("Controlled recording failure");
      }
      saveReport(file, value);
    },
    agent: async (workspace, scenario, config) => {
      const result = { ...fix(workspace), edited: true };
      await config.onObservation(result);
      return result;
    },
  });
  t.after(() => fs.rmSync(report.workspace, { recursive: true, force: true }));
  assert.equal(report.passed, false);
  assert.equal(report.verification, null);
  assert.match(report.evidenceError, /recording failure/);
  assert.match(
    fs.readFileSync(path.join(report.workspace, "src/quote.js"), "utf8"),
    /discountedCents >= 5000/,
  );
  const disk = JSON.parse(fs.readFileSync(report.reportPath));
  assert.equal(disk.status, "failed");
  assert.equal(
    disk.commands.every((item) => item.status === "finished"),
    true,
  );
});
