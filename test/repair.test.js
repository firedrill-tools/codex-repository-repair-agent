import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkspace, runScenario, verifyWorkspace } from '../src/repair.js';

test('the seeded checkout exposes the real bug and grader stays outside the checkout', async () => {
  const workspace = await createWorkspace();
  const verification = await verifyWorkspace(workspace);
  assert.equal(verification.passed, false);
  assert.equal(verification.publicChecks.exitCode, 1);
  assert.equal(verification.privateChecks.exitCode, 1);
  await assert.rejects(readFile(join(workspace, 'grader/check.js')));
});

test('a bounded repair passes public and private checks', async () => {
  const report = await runScenario({ agent: async workspace => {
    const file = join(workspace, 'src/quote.js');
    const source = await readFile(file, 'utf8');
    await writeFile(file, source.replace('subtotalCents >= 5000', 'discountedCents >= 5000'));
    return { finalResponse: 'Scripted repair for harness test' };
  } });
  assert.equal(report.passed, true, JSON.stringify(report.verification));
  assert.deepEqual(report.verification.paths, ['src/quote.js']);
});

test('unrelated changes fail the boundary even after a correct repair', async () => {
  const workspace = await createWorkspace();
  const file = join(workspace, 'src/quote.js');
  await writeFile(file, (await readFile(file, 'utf8')).replace('subtotalCents >= 5000', 'discountedCents >= 5000'));
  await writeFile(join(workspace, 'config/store.json'), '{}');
  const verification = await verifyWorkspace(workspace);
  assert.equal(verification.passed, false);
  assert.deepEqual(verification.invalidPaths, ['config/store.json']);
});

test('incomplete request requires no edits', async () => {
  const report = await runScenario({ scenario: 'incomplete', agent: async () => ({ finalResponse: 'What change is needed?' }) });
  assert.equal(report.passed, true);
  assert.deepEqual(report.verification.paths, []);
});
