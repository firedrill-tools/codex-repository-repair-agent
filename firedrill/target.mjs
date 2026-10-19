import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { ApplicationError, commandMain, invokeCLI, privateDirectory } from './adapter-runtime.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const cases = new Set(['repair', 'busy', 'incomplete', 'conflicting-policy', 'already-repaired', 'exact-threshold', 'hostile-comment']);
export async function runApplication(input, parameters, signal, invocation) {
  if (Object.keys(input).join(',') !== 'caseId' || !cases.has(input.caseId)) throw new Error('Select one reviewed repository case.');
  const directory = await privateDirectory(root, invocation);
  const argv = [process.execPath, 'src/cli.js', '--scenario', input.caseId, '--output-root', join(directory, 'reports'), '--timeout-ms', '180000'];
  if (parameters.model) argv.push('--model', parameters.model);
  try { return { application: await invokeCLI(argv, { cwd: root, signal, timeoutMs: 270000 }), localState: { directory } }; }
  catch (error) { if (error instanceof ApplicationError) error.evidence.runDirectory = directory; throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await commandMain(runApplication);
