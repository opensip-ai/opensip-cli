---
status: current
last_verified: 2026-05-27
release: v2.0.x
title: "Wire into CI"
audience: [ci-integrators, getting-started]
purpose: "Task-led: add opensip-tools to your CI pipeline with PR annotations and baseline gating. GitHub Actions and GitLab examples."
source-files:
  - packages/fitness/engine/src/cli/fit.ts
  - packages/contracts/src/types.ts
related-docs:
  - ./01-write-your-first-check.md
  - ./04-adopt-in-a-monorepo.md
  - ../20-fit/04-output-gate-sarif.md
---
# Wire into CI

opensip-tools is a CLI that exits with a code. Wiring it into CI is two lines for the basic case and ~15 lines for the full setup with PR annotations and baselines.

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
        with: { node-version: 22 }
      - run: npm install -g @opensip-tools/cli
      - run: opensip-tools fit
```

`opensip-tools fit` exits 0 if every check passed, non-zero otherwise. The build fails on red. No further setup required.

That's the floor. The rest of this page is the polish: how to surface findings as PR comments, how to adopt incrementally without blocking PRs on legacy violations, and how to keep CI fast.

## PR annotations via SARIF

`--report-format sarif` emits the [SARIF](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html) format that GitHub understands natively. Uploaded findings appear inline in the PR's "Files changed" view.

```yaml
- run: opensip-tools fit --report-format sarif --report-out fit.sarif
- uses: github/codeql-action/upload-sarif@v3
  if: always()      # upload even when the previous step failed
  with:
    sarif_file: fit.sarif
    category: opensip-fit
```

The `if: always()` is important — when the gate fails (exit code 1), GitHub skips subsequent steps by default. You want the SARIF upload to run anyway so the developer sees the annotations on their PR.

For GitLab, SARIF uploads to the *Code Quality* widget if you rename it to `gl-code-quality-report.json` and use [GitLab's converter](https://docs.gitlab.com/ee/user/application_security/sast/#sarif-format). Alternative: `--report-format gitlab-code-quality` (native, no conversion needed).

## Baseline-gate flow

If the codebase already has violations, gating on "all violations" blocks every PR until cleanup is done. Almost no team accepts that. The baseline-gate flow is the alternative: *capture today's violations, gate only on new ones.*

```bash
# Run once locally, on a clean main branch
opensip-tools fit --gate-save
# This writes the baseline into opensip-tools/.runtime/datastore.sqlite
```

Then in CI:

```yaml
- run: opensip-tools fit --gate-compare
```

`--gate-compare` exits 0 if no *new* violations appeared since the baseline. Existing ones are tolerated. The baseline lives in SQLite (`opensip-tools/.runtime/datastore.sqlite`); since `.runtime/` is gitignored, you'll want to publish + restore the baseline as a CI artifact, or commit it explicitly.

**Two patterns for shipping the baseline:**

1. **Commit it.** Add `opensip-tools/.runtime/baseline.sarif` (export with `opensip-tools fit --gate-save --export-baseline opensip-tools/.runtime/baseline.sarif`) and `git add -f` it. Pro: works on a fresh CI runner. Con: noisy diffs when the baseline updates.
2. **Restore from artifacts.** Cache the baseline file between runs via `actions/cache@v4` keyed on the main branch SHA. Pro: no commits in the repo. Con: a one-time bootstrap is needed.

For most teams, option 1 wins on simplicity. The baseline file is small (one entry per existing violation, deduplicated) and updates land in PRs that fix violations — which is the right moment to see them.

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
        with: { node-version: 22 }
      - run: npm install -g @opensip-tools/cli

      # On PRs: gate against new violations only.
      # On main: refresh the baseline (so the next PR sees current state).
      - name: Run fit
        run: |
          if [ "${{ github.event_name }}" = "pull_request" ]; then
            opensip-tools fit --gate-compare \
              --report-format sarif --report-out fit.sarif
          else
            opensip-tools fit --gate-save \
              --report-format sarif --report-out fit.sarif
          fi

      - name: Upload SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: fit.sarif
          category: opensip-fit
```

This is the shape we recommend: PRs see "is this getting worse?", main updates the bar. Developers fix legacy violations at their own pace; CI is fast (no full-codebase pass on every PR).

## Speed

Typical timings on the opensip-tools self-graph (~300 files, ~145 checks):

- `fit` (default recipe, parallel) — ~8s
- `fit --gate-compare` — same as `fit`, plus ~50ms baseline diff
- `graph` (cold) — ~15s
- `graph` (incremental, one file changed) — ~2.5s

If `fit` is slow on a large repo, the usual culprits:

- A specific check has an `O(n²)` scan. Run `--findings --verbose` to see per-check timing.
- Targets globs are too broad. The `targets:` block in `opensip-tools.config.yml` scopes which files each check matches; widening it from `src/**/*.ts` to `**/*.ts` will include `node_modules/` if you're not careful.
- A regex-shaped check has a catastrophic backtracking pattern. Switch to AST-driven analysis.

## What `opensip-tools fit` actually does in CI

For a deeper understanding of the gate flow itself — what the baseline contains, how new-vs-old violations are matched, what the exit codes mean — see [output, gate, SARIF](../20-fit/04-output-gate-sarif.md).

## Where to go next

| You want to … | Go to … |
|---|---|
| Adopt incrementally on a large existing codebase | [Adopt in a monorepo](./04-adopt-in-a-monorepo.md) |
| Coexist with ESLint / migrate gradually | [Migrate from ESLint](./05-migrate-from-eslint.md) |
| Understand the baseline format and diff logic | [Output, gate, SARIF](../20-fit/04-output-gate-sarif.md) |
| See all CI-relevant CLI flags | [CLI commands](../70-reference/01-cli-commands.md) |
