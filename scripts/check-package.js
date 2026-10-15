import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'firedrill-repair-package-')), owned = [];
const env = { ...process.env }; delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; delete env.NODE_TEST_CONTEXT;
// Preserve the user's npm config file; avoid npm run's exported user setting
// becoming a rejected environment-level install setting under npm 12.
for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 60000, stdio: ['ignore','pipe','pipe'] });
try {
  const archive = path.join(temp, 'source.tar.gz'); run(process.execPath, ['scripts/package.js', archive], root);
  run('tar', ['-xzf', archive, '-C', temp], temp);
  const directory = path.join(temp, 'package');
  if (!fs.existsSync(path.join(directory, 'package-lock.json'))) throw new Error('Source archive lacks locked dependencies');
  run('npm', ['ci','--ignore-scripts','--no-audit','--no-fund'], directory);
  run(process.execPath, ['src/cli.js','--help'], directory); run(process.execPath, ['src/datasets.js','--help'], directory);
  const cases = JSON.parse(run(process.execPath, ['src/datasets.js','list'], directory));
  if (cases.length !== 7) throw new Error('Packaged cases differ');
  for (const item of cases) {
    const selection = JSON.parse(run(process.execPath, ['src/datasets.js','init',item.id], directory)); owned.push(selection.workspace);
    if (selection.dataset.case_id !== item.id || fs.existsSync(path.join(selection.workspace, 'grader'))) throw new Error('Packaged checkout is not isolated');
    const result = spawnSync('npm', ['test'], { cwd: selection.workspace, env, encoding: 'utf8', timeout: 30000 });
    if (result.error || result.status !== (item.id === 'already-repaired' ? 0 : 1)) throw new Error('Packaged public baseline differs');
  }
  const missingKey = spawnSync(process.execPath, ['src/cli.js','--scenario','repair','--output-root',path.join(temp,'reports')], { cwd: directory, env, encoding: 'utf8', timeout: 30000 });
  if (missingKey.error || missingKey.status !== 1) throw new Error('Missing-key preflight did not fail');
  const missing = JSON.parse(missingKey.stdout); owned.push(missing.workspace);
  if (!missing.agentError?.includes('OPENAI_API_KEY required') || !fs.existsSync(missing.reportPath)) throw new Error('Missing-key evidence is incomplete');
  console.log('Locked source archive: model-free CLI/help/list, seven private Git checkouts and their real public baselines passed outside checkout.');
} finally { for (const directory of owned) fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(temp, { recursive: true, force: true }); }
