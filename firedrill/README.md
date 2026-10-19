# Firedrill agent-first integration

The optional toolchain pins released `@firedrill-run/cli` and `@firedrill-run/sdk` **2.2.2** (October 19, 2026), Node 22+. The app retains its locked Codex SDK dependencies.

## Prepare and run

From the repository root:

```sh
npm ci
npm ci --prefix firedrill --ignore-scripts --no-audit --no-fund
npm test --prefix firedrill
node firedrill/node_modules/@firedrill-run/cli/bin/firedrill.mjs validate firedrill/scenario.json --json --non-interactive
```

Validation is offline. In a human terminal, use the same CLI `init` to authorize/select the actual project/environment. Automation uses protected `FIREDRILL_TOKEN`, `FIREDRILL_PROJECT_ID`, `FIREDRILL_ENVIRONMENT_ID`. Model operations independently need `OPENAI_API_KEY` and an enabled recipe model parameter (or the application default). Do not put credentials in recipes.

After scope and provider budget are authorized:

```sh
node firedrill/simulate.mjs --preview
node firedrill/simulate.mjs
```

The sequential recipe invokes the actual repository-repair CLI for repair, incomplete-request clarification and already-repaired verification. Each selection creates its normal hash-validated private temporary checkout and runs the real Codex SDK/CLI and existing external verification. No custom executable, provider endpoint, shell command, caller path or agent implementation is accepted by this adapter.

Each outer attempt first saves private `.runs/firedrill/attempt-*/invocation.json`; reports are retained beneath that directory, while the application owns its separate temporary checkout and original baseline. The mapping and controller data never enter the model checkout. The adapter removes Firedrill/CI credentials before child dispatch. It preserves the application’s minimal owned Codex home, process ownership/cleanup, original event receipts, independent source checks and protected-file scope. Scope validation is not an OS sandbox. Failed/incomplete work remains nonzero with original CLI output/report paths; no failed repair is released as success. Local termination does not establish remote cancellation, billing completion or rollback.

The input is only a reviewed case ID; the application's selected task remains authoritative. Current command invocation is ID-only and excludes controller/assessment data. Unsupported Tool bindings are rejected. Output paths are retained local evidence, not uploaded platform artifacts. New attempts create fresh state rather than resetting prior reports. Existing historical live evidence is not a new model run for this migration.

## MCP and recovery

Configure remote OAuth operator MCP at **https://mcp.firedrill.run/mcp** using [host setup](https://docs.firedrill.run/guides/coding-agents). MCP prepares, queues and inspects; the local SDK/CLI executes the command target. Host OAuth and execution login are separate. Use `--run BATCH_ID` to attach queued work, `--resume OPERATION_ID` after uncertainty, and `--result BATCH_ID` to read retained results. Preserve SDK journals and local evidence. These scripts retain public SDK diagnostics and whole-batch exit status; a new simulation starts new work.

CI and the fresh locked source archive run offline integration tests with the actual native-key boundary, baseline preparation and full existing native/scope checks. They establish wiring and cleanup, not live model quality, platform persistence, or uploaded captures. The observation recipe defines no grader/gate. Authenticated persisted happy/negative runs, paid model quality/cost, publication and licensing remain separate gates.

References: [SDK](https://docs.firedrill.run/sdk/typescript), [command targets](https://docs.firedrill.run/guides/callbacks), [operator MCP](https://docs.firedrill.run/guides/control-mcp), [CI](https://docs.firedrill.run/guides/ci).
