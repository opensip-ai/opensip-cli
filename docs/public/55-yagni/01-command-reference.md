---
status: current
last_verified: 2026-06-25
release: v0.2.1
title: "YAGNI command reference"
audience: [contributors, ci-integrators]
purpose: "How to run the advisory YAGNI reduction audit and interpret its output."
source-files:
  - packages/yagni/engine/src/tool.ts
  - packages/yagni/engine/src/cli/yagni-command-spec.ts
  - packages/yagni/engine/src/cli/yagni-runner.tsx
  - packages/yagni/engine/src/cli/execute-yagni.ts
  - packages/yagni/engine/src/types/yagni-metadata.ts
  - packages/yagni/engine/src/detectors/duplicate-body-candidate.ts
  - packages/yagni/engine/src/lib/build-ts-inventory.ts
related-docs:
  - ../70-reference/01-cli-commands.md
  - ../70-reference/03-configuration.md
  - ../40-graph/01-stages-and-catalog.md
---

# YAGNI reduction audit

`opensip yagni` is an **advisory** audit that surfaces evidence-backed opportunities to reduce code while preserving behavior. It emits ranked candidates with proof strength, preservation arguments, and validation steps — not automatic rewrites.

> **Scope (ADR-0064):** yagni ships two bundled detectors: `unused-config-surface` (config-surface reduction) and `duplicate-body-candidate` (exact-duplicate TypeScript function bodies). Duplicate detection uses the shared [`@opensip-cli/clone-detection`](../../../packages/clone-detection/src/index.ts) substrate — yagni builds its own TypeScript inventory (`buildTsInventory`, no `@opensip-cli/graph` dependency) and stays complete with graph uninstalled. Near-duplicate analysis remains graph-only (`graph:near-duplicate-function-body`). See [ADR-0064](../../decisions/ADR-0064-shared-clone-detection-substrate.md).

## Quick start

```bash
opensip yagni
opensip yagni --json
opensip yagni --json --filter errors-only --top 10
opensip yagni --min-confidence high
opensip yagni packages/cli/src
```

Exit code is **0 by default** (`failOnErrors: 0`, `failOnWarnings: 0`). Findings are recommendations, not gate failures.

## Command surface

| Flag / arg | Meaning |
|---|---|
| `[paths...]` | Limit analysis to one or more directory subtrees |
| `--json` | Emit the canonical `SignalEnvelope` |
| `--filter <filter>` | Agent JSON filter (repeatable): `errors-only`, `warnings-only`, `category:<name>`, `source:<slug>`, `file:<path>`, `high-impact`, `top:<n>` |
| `--top <n>` | Limit JSON signals (sugar for `--filter top:<n>`) |
| `--raw` | With filtered JSON, emit the raw `agent-filtered` payload |
| `--min-confidence <level>` | Filter to `low`, `medium`, or `high` (default `medium`) |
| `--detector <slug>` | Run only named detectors (repeatable) |
| `--category <name>` | Filter by `metadata.yagni.reductionCategory` (repeatable) |
| `--include-tests` | Include test and fixture code |
| `--verbose` | Show evidence, validation steps, and low-confidence findings |
| `--report-to`, `--open` | Host report delivery (same as other tools) |

Common flags: `--cwd`, `--quiet`, `--debug`, `--api-key`.

## Bundled detectors

| Detector | Category | Graph |
|---|---|---|
| `unused-config-surface` | `config` | no |
| `duplicate-body-candidate` | `dedupe` | no |

`duplicate-body-candidate` is TypeScript-only: yagni walks `.ts`/`.tsx` files, hashes normalized function bodies, and calls `findDuplicateBodies` from `@opensip-cli/clone-detection` — the same algorithm + curation policy `graph:duplicated-function-body` uses. A cross-tool parity test guards against the 430-vs-0 divergence class (ADR-0064).

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

## Finding model

Each signal carries `metadata.yagni`:

- `detector`, `reductionCategory`, `confidence` (`low` | `medium` | `high`)
- `locDelta` with `estimateKind` (`exact`, `lower-bound`, `heuristic`)
- `preservationArgument`, `validationRequired`, `riskTags`
- `evidence[]` with stable `id`, `kind`, and `summary`

Remediation guidance lives on the shared `signal.repair` contract, not inside
tool metadata.

## Human output

On a TTY (and without `[paths...]` or `--json`), `opensip yagni` uses the shared live-run shell (`@opensip-cli/cli-live` + `@opensip-cli/cli-ui`): banner, `YAGNI Audit` header, progress stages, then the compact summary line and shared footer hints — the same chrome as `fit`, `graph`, and `sim`.

The non-TTY / piped path renders a static presentation. Default view shows **high + medium** confidence candidates grouped by confidence, with a `net: ~N LOC possible` footer. Low-confidence findings and the per-detector detail block appear only with `--verbose` or in JSON (matching fit/graph compact-vs-verbose gating).

## Suppressions

Per ADR-0014:

- `@yagni-ignore-file [-- reason]`
- `@yagni-ignore-next-line [detector] [-- reason]`

The `yagni-ignore-hygiene` fitness check audits directive quality out of band.
