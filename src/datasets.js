import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../datasets/', import.meta.url));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export async function listCases() { return JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')); }
export async function selectedCase(id) {
  const manifest = await listCases(), selected = manifest.cases.find(item => item.id === id);
  if (!selected || !/^[a-z][a-z-]*$/.test(id) || !['repair','clarify','verify'].includes(selected.mode) || ![0,1].includes(selected.baseline_exit)) throw new Error('Unknown or invalid scenario');
  if (sha(JSON.stringify(selected.files)) !== selected.snapshot_sha256) throw new Error('Dataset index hash mismatch');
  const paths = new Set(), files = [];
  for (const entry of selected.files) {
    if (typeof entry.path !== 'string' || entry.path.includes('\\') || entry.path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git') || path.isAbsolute(entry.path) || paths.has(entry.path)) throw new Error('Invalid dataset path');
    paths.add(entry.path);
    const source = path.join(root, 'cases', id, entry.path);
    if (!(await fs.lstat(source)).isFile()) throw new Error('Dataset file is not regular');
    const bytes = await fs.readFile(source);
    if (sha(bytes) !== entry.sha256) throw new Error('Dataset file hash mismatch');
    files.push({ path: entry.path, bytes });
  }
  const identity = JSON.parse(files.find(item => item.path === '.dataset.json')?.bytes.toString() || 'null');
  if (identity?.id !== manifest.dataset_id || identity.version !== manifest.version || identity.case_id !== id || identity.profile !== selected.profile) throw new Error('Dataset identity mismatch');
  return { ...selected, files, identity, manifest_sha256: sha(JSON.stringify(manifest)) };
}
export async function copyCase(id, destination) {
  const selected = await selectedCase(id);
  for (const file of selected.files) {
    const target = path.join(destination, file.path); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.bytes, { flag: 'wx', mode: 0o600 });
  }
  return selected;
}
async function main() {
  const [command, id, ...extra] = process.argv.slice(2);
  try {
    if (!command || command === '--help') console.log('Usage: node src/datasets.js list | init <case-id>\nInit creates a fresh private temporary Git checkout without calling a model. Reset by preparing another copy; reports/account sessions are retained.');
    else if (command === 'list' && !id) console.log(JSON.stringify((await listCases()).cases.map(({ id, profile, task }) => ({ id, profile, task })), null, 2));
    else if (command === 'init' && id && !extra.length) {
      const selected = await selectedCase(id), { createWorkspace, captureBaseline } = await import('./repair.js');
      const workspace = await createWorkspace(id); console.log(JSON.stringify({ workspace, dataset: selected.identity, baseline: captureBaseline(workspace), task: selected.task }, null, 2));
    } else throw new Error('Invalid arguments; use --help');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
