---
status: active
last_verified: 2026-06-04
owner: opensip-tools
---

# ADR-0011: Signals are the universal output currency; tools emit, the composition root renders

```yaml
id: ADR-0011
title: Signals are the universal output currency; tools emit, the composition root renders
date: 2026-06-04
status: active            # active | superseded | deferred
supersedes: []
superseded_by: null
related: [ADR-0005, ADR-0008, ADR-0009, ADR-0006]   # symmetric tools; cloud signal sync (Signal/SignalSink); public-API + kernel-no-tool-vocab (this completes it); derived-data persistence
tags: [signals, output, contracts, rendering, architecture]
enforcement: mechanizable
enforcement-reason: >
  Retiring `CliOutput`/`CheckOutput`/`FindingOutput` from
  @opensip-tools/contracts makes the fitness-shaped envelope unimportable —
  a type that no longer exists cannot be re-grown. Two dependency-cruiser
  rules then keep the model honest: (1) a tool engine
  (`packages/{fitness,graph,simulation}/`) must not import the shared output
  layer's formatters (rendering belongs to the composition root, not the
  tool); (2) a tool engine must not import a sink it does not own
  (cloud/file/stdout egress is composition-root-driven). The kernel-vocabulary
  half (renaming `recipeCheckConfig`) is covered by ADR-0009's existing
  no-tool-vocab-in-core posture. The remaining invariant — "a tool emits
  `Signal[]` and never `process.stdout.write`s its own output" — is guarded
  by a fitness check (`no-direct-stdout-in-tool-engine`) plus the
  `CommandResult` return-type contract.
```

**Decision:** `Signal` (`packages/core/src/types/signal.ts`) is the single
output currency of every tool. A `fit` check, a `graph` rule, and a `sim`
scenario are all **units** that *produce signals*; the noun "unit" is the
neutral umbrella (the producers keep their own names — check / rule /
scenario). Every tool run yields one **signal envelope** — `Signal[]` plus run
identity (`tool`, `recipe`, `runId`) and a verdict header (`score`, `passed`,
`summary`) — which is structurally the existing `SignalBatch` (ADR-0008) with
the verdict fields added. The fitness-shaped machine-output contract
(`CliOutput` / `CheckOutput` / `checkSlug` / `FindingOutput` in
`packages/contracts/src/types.ts`) is **retired**: it is the one place in an
otherwise signal-native pipeline where signals are downgraded to a
check-shaped husk.

Output then decomposes along two orthogonal axes:

- **Formatters** — pure `(envelope) -> string`, *shared* across all tools, one
  per target format (json, sarif; human/table). Graph's existing `Renderer`
  type (`(signals, context) => string`) is the prototype.
- **Sinks** — *effectful* delivery, deliberately **heterogeneous** (stdout,
  file, chunked HTTPS to OpenSIP Cloud, sqlite). They are NOT unified behind a
  single interface, because they share nothing real to factor out.

A concrete output path is one formatter composed with one sink. **Tools never
render their own output**: they return the signal envelope via the existing
`CommandResult` seam, and the **CLI composition root** maps flags (`--json`,
`--report-to`, gate modes) to a (formatter × sink) pair — the same pattern
already used for the dashboard. As a corollary, `core`'s recipe-config slot is
renamed off check vocabulary (`recipeCheckConfig` → `recipeUnitConfig`,
`RecipeCheckConfigSlot` → `RecipeUnitConfigSlot`), completing ADR-0009's
"kernel carries no tool vocabulary".

**Alternatives:**

- *Version `CliOutput` to a neutral v2 (`units`/`findings`), keep the
  envelope-per-tool model.* Rejected: it preserves the lossy
  `Signal → Finding → CheckOutput` downgrade (collapsing 4 severities to 2,
  dropping `category`/`provider`/`fixConfidence`/`fingerprint`) and the three
  divergent shapes; we would be *versioning* a contract we can *delete*.
- *Drop `--json` entirely; consolidate machine output on SARIF.* Rejected:
  SARIF is a findings list with **no run verdict** — you cannot
  `jq -e '.passed'` or `.score >= 90` a SARIF log, which is the documented CI
  ergonomic (`docs/public/20-fit/04-output-gate-sarif.md`). Removing the flag
  breaks an advertised contract to avoid maintaining a shape; the fix is to
  repair the shape, not amputate the capability.
- *Keep per-tool renderers, only neutralize the vocabulary.* Rejected: leaves
  json/sarif rendering duplicated across `fitness` and `graph` (and absent from
  `sim`); every new tool re-implements them. Vocabulary drift is the symptom,
  scattered rendering is the disease.
- *Unify sinks behind a single `Sink` interface (symmetry with formatters).*
  Rejected as over-abstraction: a stdout write, a file write, a chunked HTTPS
  POST with idempotency/retry/entitlement, and a sqlite transaction have no
  honest common shape. Share the abstraction where things are the same
  (formatters); keep them separate where they are genuinely different (sinks).
- *Model cloud egress as "just another renderer".* Rejected: it would drag
  network IO, retries, auth, chunking, and entitlement into what must stay a
  pure-transform layer, collapsing formatter testability.

**Rationale:** The model is already the *internal* truth — the convergence
finishes it rather than inventing it.

- `Signal` lives in `core` and its own docstring reads *"Used by the check
  framework internally. **Converted to Finding for output.**"* — naming the
  exact lossy step this ADR removes.
- The cloud path already emits `Signal[]` natively (`SignalBatch`, ADR-0008);
  `graph` already models formatters as pure `signals -> string`
  (`packages/graph/engine/src/render/types.ts`); `sim` already accumulates
  `Signal[]` in `ScenarioResultBuilder` yet emits a **bespoke** json shape via
  `cli.emitJson(result)` with **no `reporting` dependency** — proving both that
  `CliOutput` is not universal (sim ignores it) and that `Signal` is the real
  currency (sim builds it).
- `CliOutput` is therefore the single fitness-named link in a chain that is
  neutral on both ends (recipe "unit" config upstream; `Signal`/`SignalBatch`
  downstream). Deleting it makes the output **strictly richer** (signals carry
  more than findings) and the code **strictly smaller** (one envelope, shared
  formatters).
- The composition-root seam already exists (`cli.emitJson` / `cli.render` on
  `ToolCliContext`; the `CommandResult` tool→runner contract in `contracts`).
  Tools currently bypass it by stringifying their own shapes; the decision
  makes them use it as intended — the same move the modular-monolith audit
  praised for the dashboard ("composition at the CLI composition root").

**Consequences:**

- **Contracts.** `CliOutput`/`CheckOutput`/`FindingOutput` are removed from
  `@opensip-tools/contracts`; the signal envelope type takes their place as the
  `CommandResult` payload. `TableRow`/`SummaryOptions` are reassessed (table
  rendering moves to the shared formatter/cli-ui layer).
- **Public `--json` is a breaking change (a 3.0-flavored bump).** `signals[]`
  replace `checks[]`; the public severity vocabulary becomes the 4-level
  `critical|high|medium|low` (was `error|warning`), and per-unit pass/fail is
  redefined accordingly. `docs/public/70-reference/04-json-output-schema.md`
  and the `jq '.checks[]'` examples are rewritten; the change is announced.
- **Rendering consolidates.** The json and sarif formatters join the shared
  output layer (today's `@opensip-tools/reporting`, likely renamed `output`
  since it is no longer cloud-only); the human/table formatter stays in
  `cli-ui`. `fitness` and `graph` shed their per-tool renderers and the
  `CliOutput` builders.
- **Dependency simplification.** A tool that used `reporting` only for output
  may shed that edge entirely (e.g. `graph → reporting`, used at `graph.ts:37`
  / `graph-modes.ts:25`). A tool importing a formatter, importing a sink it
  does not own, or writing to stdout directly becomes a dependency-cruiser /
  fitness-check violation.
- **Cloud egress simplifies.** Once the envelope is signal-native, `--report-to`
  / cloud sync ship it as-is (`SignalBatch`-native) with no SARIF conversion on
  that path. The distinct, documented `--report-to` SARIF-to-any-receiver
  capability (ADR-0008, owns exit code 4) is unaffected.
- **Tool-specific artifacts are explicitly allowed.** Signals are the *shared*
  output, not the *only* output: graph's `catalog.json` / call-graph
  visualization data and sim's load metrics remain tool-owned auxiliary
  artifacts alongside the envelope. The decision constrains the *common* output
  path, not bespoke side artifacts.
- **`sim` gains SARIF + cloud for free** the moment it emits the envelope (it
  has neither today), and its bespoke json shape is retired.
- **Kernel vocabulary.** Renaming `recipeCheckConfig`/`RecipeCheckConfigSlot`
  (with backward-compatible aliases through the deprecation window) closes the
  Finding-5 drift and makes ADR-0009's no-tool-vocab claim literally true.

**Related specs / ADRs:** To be implemented by a spec under
`docs/plans/specs/` (the enforced migration: retire `CliOutput`, introduce the
envelope, consolidate formatters, route at the composition root, add the
dep-cruiser + fitness-check gates). Related: ADR-0005 (symmetric tool
architecture — this extends symmetry to the output path), ADR-0008 (cloud
signal sync — owns `Signal`/`SignalSink`/`SignalBatch`, the substrate reused
here), ADR-0009 (public-API + "kernel carries no tool vocabulary" — this
completes the vocabulary half and resolves audit Findings 1 and 5), ADR-0006
(derived-data persistence — signals are derived data).
