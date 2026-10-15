import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
const destination = path.resolve(process.argv[2] || path.join(root, '.runs', `codex-repository-repair-agent-${version}.tar.gz`));
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'firedrill-repair-source-'));
try {
  const directory = path.join(staging, 'package'); fs.mkdirSync(directory);
  for (const name of ['src','grader','seed','datasets','scripts','test','scenarios','README.md','AGENTS.md','package.json','package-lock.json','.gitignore','.gitattributes']) fs.cpSync(path.join(root, name), path.join(directory, name), { recursive: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  execFileSync('tar', ['-czf', destination, '-C', staging, 'package'], { stdio: ['ignore','pipe','pipe'] });
  console.log(destination);
} finally { fs.rmSync(staging, { recursive: true, force: true }); }
