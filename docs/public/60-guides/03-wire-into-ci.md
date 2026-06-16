---
status: current
last_verified: 2026-06-07
release: v0.1.3
title: "Wire into CI"
audience: [ci-integrators, getting-started]
purpose: "Task-led: add opensip-cli to your CI pipeline with PR annotations and baseline gating. GitHub Actions and GitLab examples."
source-files:
  - packages/fitness/engine/src/cli/fit.ts
  - packages/contracts/src/types.ts
related-docs:
  - ./01-write-your-first-check.md
  - ./04-adopt-in-a-monorepo.md
  - ../20-fit/04-output-gate-sarif.md
---
# Wire into CI

OpenSIP CLI is a CLI that exits with a code. Wiring it into CI is two lines for the basic case and ~15 lines for the full setup with PR annotations and baselines.

## The minimal setup

```yaml
# .github/workflows/fitness.yml
name: Fitness
on: [pull_request, push]

jobs:
  fit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: curl -fsSL https://opensip.ai/cli/install.sh | bash
      - run: opensip fit
```

`opensip fit` exits 0 if every check passed, non-zero otherwise. The build fails on red. No further setup required.

That's the floor. The rest of this page is the polish: how to surface findings as PR comments, how to adopt incrementally without blocking PRs on legacy violations, and how to keep CI fast.

## PR annotations via SARIF

opensip-cli exports the [SARIF](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html) format that GitHub understands natively via the `fit-baseline-export` subcommand. The flow is two steps: run `fit --gate-save` (which records findings into the project SQLite store, then exits according to the `failOnErrors`/`failOnWarnings` thresholds — ADR-0020: the step itself is the gate, not a free pass), then `fit-baseline-export --out fit.sarif` to write the SARIF document. Uploaded findings appear inline in the PR's "Files changed" view.

```yaml
- run: opensip fit --gate-save        # record findings, then exit per fail thresholds
- run: opensip fit-baseline-export --out fit.sarif
  if: always()      # the save happened before the exit — export even when the gate failed
- uses: github/codeql-action/upload-sarif@v3
  if: always()      # upload even when a previous step failed
  with:
    sarif_file: fit.sarif
    category: opensip-fit
```

The `if: always()` is important — `fit --gate-save` hard-fails the step when error-level findings breach the configured thresholds (set `failOnErrors: 0` in the `fitness:` block for a ratchet-only adoption where only net-new Code Scanning alerts block PRs), and GitHub skips subsequent steps after a failure by default. The baseline is saved *before* the exit code is set, so the SARIF export + upload still have everything they need — they just have to actually run.

For GitLab, convert the exported SARIF to the *Code Quality* widget format with [GitLab's converter](https://docs.gitlab.com/ee/user/application_security/sast/#sarif-format), renaming the output to `gl-code-quality-report.json`. (There is no native GitLab code-quality emitter today — go through SARIF.)

## Baseline-gate flow

If the codebase already has violations, gating on "all violations" blocks every PR until cleanup is done. Almost no team accepts that. The baseline-gate flow is the alternative: *capture today's violations, gate only on new ones.*

```bash
# Run once locally, on a clean main branch
opensip fit --gate-save
# This writes the baseline into opensip-cli/.runtime/datastore.sqlite
```

Then in CI:

```yaml
- run: opensip fit --gate-compare
```

`--gate-compare` exits 0 if no *new* violations appeared since the baseline. Existing ones are tolerated. The baseline lives in SQLite (`opensip-cli/.runtime/datastore.sqlite`); since `.runtime/` is gitignored, you'll want to publish + restore the baseline store as a CI artifact.

**The artifact pattern:** the gate baseline is a SQLite store, not a committed file. The standard flow is to run `fit --gate-save` on main-branch builds and upload `opensip-cli/.runtime/datastore.sqlite` as a workflow artifact; PR builds download that artifact into `opensip-cli/.runtime/` before running `fit --gate-compare`. (For a human-readable export — e.g. to inspect the baseline or feed GitHub Code Scanning — use `fit-baseline-export --out baseline.sarif`, which reads the same store.) See [output, gate, SARIF](../20-fit/04-output-gate-sarif.md) and [the architecture-gate CI patterns](../10-concepts/05-architecture-gate.md#ci-integration-patterns) for the full workflow.

## Recommended full setup

```yaml
name: Fitness
on:
  pull_request:
  push:
    branches: [main]

jobs:
  fit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: curl -fsSL https://opensip.ai/cli/install.sh | bash

      # Restore the baseline store produced by the last main-branch build.
      - uses: actions/download-artifact@v4
        if: github.event_name == 'pull_request'
        continue-on-error: true
        with:
          name: fit-baseline
          path: opensip-cli/.runtime/

      # On PRs: gate against new violations only.
      # On main: refresh the baseline (so the next PR sees current state).
      - name: Run fit
        run: |
          if [ "${{ github.event_name }}" = "pull_request" ]; then
            opensip fit --gate-compare
          else
            opensip fit --gate-save
          fi

      # Export the SARIF for PR annotations (reads the SQLite store).
      - name: Export SARIF
        if: always()
        run: opensip fit-baseline-export --out fit.sarif

      - name: Upload SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: fit.sarif
          category: opensip-fit

      # On main: publish the refreshed baseline store for the next PR.
      - uses: actions/upload-artifact@v4
        if: github.event_name != 'pull_request'
        with:
          name: fit-baseline
          path: opensip-cli/.runtime/datastore.sqlite
```

This is the shape we recommend: PRs see "is this getting worse?", main updates the bar. Developers fix legacy violations at their own pace; CI is fast (no full-codebase pass on every PR).

## Speed

Typical timings on the opensip-cli self-graph (~300 files, ~145 checks):

- `fit` (default recipe, parallel) — ~8s
- `fit --gate-compare` — same as `fit`, plus ~50ms baseline diff
- `graph` (cold) — ~15s
- `graph` (incremental, one file changed) — ~2.5s

If `fit` is slow on a large repo, the usual culprits:

- A specific check has an `O(n²)` scan. Run with `--verbose` locally to see per-check timing.
- Targets globs are too broad. The `targets:` block in `opensip-cli.config.yml` scopes which files each check matches; widening it from `src/**/*.ts` to `**/*.ts` will include `node_modules/` if you're not careful.
- A regex-shaped check has a catastrophic backtracking pattern. Switch to AST-driven analysis.

## What `opensip fit` actually does in CI

For a deeper understanding of the gate flow itself — what the baseline contains, how new-vs-old violations are matched, what the exit codes mean — see [output, gate, SARIF](../20-fit/04-output-gate-sarif.md).

## Where to go next

| You want to … | Go to … |
|---|---|
| Adopt incrementally on a large existing codebase | [Adopt in a monorepo](./04-adopt-in-a-monorepo.md) |
| Coexist with ESLint / migrate gradually | [Migrate from ESLint](./05-migrate-from-eslint.md) |
| Understand the baseline format and diff logic | [Output, gate, SARIF](../20-fit/04-output-gate-sarif.md) |
| See all CI-relevant CLI flags | [CLI commands](../70-reference/01-cli-commands.md) |
