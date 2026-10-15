# Live Codex SDK repair proof

Run: 2026-10-15, `@openai/codex-sdk` 0.162.1, default account model. The invocation used `npm run repair` with a fresh disposable checkout. The runner observed the seeded test failure before the agent started.

The SDK agent inspected the checkout, ran `npm test` (failed), changed `src/quote.js` so the free-shipping comparison uses the discounted total, then ran `npm test` successfully. It also checked the exact threshold boundary. The runner's Git diff contained **only** `src/quote.js`. Its two public tests and five external grader checks passed. The grader was not copied into the checkout.

SDK usage for this turn: 147,777 input tokens (126,336 cached) and 1,746 output tokens (286 reasoning output). The local, ignored `.runs/` JSON report holds the full event summary and check output; the temporary checkout remains available on the originating machine. This proof covers the repair scenario only. It does not cover the incomplete-request scenario with a live model or a Firedrill integration.
