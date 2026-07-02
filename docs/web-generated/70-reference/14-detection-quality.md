---
status: current
last_verified: 2026-07-02
release: v0.2.x
title: "Detection Quality"
audience: [contributors, ci-integrators]
purpose: "Reference for the opensip-cli detection-quality measurement lane, labeled corpus, precision/recall/FPR metrics, and triage feedback loop."
source-files:
  - .config/detection-quality.json
  - .config/detection-quality-baseline.json
  - .config/detection-quality-report.md
  - scripts/measure-detection-quality.mjs
  - scripts/quality/
related-docs:
  - ./05-checks-index.md
  - ./11-performance-slos.md
  - ../20-fit/03-ignore-directives.md
---
# Detection Quality

OpenSIP CLI measures check quality through a script-level lane rather than a new
runtime command. The lane runs shipped checks against a labeled, redistributable
seed corpus and reports precision, recall, and false-positive rate per check.

Run locally after a build:

```bash
pnpm quality:measure -- --profile pr --out detection-quality-report.json
```

CI uses the already-built workspace output:

```bash
pnpm quality:measure:ci -- --check --out detection-quality-report.json
```

Refresh the committed baseline only after a deliberate check, corpus, or metric
change:

```bash
pnpm quality:measure:update
```

## Corpus

The default `pr` profile uses `scripts/quality/fixtures/seeded/manifest.json`.
It covers TypeScript, JavaScript, Python, Go, Java, Rust, C/C++, and universal
source-file checks with positive and negative labeled cases. The corpus is small
by design: it is a regression detector and methodology seed, not a claim that the
entire check catalog is fully benchmarked.

Local/private corpora can be passed with `--corpus-root <manifest>`. The script
does not download repositories or call the network.

## Labels And Metrics

Each case declares `expectFinding: true | false` for one or more check slugs. The
runner turns each check/case decision into:

| Outcome | Meaning |
|---|---|
| `tp` | Expected finding was produced. |
| `fn` | Expected finding was missing. |
| `fp` | Unexpected finding was produced. |
| `tn` | No finding expected and none produced. |

Per-check rates:

| Metric | Formula |
|---|---|
| Precision | `tp / (tp + fp)` |
| Recall / TPR | `tp / (tp + fn)` |
| FPR | `fp / (fp + tn)` |

Rates with a zero denominator are reported as `null` / `n/a`, never `NaN`.

## Regression Gate

`.config/detection-quality-baseline.json` is the committed release-over-release
baseline. Check mode fails when configured tolerances detect a precision drop,
recall drop, FPR increase, support loss, missing required language coverage, or
stale config hash.

The generated `.config/detection-quality-report.md` is checked for freshness in
check mode.

## Triage Feedback

`scripts/catalog-suppressions.mjs` reads the committed quality baseline when it
generates `.config/suppression-triage.md`. Suppression counts still matter, but
measured precision, recall, FPR, and support now help prioritize whether a slug
needs false-positive tightening, recall expansion, or accepted-risk
documentation.

This complements fixture coverage. Fixture coverage proves a check can fire on
known clean/violation examples; detection quality measures how a labeled corpus
classifies true positives, false positives, false negatives, and true negatives.

## Architecture Usefulness

The report also includes deterministic architecture-triage usefulness scenarios:
does graph or project-shape context change a review decision compared with a raw
scanner finding? The first version is scenario-based and local; it does not call
models and does not persist sessions.
