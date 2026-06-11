---
status: current
last_verified: 2026-06-07
release: v3.0.0
title: "Migrating to 2.7"
audience: [ci-integrators, plugin-authors]
purpose: "Everything a --json consumer or plugin author must change to move to opensip-tools 2.7 (the signal-output + output-package breaking batch in the pre-GA 2.x line)."
source-files:
  - packages/contracts/src/signal-envelope.ts
  - packages/core/src/types/signal.ts
  - packages/output/src/index.ts
related-docs:
  - ./04-json-output-schema.md
  - ./02-package-catalog.md
  - ../../decisions/ADR-0011-signal-output-currency-formatter-sink.md
  - ../../decisions/ADR-0012-versioning-and-release-policy.md
---
# Migrating to 2.7

**2.7.0 lands a batch of breaking changes in the pre-GA 2.x line.** The project
stays pre-GA on the long-lived 2.x major (see
[ADR-0012](../../decisions/ADR-0012-versioning-and-release-policy.md)); breaking
changes are batched into 2.x minors. This release makes the signal-output model
the public `--json` contract and completes the `reporting`→`output` split and the
public-surface tightening. **`3.0.0` is reserved for the future tool-plugin-parity
north star**, not this release — so this guide covers the move to 2.7, and a
consumer on any earlier 2.x (≤ 2.6.2) should work through it when upgrading.

This page is the migration checklist. It is organized by *who you are*: most
readers are either a **`--json` / CI consumer** or a **plugin / library
author**. Work through the section that applies to you.

> **TL;DR:** if you only ever run the CLI and read its terminal output, nothing
> changes for you — upgrade and carry on. The breaking changes are all in the
> machine-readable `--json` shape, the published package set, and the
> programmatic (importable) API surface.

---

## For `--json` / CI consumers

### 1. `--json` now emits a `SignalEnvelope` (`schemaVersion: 2`)

The old `--json` payload was the fitness-shaped `CliOutput` husk
(`version: "1.0"`, `checks[]`, `findings[]`). 2.7 emits the signal-native
`SignalEnvelope` instead: `signals[]` + `verdict { score, passed, summary }` +
`units[]`, tagged `schemaVersion: 2`. This is the same shape for `fit`, `sim`,
and `graph` ([ADR-0011](../../decisions/ADR-0011-signal-output-currency-formatter-sink.md)).

**Action:** rewrite your jq/parsing against the new shape. The full
field-by-field translation is documented in the
[v1 → v2 mapping table](./04-json-output-schema.md#v1--v2-mapping), and the
complete envelope reference is the
[JSON output schema](./04-json-output-schema.md).

### 2. Severity is now four levels, not two

`error | warning` is replaced by the four-rung severity scale
`critical | high | medium | low`. The "error rung" (a finding that should fail a
gate) is `critical | high`; the "warning rung" is `medium | low`.

**Action:** anywhere you matched `severity == "error"` or `"warning"`, switch to
the rung you mean — e.g. `select(.severity == "critical" or .severity == "high")`
to fail on error-rung signals. See
[Reading the output in CI](./04-json-output-schema.md#reading-the-output-in-ci)
for ready-made jq recipes.

### 3. Pin `schemaVersion`, not the package version

The `--json` contract is versioned by the **`schemaVersion`** field on the
envelope (currently `2`), independent of the package version. A future
opensip-tools `3.x` will keep `schemaVersion: 2` as long as the wire shape is
stable; a `schemaVersion: 3` is allowed to break consumers.

**Action:** switch on `schemaVersion` in your consumer, not on the CLI's package
version. See
[Compatibility commitments](./04-json-output-schema.md#compatibility-commitments).

---

## For plugin authors / library consumers

### 4. Removed types in `@opensip-tools/contracts`

The following types backed the old `CliOutput` rendering model and are **gone**
from `@opensip-tools/contracts`:

- `CliOutput`
- `CheckOutput`
- `FindingOutput`
- `TableRow`
- `SummaryOptions`

**Action:** stop importing them. Tools no longer build a render payload — they
emit `Signal`s, and the CLI composition root routes the chosen formatter
(`json` / `sarif` / `table`) to the chosen sink. Produce `Signal`s (see
[`packages/core/src/types/signal.ts`](../../../packages/core/src/types/signal.ts))
and let the root render them.

### 5. `@opensip-tools/reporting` → `@opensip-tools/output`

The reporting package was renamed to `@opensip-tools/output` and split into a
pure `format/` half (signal → string formatters: json, sarif, table) and an
effectful `sink/` half (file, cloud), per
[ADR-0011](../../decisions/ADR-0011-signal-output-currency-formatter-sink.md).

**Action:** rename the dependency in your `package.json` and update imports from
`@opensip-tools/reporting` to `@opensip-tools/output`. See the
[package catalog](./02-package-catalog.md) for the current surface.

### 6. Kernel: `recipeCheckConfig` → `recipeUnitConfig`

The per-run recipe config slot on `RunScope` was renamed from
`recipeCheckConfig` / `RecipeCheckConfigSlot` to `recipeUnitConfig` /
`RecipeUnitConfigSlot` — "check" was fitness-specific; the slot now serves every
tool's units.

**Action:** if you read the recipe config slot off the scope, rename the
accessor. `getCheckConfig(slug)` still exists as the fitness-facing reader.

### 7. `./internal` subpaths are no longer published

Per [ADR-0009](../../decisions/ADR-0009-public-api-surface-policy.md) (audit
Findings 2–4), the `./internal` subpath exports — `@opensip-tools/fitness/internal`,
`@opensip-tools/graph/internal`, and friends — are **no longer in the published
`exports` map**. They were never a supported surface; external consumers can no
longer import them. Graph's public barrel was also curated: orchestration and
CLI helpers moved behind `./internal`.

**Action:** import only from the package barrel
(`@opensip-tools/fitness`, `@opensip-tools/graph`, …). If you depended on an
`./internal` symbol, open an issue — the right fix is to promote it to the public
barrel, not to reach past the boundary.

### 8. Parse substrate: the `@opensip-tools/tree-sitter` package

2.7 introduces `@opensip-tools/tree-sitter` and makes the `lang-*` packages the
canonical tree-sitter parse substrate
([ADR-0010](../../decisions/ADR-0010-lang-canonical-parse-substrate.md)).
Python / Rust / Go / Java now parse through `lang-*`, which parse through
`@opensip-tools/tree-sitter`.

**Action:** for most consumers this is transparent (it ships as a transitive
dependency of the language adapters). If you author a tree-sitter-backed adapter,
depend on `@opensip-tools/tree-sitter` directly rather than vendoring
`web-tree-sitter`.

---

## Where to go next

- [JSON output schema](./04-json-output-schema.md) — the full `SignalEnvelope`
  reference and the v1 → v2 mapping table.
- [Package catalog](./02-package-catalog.md) — the current 31-package set.
- [ADR-0011](../../decisions/ADR-0011-signal-output-currency-formatter-sink.md) —
  why `Signal` is the universal output currency.
- [ADR-0012](../../decisions/ADR-0012-versioning-and-release-policy.md) — the
  versioning and release policy (pre-GA 2.x line; 3.0.0 reserved for the
  tool-plugin-parity north star).
