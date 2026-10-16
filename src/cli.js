import { runScenario } from "./repair.js";

const args = process.argv.slice(2);
function parse() {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = {
      "--scenario": "scenario",
      "--model": "model",
      "--timeout-ms": "timeoutMs",
      "--output-root": "outputRoot",
      "--codex-path": "codexPath",
      "--provider-base-url": "providerBaseUrl",
    }[args[i]];
    if (
      !key ||
      !args[i + 1] ||
      args[i + 1].startsWith("--") ||
      Object.hasOwn(options, key)
    )
      throw new Error("Invalid options; use --help");
    if (
      key === "timeoutMs" &&
      (!/^[1-9][0-9]*$/.test(args[i + 1]) ||
        Number(args[i + 1]) < 10 ||
        Number(args[i + 1]) > 180000)
    )
      throw new Error("timeoutMs must be 10–180000");
    options[key] = key === "timeoutMs" ? Number(args[i + 1]) : args[i + 1];
  }
  return options;
}
if (args.length === 1 && args[0] === "--help")
  console.log(
    "Usage: npm run repair -- [--scenario CASE] [--model MODEL] [--timeout-ms 10..180000] [--output-root DIR] [--codex-path EXECUTABLE] [--provider-base-url URL]",
  );
else {
  const controller = new AbortController();
  let interrupted;
  const handlers = new Map(
    ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [
      signal,
      () => {
        interrupted = signal;
        controller.abort(new Error(`Received ${signal}`));
      },
    ]),
  );
  for (const [signal, handler] of handlers) process.once(signal, handler);
  try {
    const report = await runScenario({ ...parse(), signal: controller.signal });
    console.log(
      JSON.stringify(
        {
          passed: report.passed,
          scenario: report.scenario,
          workspace: report.workspace,
          changedPaths: report.verification?.paths ?? null,
          agentError: report.agentError,
          runnerError: report.runnerError ?? null,
          reportPath: report.reportPath,
        },
        null,
        2,
      ),
    );
    if (!report.passed)
      process.exitCode =
        interrupted === "SIGINT"
          ? 130
          : interrupted === "SIGTERM"
            ? 143
            : interrupted === "SIGHUP"
              ? 129
              : 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error.message,
        reportPath: error.report?.reportPath ?? null,
      }),
    );
    process.exitCode = 1;
  } finally {
    for (const [signal, handler] of handlers)
      process.removeListener(signal, handler);
  }
}
