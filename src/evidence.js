import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
export function saveReport(file, report) {
  const staged = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(staged, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(report, null, 2) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(staged, file);
    const directory = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  } finally {
    try {
      fs.unlinkSync(staged);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
export function prepareReport(outputRoot) {
  const runId = randomUUID(),
    directory = path.resolve(outputRoot, runId);
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  fs.mkdirSync(directory, { mode: 0o700 });
  return { run_id: runId, reportPath: path.join(directory, "trace.json") };
}
