# Repair a disposable repository with the Codex SDK

A standalone Codex SDK application gives a coding agent a synthetic checkout, asks for one bounded repair, and verifies its actual edits. The small order-pricing package contains a coupon/free-shipping defect. Its historical shipping note is stale; store configuration and every other file must remain untouched.

## Run

Requires Node 20+, Git, npm and `OPENAI_API_KEY` for normal model execution. Help, dataset initialization and verification need no provider access.

```sh
npm ci
npm test
npm run repair -- --help
npm run datasets -- list
npm run datasets -- init busy
npm run repair
npm run repair -- --scenario incomplete
```

`--model MODEL` selects an account-supported model; omission uses the SDK/CLI default model. `--timeout-ms 10..180000` bounds one turn (default 180 seconds). `--output-root DIR` changes the default `.runs/` evidence directory. A live run consumes account capacity; offline tests and help call no provider. CLI arguments are validated; SIGINT/SIGTERM request cancellation. A failed run exits nonzero and prints the report path.

The default `repair` task asks for free shipping on the **discounted** total at or above 5,000 cents; only `src/quote.js` may change. `incomplete` asks the agent to seek clarification for “Make checkout better” without editing files. The intentionally failing baseline must stay unchanged in that case. The scenario expectation is a file/check boundary; semantic quality of the clarification still needs model review.

## Execution and checks

1. Validate/copy the selected hash-bound dataset to a fresh private temporary Git checkout; clean up partial setup if initialization fails. `grader/` stays outside the copied checkout.
2. Capture the original commit **before** invoking the agent; verify the case's actual baseline exit (1 for the seeded bug, 0 for already-repaired; neither timeout nor missing command counts).
3. Create a private temporary Codex home and pass an explicit API key plus minimal environment to `@openai/codex-sdk` 0.162.1 with workspace-write sandbox, approvals never, network disabled and web search disabled. The ordinary path uses its real Codex CLI; there is no scripted CLI mode.
4. Require an actual `turn.completed`, nonempty final answer and no pending items, followed by clean stream exhaustion. Final-looking text before EOF is insufficient. Retain SDK failures/events even after edits.
5. Diff against the captured original commit, including agent-committed edits and ignored/untracked files. Use NUL-delimited paths, reject symlinks/deletions/out-of-scope paths, and scan again after checks. An agent commit cannot move this baseline. Out-of-scope entry points are not executed.
6. Run the unchanged checkout's `npm test` and the external grader, each bounded to 30 seconds/1 MiB output. A bounded repair must pass both; an incomplete request must leave all files untouched and retain the failing public baseline.

Normal runs isolate Codex configuration instead of inheriting the caller's account home, MCP connections or plugins. The owned home/session state is removed after success, failure and SDK startup errors; credentials are passed to the SDK, never included in reports. The host's managed configuration still applies where required by Codex. This follows [Codex configuration precedence](https://developers.openai.com/codex/config-basic/) and the SDK's explicit `env` contract. The application does not alter the user's global configuration. A caller-injected SDK retains its own configuration/credentials; its connector and session isolation are caller responsibilities. Unexpected MCP/web-search events fail with an unknown external outcome requiring inspection; post-event detection is not a pre-dispatch permission system.

The callable `runScenario({scenario, model, timeoutMs, signal, outputRoot})` returns the report. `runCodex` can accept a caller-owned SDK instance and observation callback. Its optional SDK factory is a callable dependency seam; the CLI has no scripted-executable flag. For lower-level verification, capture with `captureBaseline(workspace)` before the agent and pass it to `verifyWorkspace(workspace, scenario, baseline)`; it refuses a missing baseline. Do not reconstruct the baseline from the agent's final HEAD.

The SDK owns its child process and schema-file cleanup. The application bounds the turn, closes the event iterator and cancels active work before native iterator cleanup. This ordering avoids an observed unhandled child AbortError when aborting an already-closed iterator in pinned SDK 0.162.1; no vendor patch or global error suppression is used. Offline tests check actual child PIDs stop on success, malformed events, model failure and timeout. Caller-owned SDK configuration remains reusable.

## Evidence and reset

Private, atomic `report-<uuid>.json` files are written before agent execution, after each SDK event and on exit. Reports retain run/workspace/baseline IDs, prompt hash, initial/final checks, original SDK events and final text, failures, changed paths and cleanup requests. Native observations are limited to 2,000 events/1 MiB; oversized evidence fails the run. If persistent disk publication fails, the callable throws with its in-memory `error.report` and evidence error. Forced termination may leave a running report; inspect the checkout before trusting it.

Reports identify the declared SDK version, requested model, prompt hash and elapsed time. The actual serving model is unknown when the SDK does not report it. `agentResult.usage` is **SDK event usage**. This SDK fills absent `cache_write_input_tokens` with zero; the report labels that normalization. Raw provider usage and cost remain unknown. Do not treat normalized zero as proof the provider reported zero, or turn a failed stream into an empty successful result. A provider failure after an edit leaves that edit in the disposable checkout; reports do not roll it back or automatically retry.

Each invocation prepares a fresh local checkout. Retain its path for inspection, then remove only that disposable directory when finished. Reset does not delete reports or billing. The normal owned Codex home is removed on exit; caller-injected SDK account/session state remains caller-owned. One runner owns each checkout; do not share a checkout with other writers. The application guard and prompt are not a security boundary for malicious code: checks import/execute the synthetic project. Use only these fictional disposable repositories, never production code/credentials.

## Qualification status

Twenty-four offline checks cover seeded failure, bounded/unrelated/committed edits, post-test mutations, unusual filenames, actual SDK subprocess protocol, missing completion, blank/pending/malformed output, failure after an edit and timeout cleanup. The controlled native tests replace only the SDK executable with a synthetic child. They prove SDK serialization, event handling and process cleanup; they do not prove native CLI sandbox enforcement or model-directed repair.

The earlier real model/CLI repair is recorded in [evidence/live-repair.md](evidence/live-repair.md). It applies to its original runner, not a live rerun of this follow-up. Refreshed live-model/Firedrill proof remains external; no portfolio completion claim is made.

## Datasets and packaging

`atlas-checkout-repairs` version `1.0.0` contains seven hash-bound snapshots across four profiles: repair, busy, incomplete, conflicting-policy, already-repaired, exact-threshold and hostile-comment. The busy project has eight customers/24 settled historical orders plus a current request. Historical totals use their original policy and remain immutable; no model observations are seeded. [Scenario briefs](scenarios/README.md) explain independent outcomes. Only the selected project's ordinary files and dataset identity enter the target checkout; the manifest/grading modes and external grader stay outside.

`seed/` is an authoring template. Edit it or `scripts/build-datasets.js`, then regenerate with `npm run fixtures:build`. Initialization checks raw file hashes, snapshot index and dataset identity, copies privately/exclusively, and initializes a fresh Git baseline. Preparation/reset creates another checkout rather than overwriting an inspected one.

```sh
npm run check:package
npm run package
```

The locked source archive contains code, data, authoring template and external grader at their normal relative locations. Its gate installs locked dependencies outside the checkout, exercises CLI/help/list, initializes all seven projects, checks their real public baselines and verifies missing-key failure/evidence without launching a model. The archive gate exposed and fixed a circular top-level-await initialization deadlock. CI also regenerates and checks exact fixture bytes; no provider credentials are needed.

Explore the [example catalog](https://github.com/firedrill-tools/firedrill-example-catalog), [Firedrill](https://firedrill.run/) and [official developer documentation](https://docs.firedrill.run/). Add a thin adapter only after the new official interface is qualified; the retired integration is absent. Public visibility/license approval remains external.
