import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  captureBaseline,
  createWorkspace as prepareWorkspace,
  runScenario as scenarioRunner,
  verifyWorkspace as verifyOriginal,
} from "../src/repair.js";

const outputRoot = await mkdtemp(join(tmpdir(), "firedrill-repair-checks-"));
const workspaces = new Set();
async function createWorkspace() {
  const workspace = await prepareWorkspace();
  workspaces.add(workspace);
  return workspace;
}
async function verifyWorkspace(...args) {
  const result = await verifyOriginal(...args);
  if (result.checkDir) workspaces.add(result.checkDir);
  return result;
}
async function runScenario(options) {
  const report = await scenarioRunner({ ...options, outputRoot });
  if (report.workspace) workspaces.add(report.workspace);
  if (report.verification?.checkDir)
    workspaces.add(report.verification.checkDir);
  return report;
}
after(async () => {
  for (const workspace of workspaces)
    await rm(workspace, { recursive: true, force: true });
  await rm(outputRoot, { recursive: true, force: true });
});

test("the seeded checkout exposes the real bug and grader stays outside the checkout", async () => {
  const workspace = await createWorkspace();
  const verification = await verifyWorkspace(
    workspace,
    "repair",
    captureBaseline(workspace),
  );
  assert.equal(verification.passed, false);
  assert.equal(verification.publicChecks.exitCode, 1);
  assert.equal(verification.privateChecks.exitCode, 1);
  await assert.rejects(readFile(join(workspace, "grader/check.js")));
});

test("a bounded repair passes public and private checks", async () => {
  const report = await runScenario({
    agent: async (workspace) => {
      const file = join(workspace, "src/quote.js");
      const source = await readFile(file, "utf8");
      await writeFile(
        file,
        source.replace("subtotalCents >= 5000", "discountedCents >= 5000"),
      );
      return {
        completed: true,
        finalResponse: "Scripted repair for harness test",
      };
    },
  });
  assert.equal(report.passed, true, JSON.stringify(report.verification));
  assert.deepEqual(report.verification.paths, ["src/quote.js"]);
});

test("unrelated changes fail the boundary even after a correct repair", async () => {
  const workspace = await createWorkspace();
  const baseline = captureBaseline(workspace);
  const file = join(workspace, "src/quote.js");
  await writeFile(
    file,
    (await readFile(file, "utf8")).replace(
      "subtotalCents >= 5000",
      "discountedCents >= 5000",
    ),
  );
  await writeFile(join(workspace, "config/store.json"), "{}");
  const verification = await verifyWorkspace(workspace, "repair", baseline);
  assert.equal(verification.passed, false);
  assert.deepEqual(verification.invalidPaths, ["config/store.json"]);
});

test("incomplete request requires no edits", async () => {
  const report = await runScenario({
    scenario: "incomplete",
    agent: async () => ({
      completed: true,
      finalResponse: "What change is needed?",
    }),
  });
  assert.equal(report.passed, true);
  assert.deepEqual(report.verification.paths, []);
});

test("committing an unrelated edit cannot move the original scope baseline", async () => {
  const { execFileSync } = await import("node:child_process");
  const report = await runScenario({
    agent: async (workspace) => {
      const file = join(workspace, "src/quote.js");
      await writeFile(
        file,
        (await readFile(file, "utf8")).replace(
          "subtotalCents >= 5000",
          "discountedCents >= 5000",
        ),
      );
      await writeFile(join(workspace, "config/store.json"), "{}");
      execFileSync("git", ["add", "-A"], { cwd: workspace });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Synthetic",
          "-c",
          "user.email=synthetic@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "-qm",
          "controlled committed edits",
        ],
        { cwd: workspace },
      );
      return { completed: true, finalResponse: "Controlled test choices" };
    },
  });
  assert.equal(report.passed, false);
  assert.deepEqual(report.verification.paths, [
    "config/store.json",
    "src/quote.js",
  ]);
  assert.deepEqual(report.verification.invalidPaths, ["config/store.json"]);
  assert.equal(report.verification.publicChecks, null);
  assert.equal(report.verification.privateChecks, null);
});

test("an allowed committed repair remains visible and passes against the initial commit", async () => {
  const { execFileSync } = await import("node:child_process");
  const report = await runScenario({
    agent: async (workspace) => {
      const file = join(workspace, "src/quote.js");
      await writeFile(
        file,
        (await readFile(file, "utf8")).replace(
          "subtotalCents >= 5000",
          "discountedCents >= 5000",
        ),
      );
      execFileSync("git", ["add", "-A"], { cwd: workspace });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Synthetic",
          "-c",
          "user.email=synthetic@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "-qm",
          "controlled bounded repair",
        ],
        { cwd: workspace },
      );
      return { completed: true, finalResponse: "Controlled test choices" };
    },
  });
  assert.equal(report.passed, true);
  assert.deepEqual(report.verification.paths, ["src/quote.js"]);
});

test("files created by public checks are included in the final scope check", async () => {
  const report = await runScenario({
    agent: async (workspace) => {
      const file = join(workspace, "src/quote.js");
      let source = (await readFile(file, "utf8")).replace(
        "subtotalCents >= 5000",
        "discountedCents >= 5000",
      );
      source =
        "import fs from 'node:fs'; fs.writeFileSync(new URL('../config/store.json', import.meta.url), '{}');\n" +
        source;
      await writeFile(file, source);
      return { completed: true, finalResponse: "Controlled test choices" };
    },
  });
  assert.equal(report.passed, false);
  assert.equal(report.verification.publicChecks.exitCode, 0);
  assert.deepEqual(report.verification.invalidPaths, ["config/store.json"]);
  assert.equal(report.verification.privateChecks, null);
});

test("ignored and newline filenames cannot disappear from the scope report", async () => {
  const workspace = await createWorkspace(),
    baseline = captureBaseline(workspace);
  await writeFile(join(workspace, ".git/info/exclude"), "ignored.bin\n");
  await writeFile(join(workspace, "ignored.bin"), "synthetic");
  await writeFile(join(workspace, "notes\nextra.txt"), "synthetic");
  const verification = await verifyWorkspace(workspace, "repair", baseline);
  assert.deepEqual(verification.invalidPaths, [
    "ignored.bin",
    "notes\nextra.txt",
  ]);
  assert.equal(verification.passed, false);
  await assert.rejects(
    verifyWorkspace(workspace),
    /Original baseline required/,
  );
});
