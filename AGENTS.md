# Working rules

This repository is a standalone example application. Keep all checkout files synthetic. Do not introduce real customer data, credentials, or a dependency on the retired Firedrill integration.

The agent target is the disposable `seed/` copy. `grader/` must remain outside that copied checkout. Keep the changed-file allowlist narrow and test it with a real Git diff. Do not report scripted tests as live Codex proof.

Before claiming a live run, inspect the `.runs` report, its changed paths, public/private check exits, SDK error and usage. Add any future Firedrill integration only against a verified new release.
