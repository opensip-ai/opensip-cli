---
status: active
last_verified: 2026-06-01
owner: opensip-tools
---

# Architecture Decision Records

Durable architectural decisions for **opensip-tools**, one file per ADR. Each
record captures *what* was decided, the *alternatives* rejected, and the *why* —
so a future contributor can reconstruct the reasoning instead of re-litigating it.

ADRs are the **decision log** (the durable *why*). They complement, but are
distinct from:
- **`docs/plans/specs/`** — forward-looking *how to build it* specs, **local-only
  (gitignored, under `docs/plans/`)** (an ADR records the decision; a spec
  implements it).
- **`docs/internal/`** — looser contributor notes, operational awareness,
  cross-repo relationships.
- **`docs/public/`** — reader-facing product/usage docs.

## Conventions

- **One decision per file**, named `ADR-NNNN-kebab-title.md` (zero-padded to 4).
- **Numbering:** this repo uses **`ADR-NNNN`**. The parent `opensip` repo uses
  **`DEC-NNN`** and our code/specs sometimes cite parent DECs — reference those
  under `related:` as `DEC-NNN`. The two namespaces are deliberately separate so
  IDs never collide across repos.
- **Append-only:** never rewrite a shipped decision. To change one, write a new
  ADR, set the old one's `status: superseded` + `superseded_by: ADR-NNNN`, and the
  new one's `supersedes: [ADR-NNNN]`.
- **Status** lives in each file's YAML block: `active` | `superseded` | `deferred`.
- Start from [`TEMPLATE.md`](./TEMPLATE.md). The parent's SaaS-specific
  `Audit-history impact` block is intentionally omitted here.
- This index is **hand-maintained** for now; add your ADR below when you create
  it. (A generator can follow, like `scripts/build-web-docs.mjs`.)

## Index

### Active

- [ADR-0001](./ADR-0001-graph-rules-actionable-precise-bounded.md) — Graph rules
  must be actionable, precise, and bounded (rankings are dashboard insights, not
  gate rules)
- [ADR-0002](./ADR-0002-coupling-bucketing-by-nearest-package.md) — Coupling
  buckets by nearest `package.json`, not a path heuristic (per-package `package`
  field; shipped 2.4.2)
- [ADR-0003](./ADR-0003-per-occurrence-edge-keying.md) — A body hash is not an
  occurrence identity: edges (shipped 2.4.2) and reachability adjacency (pending)
  key per occurrence, never the `byBodyHash` winner (body-twin de-union)
- [ADR-0004](./ADR-0004-opt-in-opentelemetry.md) — Opt-in OpenTelemetry: env-var
  gate, `@opentelemetry/api` in `core` / SDK only in `cli`, tools instrument via
  the `withSpan` seam (migrated from `docs/internal/decisions/`)
- [ADR-0005](./ADR-0005-symmetric-tool-architecture-graph-rules-as-dataset-queries.md)
  — Symmetric tool architecture: `graph` reaches parity with `fitness`
  (`defineRule` ↔ `defineCheck`, shared recipe substrate hoisted to `core`,
  sessions + dashboard, an engine feature layer); rules are dataset-queries
  (ships v2.6.0)
- [ADR-0006](./ADR-0006-derived-data-persistence-policy.md) — Derived-data
  persistence policy: recomputed view by default, materialize only when recompute
  is expensive or a decoupled consumer can't run the query (no SQL/DB views)
- [ADR-0007](./ADR-0007-marker-canonical-plugin-discovery.md) — The
  `opensipTools.kind` marker is the canonical plugin-discovery contract; the
  `checks-*` prefix scan has been removed and graph adapter discovery is
  marker-gated, enforced by a workspace-invariant test
- [ADR-0008](./ADR-0008-opensip-cloud-signal-sync.md) — OpenSIP Cloud signal
  sync: an optional, entitlement-gated, best-effort sink emits the `Signal`s a
  run already produces to the cloud (store-only onboarding tier); local SQLite
  stays the source of truth, the datastore contract is unchanged (operational
  Postgres swap rejected), and `--report-to` is kept as the distinct SARIF path
- [ADR-0009](./ADR-0009-public-api-surface-policy.md) — Explicit public-API
  surfaces: test-only/internal exports move behind a `<pkg>/internal` subpath,
  the kernel carries no tool vocabulary, and persistence schema/raw-handle stay
  owner-private (repositories only), enforced by dependency-cruiser
- [ADR-0010](./ADR-0010-lang-canonical-parse-substrate.md) — `lang-*` is the
  single canonical parse + AST substrate for the whole platform: fitness checks
  *and* graph adapters consume `lang-*`, tree-sitter parsing moves from
  `graph-adapter-common` into `lang-*` (generalizing the existing
  `graph-typescript → lang-typescript` edge), `MinimalTextTree` is retired
  per-language — unblocking AST-level polyglot fit checks (parent DEC-521)
- [ADR-0011](./ADR-0011-signal-output-currency-formatter-sink.md) — `Signal` is
  the universal output currency: every tool (units = check/rule/scenario) emits
  one signal envelope (`Signal[]` + verdict), `CliOutput`/`CheckOutput` are
  retired, formatters become pure shared `envelope→string` transforms and sinks
  stay heterogeneous (not unified), and tools never render — the CLI composition
  root routes the envelope to a (formatter × sink). Resolves audit Findings 1 & 5
- [ADR-0012](./ADR-0012-versioning-and-release-policy.md) — Versioning & release
  policy: semver-honest package versions; the machine-output/wire contract is
  versioned independently via `SignalEnvelope.schemaVersion`/`SignalBatch.schemaVersion`;
  breaking changes batch into deliberate major windows (long-lived pre-GA majors,
  not a fast-climbing integer); **amended 2026-06-06: stays pre-GA on the 2.x line
  (accumulated breaking batch ships as `2.7.0`); GA is deferred to the
  tool-plugin-parity north star, which becomes `3.0.0`**; same-name 1.0 reset is
  impossible (1.0.0 is burned on npm; rename rejected); old versions retired via
  `npm deprecate`, never `unpublish`
- [ADR-0013](./ADR-0013-fitness-curated-export-surface.md) — Curate the
  `@opensip-tools/fitness` public barrel to the check/recipe/plugin authoring
  surface + `fitnessTool`; drop engine internals (registries, recipe service,
  gate primitives, `FitBaselineRepo`, CLI handlers). Locked by a runtime
  export-surface test; applies ADR-0009 concretely to fitness
- [ADR-0014](./ADR-0014-shared-inline-signal-suppression.md) — Inline,
  per-occurrence, reason-carrying finding suppression is a shared
  `@opensip-tools/core` primitive over the `Signal` stream; fitness migrates its
  accidental-home implementation onto it and graph adopts it (3.0 GA
  prerequisite). Whole-rule disable + the baseline ratchet stay per-tool.
  Extends ADR-0005's hoist-shared-substrate-to-core symmetry to suppression
- [ADR-0015](./ADR-0015-engine-version-cache-invalidation.md) — Fold the engine
  package version into the graph `cacheKey` (`stampEngineVersion`) at every
  engine-side cacheKey site, so a tool upgrade invalidates the catalog +
  per-shard fragment caches for every language. One stamp, both caches, no
  datastore migration; safe over-invalidation (one cold rebuild per upgrade)
- [ADR-0016](./ADR-0016-universal-progress-currency.md) — Universal progress
  currency + one live-progress renderer
- [ADR-0017](./ADR-0017-release-gate-policy.md) — Release gate must be at least
  as strict as the PR gate: `release.yml` re-runs `lint`/`test:coverage`/`fit:ci`/
  `graph:ci` before pack (option A, not verify-tagged-SHA); plus a single source
  of truth for the publishable package set verified by a PR-time contract test
- [ADR-0018](./ADR-0018-chaos-resilience-harness.md) — `sim` is a real BYO-target
  resilience/load harness: `load`/`chaos` drive a user-supplied `Target` and
  measure real outcomes, `chaos` injects client-side faults
  (`latency`/`abort`/`drop`) over a steady-state then a recovery window; the
  harness ships no runtime, demo server, or third-party target
- [ADR-0019](./ADR-0019-external-tool-adapter-checks.md) — External quality tools
  (eslint, dependency-cruiser, …) run as first-party `command:` fit checks so
  `fit` is the single quality entry point — wrap, don't reimplement; the published
  check packs ship no opinionated wrappers, the pattern is taught in
  `docs/public/50-extend` and this public repo is the living dogfooded example
  (dependency-cruiser keeps a standalone bootstrap carve-out)
- [ADR-0020](./ADR-0020-dogfood-gate-hard-fail.md) — The dogfood gate hard-fails
  the CI step on error-level findings: `fit --gate-save` now returns the
  `failOnErrors`/`failOnWarnings` exit code (mirroring live/JSON mode) instead of
  exiting 0 and trusting only the external Code Scanning net-new ratchet + branch
  protection (the weakness ADR-0017 rejected). The ratchet is retained for PR
  annotations and backlog adopters; graph's gate is the tracked follow-up
- [ADR-0021](./ADR-0021-cross-tool-cli-flag-currency.md) — One source of truth
  for cross-tool CLI flags: common flags (`--json`/`--cwd`/`--quiet`/`--verbose`/
  `--debug`/`--report-to`/…) are declared once in `contracts` and applied via
  `applyCommonFlags`; `--verbose` becomes an ADR-0011 output-currency concern
  rendered once through the shared `resultToView` seam (TTY == pipe), not in each
  tool's Ink runner; `sim` gains `--verbose`, `graph` gains `--quiet`; a
  `cross-tool-flag-parity` fitness check enforces the mandatory set + canonical
  descriptions
- [ADR-0022](./ADR-0022-tool-scoped-recipe-defaults.md) — Recipe defaults are
  tool-scoped: each tool reads `<tool>.recipe` from its own config block
  (recipe namespaces are disjoint), with precedence `--recipe` flag >
  `<tool>.recipe` > deprecated `cli.recipe` > built-in `default`. A
  config-sourced unknown recipe falls back to the tool's `default` (warn); an
  explicit `--recipe` typo still hard-fails. Fixes a fit recipe default leaking
  into `graph`/`sim`; `cli-recipe-deprecated` check drives migration
- [ADR-0023](./ADR-0023-config-package-and-schema-registry.md) — A dedicated
  `@opensip-tools/config` package owns the config composer (namespaced Zod
  schemas → one validated whole-document schema, strict, with JSON-Schema
  generation) and the tool-agnostic document blocks; tools contribute their own
  namespaced schema. Composer core lands in 2.10.0; the migration of scattered
  config (`cli-config` out of `contracts`, shared targeting out of `fitness`,
  user-global I/O, path resolution, template) lands in a 2.10.1 follow-up
- [ADR-0024](./ADR-0024-command-outcome-and-observability.md) — Every `--json`
  result and error is wrapped in one outer `CommandOutcome` (envelope under
  `.envelope`, command result under `.data`, structured `.errors`), assembled by
  the host through a single `renderOutcome` seam; adds the scope-owned
  `RunDiagnostics` bus, a governed `EnvRegistry`, and the `cli.emitError` seam
- [ADR-0025](./ADR-0025-session-replay-contract.md) — A stored session is
  replayed (not re-executed) via one shared structural decoder
  (`decodeSessionPayload` in `session-store`) plus a per-tool `sessionReplay`
  projection (new `Tool` contract member); surfaced as `sessions show` / `--show`
  and routed through the `CommandOutcome` seam
- [ADR-0026](./ADR-0026-graph-selection-only-execution.md) — Graph recipes are
  selection-only (no `execution` block): rule evaluation is one catalog pass, not
  a per-unit scheduled workflow, so graph does not adopt the 2.13.0 execution
  substrate — the intentional, ADR-documented `same-recipe-semantics` exception
- [ADR-0027](./ADR-0027-ga-parity-cutover.md) — GA (3.0.0): remove the privileged
  first-party paths — unify the loader (bundled tools load by dynamic import, no
  static `import { fitnessTool }`), remove `Tool.register()` + the raw-Commander
  `program` handle (commandSpecs is the one command surface), and end the
  `apiVersion` grace window. The acceptance test (`fit` loaded externally ≡
  bundled) passes; all nine §8 completion invariants are live guardrails
- [ADR-0028](./ADR-0028-off-main-thread-execution.md) — Off-main-process execution
  for live runs: interactive (TTY) runs fork the CLI to a per-tool headless worker
  subcommand (`fit/sim/graph-run-worker`) over the `ProgressTransport` seam, so the
  main process runs only Ink + the 80 ms clock and the spinner never starves;
  persistence/egress stay on the main process post-run; engine entries are
  persistence-free; `--json`/non-TTY stays in-process; `OPENSIP_TOOLS_NO_WORKER`
  forces the in-process fallback. Exercises the reversibility ADR-0016 reserved
- [ADR-0030](./ADR-0030-authored-tool-discovery.md) — Authored-Tool discovery
  realizes the ADR-0027 three-sources-one-path claim for the authored source:
  an `opensip-tool.manifest.json` sidecar under `~/.opensip-tools/tools/` (new
  `user-global` source, trusted-by-default) or `<project>/opensip-tools/tools/`
  (re-scoped `project-local`, deny-by-default — allowlist via
  `OPENSIP_TOOLS_ALLOW_PROJECT_TOOLS`, fail-closed exit 5 before import) is
  discovered, trust-gated, and routed through the same admit → import → register
  path bundled/installed tools travel. `plugin add --project` stays `installed`
- [ADR-0031](./ADR-0031-graph-determinism-one-build-one-finalize.md) — Graph
  determinism: one build → one finalize → many renderers. `@graph-ignore`
  suppression runs in a single `finalizeGraphSignals` seam every path must cross
  (enforced by a branded `FinalizedSignals` type — un-suppressed signals fail to
  typecheck at `persistSession`), closing the recurring TTY-only waiver leak. The
  build engine is chosen deterministically with the **exact** single-program
  engine as the default; **sharding is opt-in** via `--sharded`; `isTTY` selects
  only the renderer, never the engine; and the catalog cache key carries
  `mode=exact|sharded` so the engines never clobber each other

### Superseded

_(none yet)_
