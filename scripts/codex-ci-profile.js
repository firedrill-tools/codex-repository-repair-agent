import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
if (
  process.platform !== "linux" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.RUNNER_OS !== "Linux"
)
  throw new Error(
    "This profile helper is only for explicitly configured disposable GitHub Linux CI jobs",
  );
const profileFile = "/etc/apparmor.d/firedrill-codex-ci",
  mode = process.argv[2];
const sudo = (args, input) =>
  execFileSync("sudo", ["-n", ...args], {
    input,
    encoding: "utf8",
    timeout: 10000,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
if (mode === "remove") {
  if (fs.existsSync(profileFile)) {
    sudo(["apparmor_parser", "-R", profileFile]);
    sudo(["rm", "--", profileFile]);
  }
} else if (mode === "install") {
  const restriction = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
  if (
    !fs.existsSync(restriction) ||
    fs.readFileSync(restriction, "utf8").trim() !== "1"
  )
    console.log(
      "No AppArmor unprivileged-userns exception required on this CI runner",
    );
  else {
    const require = createRequire(import.meta.url),
      metadata = require.resolve("@openai/codex-linux-x64/package.json"),
      pkg = JSON.parse(fs.readFileSync(metadata));
    if (process.arch !== "x64" || pkg.version !== "0.162.1-linux-x64")
      throw new Error("Pinned Linux CLI profile needs requalification");
    const binary = fs.realpathSync(
      path.join(
        path.dirname(metadata),
        "vendor/x86_64-unknown-linux-musl/bin/codex",
      ),
    );
    if (
      !fs.statSync(binary).isFile() ||
      [34, 92, 10, 13].some((value) =>
        binary.includes(String.fromCharCode(value)),
      )
    )
      throw new Error("Invalid CI binary profile attachment");
    const profile = `abi <abi/4.0>,\ninclude <tunables/global>\nprofile firedrill_codex_ci "${binary}" flags=(unconfined) {\n  userns,\n}\n`;
    sudo(["tee", profileFile], profile);
    sudo(["apparmor_parser", "-r", profileFile]);
    console.log(
      `CI-only AppArmor userns permission attached to ${binary}; no global sysctl changed`,
    );
  }
} else
  throw new Error("Usage: node scripts/codex-ci-profile.js install|remove");
