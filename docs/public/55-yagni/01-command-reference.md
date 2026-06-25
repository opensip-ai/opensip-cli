---
status: current
last_verified: 2026-06-22
release: v0.1.12
title: "YAGNI command reference"
audience: [contributors, ci-integrators]
purpose: "How to run the advisory YAGNI reduction audit and interpret its output."
source-files:
  - packages/yagni/engine/src/tool.ts
  - packages/yagni/engine/src/cli/yagni-command-spec.ts
  - packages/yagni/engine/src/cli/yagni-runner.tsx
  - packages/yagni/engine/src/cli/execute-yagni.ts
  - packages/yagni/engine/src/types/yagni-metadata.ts
related-docs:
  - ../70-reference/01-cli-commands.md
  - ../70-reference/03-configuration.md
  - ../40-graph/01-stages-and-catalog.md
---

# YAGNI reduction audit

`opensip yagni` is an **advisory** audit that surfaces evidence-backed opportunities to reduce code while preserving behavior. It emits ranked candidates with proof strength, preservation arguments, and validation steps — not automatic rewrites.

> **Scope (v0.1.12, ADR-0063):** yagni audits **config-surface reduction** (unused public config keys). It no longer performs duplicate-body detection — that re-implemented and diverged from graph's rule. **Duplicate / near-duplicate analysis now lives in [`opensip graph`](../40-graph/01-stages-and-catalog.md)** (`duplicated-function-body`, `near-duplicate-function-body`). yagni owns no graph evidence; the `--graph` flag and `graphMode` config are deprecated and inert (removal in 0.1.13).

## Quick start

```bash
opensip yagni
opensip yagni --json
opensip yagni --min-confidence high
opensip yagni packages/cli/src
```

Exit code is **0 by default** (`failOnErrors: 0`, `failOnWarnings: 0`). Findings are recommendations, not gate failures.

## Command surface

| Flag / arg | Meaning |
|---|---|
| `[paths...]` | Limit analysis to one or more directory subtrees |
| `--json` | Emit the canonical `SignalEnvelope` |
| `--min-confidence <level>` | Filter to `low`, `medium`, or `high` (default `medium`) |
| `--detector <slug>` | Run only named detectors (repeatable) |
| `--category <name>` | Filter by `metadata.yagni.reductionCategory` (repeatable) |
| `--graph <mode>` | **Deprecated (ignored since v0.1.12)** — yagni no longer builds a graph; use `opensip graph` for duplicate analysis |
| `--include-tests` | Include test and fixture code |
| `--verbose` | Show evidence, validation steps, and low-confidence findings |
| `--report-to`, `--open` | Host report delivery (same as other tools) |

Common flags: `--cwd`, `--quiet`, `--debug`, `--api-key`.

## Bundled detectors

| Detector | Category | Graph |
|---|---|---|
| `unused-config-surface` | `config` | no |

> Duplicate-body detection was removed in v0.1.12 (ADR-0063); it lives in `opensip graph` (`duplicated-function-body` + `near-duplicate-function-body`). A future "reduction coordinator" (ADR-0063 Track 2) will re-ingest graph's curated duplicate findings into the audit.

## Configuration

```yaml
yagni:
  failOnErrors: 0
  failOnWarnings: 0
  defaultMinConfidence: medium
  includeTests: false
  disabledDetectors: []
  detectorSettings: {}
```

> `graphMode` (and `OPENSIP_YAGNI_GRAPH_MODE`) are **deprecated and inert** as of v0.1.12 — still accepted so existing config keeps validating, but they have no effect. Removal targeted for 0.1.13.

## Finding model

Each signal carries `metadata.yagni`:

- `detector`, `reductionCategory`, `confidence` (`low` | `medium` | `high`)
- `locDelta` with `estimateKind` (`exact`, `lower-bound`, `heuristic`)
- `preservationArgument`, `suggestedAction`, `validationRequired`, `riskTags`
- `evidence[]` with stable `id`, `kind`, and `summary`

## Human output

On a TTY (and without `[paths...]` or `--json`), `opensip yagni` uses the shared live-run shell (`@opensip-cli/cli-live` + `@opensip-cli/cli-ui`): banner, `YAGNI Audit` header, progress stages, then the compact summary line and shared footer hints — the same chrome as `fit`, `graph`, and `sim`.

The non-TTY / piped path renders a static presentation. Default view shows **high + medium** confidence candidates grouped by confidence, with a `net: ~N LOC possible` footer. Low-confidence findings and the per-detector detail block appear only with `--verbose` or in JSON (matching fit/graph compact-vs-verbose gating).

## Suppressions

Per ADR-0014:

- `@yagni-ignore-file [-- reason]`
- `@yagni-ignore-next-line [detector] [-- reason]`

The `yagni-ignore-hygiene` fitness check audits directive quality out of band.
