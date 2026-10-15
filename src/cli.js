import { runScenario } from './repair.js';

const args = process.argv.slice(2);
function parse() {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--scenario': 'scenario', '--model': 'model', '--timeout-ms': 'timeoutMs', '--output-root': 'outputRoot' }[args[i]];
    if (!key || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(options, key)) throw new Error('Invalid options; use --help');
    options[key] = key === 'timeoutMs' ? Number(args[i + 1]) : args[i + 1];
  }
  return options;
}
if (args.length === 1 && args[0] === '--help') console.log('Usage: npm run repair -- [--scenario CASE] [--model MODEL] [--timeout-ms 10..180000] [--output-root DIR]');
else {
  const controller = new AbortController(), stop = () => controller.abort(new Error('CLI interrupted'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const report = await runScenario({ ...parse(), signal: controller.signal });
    console.log(JSON.stringify({ passed: report.passed, scenario: report.scenario, workspace: report.workspace,
      changedPaths: report.verification?.paths ?? null, agentError: report.agentError, runnerError: report.runnerError ?? null, reportPath: report.reportPath }, null, 2));
    if (!report.passed) process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ error: error.message, reportPath: error.report?.reportPath ?? null })); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
