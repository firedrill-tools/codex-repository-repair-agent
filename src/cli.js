import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runScenario } from './repair.js';

const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
}
const scenario = option('--scenario', 'repair');
const model = option('--model', undefined);
const report = await runScenario({ scenario, model });
await mkdir('.runs', { recursive: true });
const reportPath = join('.runs', `report-${Date.now()}.json`);
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  passed: report.passed,
  scenario: report.scenario,
  workspace: report.workspace,
  changedPaths: report.verification.paths,
  agentError: report.agentError,
  reportPath,
}, null, 2));
if (!report.passed) process.exitCode = 1;
