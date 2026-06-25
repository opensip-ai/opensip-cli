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

## Quick start

```bash
opensip yagni
opensip yagni --json
opensip yagni --min-confidence high
opensip yagni --graph build
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
| `--graph <mode>` | Graph evidence: `auto`, `reuse`, `build`, or `off` (default `auto`) |
| `--include-tests` | Include test and fixture code |
| `--verbose` | Show evidence, validation steps, and low-confidence findings |
| `--report-to`, `--open` | Host report delivery (same as other tools) |

Common flags: `--cwd`, `--quiet`, `--debug`, `--api-key`.

## Bundled detectors (MVP)

| Detector | Category | Graph |
|---|---|---|
| `unused-config-surface` | `config` | no |
| `duplicate-body-candidate` | `dedupe` | yes |

Graph-backed detectors are listed in `session.payload.summary.skippedDetectors` when graph evidence is unavailable — never as placeholder `units[]` rows.

## Configuration

```yaml
yagni:
  failOnErrors: 0
  failOnWarnings: 0
  defaultMinConfidence: medium
  graphMode: auto
  includeTests: false
  disabledDetectors: []
  detectorSettings: {}
```

CI dogfood should pin `graphMode: build` or `off`, never `auto`, for deterministic runs.

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
