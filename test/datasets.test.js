import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { listCases, selectedCase } from "../src/datasets.js";
import {
  createWorkspace,
  captureBaseline,
  runScenario,
} from "../src/repair.js";

async function root(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "firedrill-repair-data-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
const completed = {
  completed: true,
  finalResponse: "Controlled dataset check, no live model judgment",
};
test("seven versioned snapshots span four profiles and materialize independently without grader answers", async (t) => {
  const manifest = await listCases();
  assert.equal(manifest.cases.length, 7);
  assert.deepEqual(
    new Set(manifest.cases.map((c) => c.profile)),
    new Set(["starter", "busy", "ambiguous", "boundary"]),
  );
  const checkouts = new Set();
  for (const item of manifest.cases) {
    const selected = await selectedCase(item.id),
      workspace = await createWorkspace(item.id);
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    checkouts.add(workspace);
    assert.match(captureBaseline(workspace).commit, /^[a-f0-9]{40,64}$/);
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(workspace, ".dataset.json"))),
      selected.identity,
    );
    await assert.rejects(fs.stat(path.join(workspace, "grader")));
    for (const file of selected.files)
      assert.deepEqual(
        await fs.readFile(path.join(workspace, file.path)),
        file.bytes,
      );
    const { spawnSync } = await import("node:child_process");
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const checks = spawnSync("npm", ["test"], {
      cwd: workspace,
      env,
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(
      checks.status,
      item.baseline_exit,
      checks.stdout + checks.stderr,
    );
    assert.equal(checks.error, undefined);
  }
  assert.equal(checkouts.size, 7);
});

test("busy business history is internally consistent and a bounded repair preserves it byte-for-byte", async (t) => {
  const outputRoot = await root(t);
  let historical;
  const report = await runScenario({
    scenario: "busy",
    outputRoot,
    agent: async (workspace) => {
      const customers = JSON.parse(
          await fs.readFile(path.join(workspace, "data/customers.json")),
        ),
        orders = JSON.parse(
          await fs.readFile(
            path.join(workspace, "data/historical-orders.json"),
          ),
        );
      assert.equal(customers.length, 8);
      assert.equal(orders.length, 24);
      for (const order of orders) {
        assert.ok(
          customers.some(
            (c) => c.id === order.customerId && c.currency === order.currency,
          ),
        );
        assert.equal(
          order.subtotalCents,
          order.items.reduce((n, i) => n + i.unitCents * i.quantity, 0),
        );
        assert.equal(
          order.discountCents,
          Math.round((order.subtotalCents * order.couponPercent) / 100),
        );
        assert.equal(
          order.shippingCents,
          order.subtotalCents >= 5000 ? 0 : 700,
        );
        assert.equal(
          order.totalCents,
          order.subtotalCents - order.discountCents + order.shippingCents,
        );
        assert.equal(order.policyVersion, "2026-04-pre-coupon");
      }
      historical = await fs.readFile(
        path.join(workspace, "data/historical-orders.json"),
      );
      const file = path.join(workspace, "src/quote.js");
      await fs.writeFile(
        file,
        (await fs.readFile(file, "utf8")).replace(
          "subtotalCents >= 5000",
          "discountedCents >= 5000",
        ),
      );
      return completed;
    },
  });
  t.after(async () => {
    await fs.rm(report.workspace, { recursive: true, force: true });
    if (report.verification?.checkDir)
      await fs.rm(report.verification.checkDir, {
        recursive: true,
        force: true,
      });
  });
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.deepEqual(report.verification.paths, ["src/quote.js"]);
  assert.deepEqual(
    await fs.readFile(
      path.join(report.workspace, "data/historical-orders.json"),
    ),
    historical,
  );
  assert.equal(report.dataset.case_id, "busy");
  assert.match(report.dataset.snapshot_sha256, /^[a-f0-9]{64}$/);
});

for (const scenario of ["conflicting-policy", "already-repaired"])
  test(`${scenario} requires no edit with its own expected baseline`, async (t) => {
    const outputRoot = await root(t),
      report = await runScenario({
        scenario,
        outputRoot,
        agent: async () => completed,
      });
    t.after(async () => {
      await fs.rm(report.workspace, { recursive: true, force: true });
      if (report.verification?.checkDir)
        await fs.rm(report.verification.checkDir, {
          recursive: true,
          force: true,
        });
    });
    assert.equal(report.passed, true, JSON.stringify(report));
    assert.deepEqual(report.verification.paths, []);
    assert.equal(report.baselineValid, true);
    assert.equal(
      report.before.exitCode,
      scenario === "already-repaired" ? 0 : 1,
    );
  });

test("external grader rejects an off-by-one repair even when the starter public tests pass", async (t) => {
  const outputRoot = await root(t),
    report = await runScenario({
      outputRoot,
      agent: async (workspace) => {
        const file = path.join(workspace, "src/quote.js");
        await fs.writeFile(
          file,
          (await fs.readFile(file, "utf8")).replace(
            "subtotalCents >= 5000",
            "discountedCents > 5000",
          ),
        );
        return completed;
      },
    });
  t.after(async () => {
    await fs.rm(report.workspace, { recursive: true, force: true });
    if (report.verification?.checkDir)
      await fs.rm(report.verification.checkDir, {
        recursive: true,
        force: true,
      });
  });
  assert.equal(report.verification.publicChecks.exitCode, 0);
  assert.equal(report.verification.privateChecks.exitCode, 1);
  assert.equal(report.passed, false);
});

test("corrupt packaged data fails hash validation before a checkout or model is opened", async (t) => {
  const directory = await root(t);
  await fs.mkdir(path.join(directory, "src"));
  await fs.copyFile(
    new URL("../src/datasets.js", import.meta.url),
    path.join(directory, "src/datasets.js"),
  );
  await fs.cp(
    new URL("../datasets/", import.meta.url),
    path.join(directory, "datasets"),
    { recursive: true },
  );
  await fs.writeFile(path.join(directory, "package.json"), '{"type":"module"}');
  await fs.appendFile(
    path.join(directory, "datasets/cases/repair/src/quote.js"),
    "\n// corrupted copy\n",
  );
  assert.throws(
    () =>
      execFileSync(process.execPath, ["src/datasets.js", "init", "repair"], {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    (error) => String(error.stderr).includes("Dataset file hash mismatch"),
  );
  await assert.rejects(selectedCase("../repair"), /Unknown/);
});
