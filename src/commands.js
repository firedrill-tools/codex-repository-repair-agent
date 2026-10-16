import { runProcess } from "./processes.js";
export function childEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      key === "NODE_TEST_CONTEXT" ||
      key.toLowerCase() === "npm_config_allow_scripts" ||
      key.startsWith("GIT_") ||
      [
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "ANTHROPIC_API_KEY",
        "GOOGLE_API_KEY",
        "GEMINI_API_KEY",
      ].includes(key)
    )
      delete env[key];
  return env;
}
export async function command(name, args, cwd, timeout = 30000) {
  if (name === "git")
    args = [
      "--no-replace-objects",
      "--no-optional-locks",
      "--git-dir",
      `${cwd}/.git`,
      "--work-tree",
      cwd,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.filemode=true",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ];
  const options =
    typeof timeout === "number" ? { timeoutMs: timeout } : (timeout ?? {});
  return await runProcess({
    ...options,
    program: name,
    args,
    cwd,
    env: childEnvironment(),
  });
}

export const succeeded = (result) =>
  Boolean(result) &&
  result.exitCode === 0 &&
  !result.signal &&
  !result.error &&
  result.lifecycle?.group_exit_confirmed === true &&
  result.lifecycle?.descendants_exit_confirmed === true;
