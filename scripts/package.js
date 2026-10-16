import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(
  fs.readFileSync(path.join(root, "package.json")),
).version;
const destination = path.resolve(
  process.argv[2] ??
    path.join(
      root,
      "dist",
      `codex-repository-repair-agent-${version}-source.tar.gz`,
    ),
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const entries = [];
function collect(relative) {
  const file = path.join(root, relative),
    stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error("Source archives reject aliases");
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(file).sort())
      collect(`${relative}/${name}`);
  } else if (stat.isFile() && stat.nlink === 1 && stat.size <= 1048576)
    entries.push({
      path: relative,
      mode: stat.mode & 0o777,
      bytes: fs.readFileSync(file),
    });
  else throw new Error("Source archive requires bounded regular files");
}
for (const name of [
  ".gitattributes",
  ".github",
  ".gitignore",
  "AGENTS.md",
  "COMPATIBILITY.md",
  "PLAN.md",
  "README.md",
  "datasets",
  "evidence",
  "grader",
  "package-lock.json",
  "package.json",
  "scenarios",
  "scripts",
  "seed",
  "src",
  "test",
])
  collect(name);
entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const manifest = {
  schema_version: 1,
  package: "codex-repository-repair-agent",
  version,
  files: entries.map(({ path, mode, bytes }) => ({
    path,
    mode,
    bytes: bytes.length,
    sha256: digest(bytes),
  })),
};
entries.push({
  path: "SOURCE_MANIFEST.json",
  mode: 0o644,
  bytes: Buffer.from(JSON.stringify(manifest, null, 2) + "\n"),
});
const chunks = [];
for (const entry of entries) {
  const name = `package/${entry.path}`;
  if (Buffer.byteLength(name) > 100)
    throw new Error("Source archive path exceeds ustar name bound");
  const header = Buffer.alloc(512),
    write = (text, offset, length) =>
      header.write(text, offset, length, "ascii");
  write(name, 0, 100);
  for (const [value, offset, length] of [
    [entry.mode, 100, 8],
    [0, 108, 8],
    [0, 116, 8],
    [entry.bytes.length, 124, 12],
    [0, 136, 12],
  ])
    write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length);
  write("        ", 148, 8);
  write("0", 156, 1);
  write("ustar\0", 257, 6);
  write("00", 263, 2);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  chunks.push(
    header,
    entry.bytes,
    Buffer.alloc((512 - (entry.bytes.length % 512)) % 512),
  );
}
chunks.push(Buffer.alloc(1024));
const bytes = gzipSync(Buffer.concat(chunks), { level: 9 });
// RFC1952 OS=unknown keeps identical source bytes portable across zlib hosts.
bytes[9] = 255;
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, bytes);
fs.writeFileSync(
  destination + ".sha256",
  `${digest(bytes)}  ${path.basename(destination)}\n`,
);
console.log(
  JSON.stringify({
    archive: destination,
    sha256: digest(bytes),
    files: entries.length,
  }),
);
