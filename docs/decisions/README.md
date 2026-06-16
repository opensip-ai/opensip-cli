---
status: active
last_verified: 2026-06-01
owner: opensip-cli
---

# Architecture Decision Records

Durable architectural decisions for **opensip-cli**, one file per ADR. Each
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

## Index (most recent first)

- [ADR-0054](ADR-0054-tool-fault-isolation-boundary.md) — External Tool Fault-Isolation Boundary (target policy for external-provenance tools; this change only applies worker isolation to first-party graph live runs).
- [ADR-0053](ADR-0053-per-run-logger-scope.md) — Per-Run Logger Scope (production runs construct one `LoggerImpl` per `RunScope`; singleton logging becomes a pre-scope/compatibility adapter).
- [ADR-0052](ADR-0052-bootstrap-orchestration-state-machine.md) — Bootstrap Orchestration State Machine (the Commander hook remains the adapter, while bailout ordering and side-effect gates become explicit, testable phases).
- [ADR-0051](ADR-0051-host-owned-run-lifecycle-timing.md) — Host-Owned Run Lifecycle, Timing, and Persistence (one host `RunTimer` stamps `StoredSession.startedAt`/`completedAt`/`durationMs`; tools return a `ToolSessionContribution`; the `runSession.record` writer is removed).
- [ADR-0048](ADR-0048-tool-stable-uuid-identity.md) — Tool Stable UUID Identity (`id` for stable UUID on Tools, matching Checks; human string renamed to `name`; persisted in DB for collision safety).
- ADR-0047 — Per-Tool Contract Versioning
- ADR-0046 — Tool Contract Versioning Policy
- (earlier ADRs follow the numbered files in this directory)
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
  not a fast-climbing integer); **amended 2026-06-13: rebranded from
  `@opensip-tools/*` (reached `3.0.0` GA; latest published `2.13.0`) to the fresh
  `@opensip-cli/*` + `opensip-cli` identity and restarted at `0.1.0` (pre-1.0 —
  API not frozen, breaking changes may land on `0.y` minors; `1.0.0` is earned at
  API freeze). The earlier "stay on 2.x / GA at 3.0.0" conclusion is retired.**
  Legacy `@opensip-tools/*` packages retired via `npm deprecate` pointing at the
  new identity, never `unpublish`
- [ADR-0013](./ADR-0013-fitness-curated-export-surface.md) — Curate the
  `@opensip-cli/fitness` public barrel to the check/recipe/plugin authoring
  surface + `fitnessTool`; drop engine internals (registries, recipe service,
  gate primitives, `FitBaselineRepo`, CLI handlers). Locked by a runtime
  export-surface test; applies ADR-0009 concretely to fitness
- [ADR-0014](./ADR-0014-shared-inline-signal-suppression.md) — Inline,
  per-occurrence, reason-carrying finding suppression is a shared
  `@opensip-cli/core` primitive over the `Signal` stream; fitness migrates its
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
  `<tool>.recipe` > built-in `default`. A config-sourced unknown recipe falls
  back to the tool's `default` (warn); an explicit `--recipe` typo still
  hard-fails. Fixes a fit recipe default leaking into `graph`/`sim`; the 3.0.0
  config schema rejects the removed `cli.recipe` fallback
- [ADR-0023](./ADR-0023-config-package-and-schema-registry.md) — A dedicated
  `@opensip-cli/config` package owns the config composer (namespaced Zod
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
  persistence-free; `--json`/non-TTY stays in-process; `OPENSIP_CLI_NO_WORKER`
  forces the in-process fallback. Exercises the reversibility ADR-0016 reserved
- [ADR-0030](./ADR-0030-authored-tool-discovery.md) — Authored-Tool discovery
  realizes the ADR-0027 three-sources-one-path claim for the authored source:
  an `opensip-tool.manifest.json` sidecar under `~/.opensip-cli/tools/` (new
  `user-global` source, trusted-by-default) or `<project>/opensip-cli/tools/`
  (re-scoped `project-local`, deny-by-default — allowlist via
  `OPENSIP_CLI_ALLOW_PROJECT_TOOLS`, fail-closed exit 5 before import) is
  discovered, trust-gated, and routed through the same admit → import → register
  path bundled/installed tools travel. `plugin add --project` stays `installed`
- [ADR-0033](./ADR-0033-cross-package-resolution-via-shared-hop.md) — Cross-package
  edges resolve through **one shared hop** (the `resolve-decl` seam +
  `export-index` linker); the exact build is the **1-shard case** — it runs the
  SAME post-merge boundary linker sharded runs, so both engines compute
  cross-package edges by ONE model. The equivalence guardrail becomes a
  **directional soundness invariant** — any NEW divergence on the unified model
  fails, classified phantom (sharded-only) / decline (exact-only) / conflict (both
  differ), each ratcheted to its documented floor (gated per-direction so a fixed
  conflict can't mask a new phantom) — plus a **pinned-corpus completeness floor**
  (`resolution-completeness-floor.test.ts`) for the both-engine-decline blind spot.
  Direction is a diagnostic, not a verdict (neither engine is the oracle: a
  sharded-only edge is often a real edge exact under-resolved). Supersedes
  ADR-0032, **carrying its default-engine policy forward unchanged**
- [ADR-0034](./ADR-0034-language-adapters-host-wired.md) — Language adapters are
  **host-wired, not plugin-discovered**: the six bundled `@opensip-cli/lang-*`
  adapters are statically registered by the composition root
  (`register-language-adapters.ts`) and deliberately do NOT travel the
  tool-plugin path — they are the closed, version-locked parse substrate
  (ADR-0010), not a behavioral plugin, so ambient discovery would silently
  invalidate caches/baselines. This is the documented exception to the §8
  invariant-1 parity rule for first-party code in the host
- [ADR-0035](./ADR-0035-host-owned-verdict-from-tool-declared-policy.md) —
  **Pass/fail is a host-owned verdict** computed by `buildSignalEnvelope` from a
  **tool-declared findings policy** (reserved `failOnErrors`/`failOnWarnings`
  config keys, host fallback `{1, 0}`). One verdict (`envelope.verdict.passed`)
  drives both exit code and the new `{PASS|FAIL} (E Errors, W Warnings)` headline,
  retiring the hardcoded `errors === 0` and per-tool `shouldFail`. A plugin
  inherits it for free. Precondition: **sim must emit an error-severity signal per
  failed scenario** (it emits none today — an ADR-0011 currency violation) before
  it can migrate. Exit semantics behavior-preserving + verified per tool; headline
  is a deliberate change
- [ADR-0036](./ADR-0036-host-owned-baseline-ratchet-plane.md) — **Baseline capture +
  net-new ratchet + baseline export are a host-owned plane**, keyed on a first-class
  `Signal.fingerprint` each tool populates via a tool-declared strategy. One generic
  `tool_baseline_entries`+`tool_baseline_meta` table pair, one pure
  `added/resolved/unchanged` diff, and four `cli` seams replace fitness's + graph's
  bespoke gate/baseline/fingerprint/export (~500 LOC). A new tool gets a CI ratchet
  for free. Complements ADR-0035 (threshold verdict) by owning the orthogonal
  net-new gate it deferred; sequences **after** that work (shared files)
- [ADR-0037](./ADR-0037-generic-targeting-runtime.md) — **File-targeting resolution
  is a host runtime substrate** (`@opensip-cli/targeting`, exposed as
  `scope.targets`), finishing ADR-0023 which moved the targeting *types* host-side
  for cross-tool use but left the *runtime* in fitness. The generic half (named
  file-sets, `globalExcludes`, glob expansion, tag matching) moves down; the
  check-domain half (`checkOverrides`, the 3-tier precedence, the content
  `fileCache`, `findByScope`) stays in fitness as a thin consumer. Any tool resolves
  named targets without importing fitness
- [ADR-0038](./ADR-0038-registry-driven-init-scaffolding.md) — **`init` scaffolds the
  *registered* tools**, off each tool's `pluginLayout` + a new
  `Tool.scaffoldExamples(ctx)` hook, instead of the CLI hardcoding fit/sim dirs and
  owning the example `.mjs` source. Applies ADR-0009 (kernel carries no tool
  vocabulary) to the last place it leaks. A new tool scaffolds with zero CLI edits;
  `graph` (no `pluginLayout`) gets no dir. Byte-identical fit+sim output preserved
- [ADR-0039](./ADR-0039-check-packs-reach-parser-via-language-adapter.md) — **Check
  packs reach the parser substrate through the language adapter**: no
  `checks-*` → `@opensip-cli/tree-sitter` dependency. The lang-\* package
  re-exports the generic traversal/position vocabulary beside its
  grammar-specific predicates; a check pack depends on exactly `fitness` +
  `lang-<lang>`. Enforced by the `check-pack-no-tree-sitter` depcruise rule
- [ADR-0040](./ADR-0040-test-support-package.md) — **Cross-package test
  scaffolding lives in `@opensip-cli/test-support`** (private, never
  published): the `RunScope` test sugar (formerly core's published
  `test-utils` subpath) + the per-check fixture-coverage harness (formerly
  fitness prod source via `/internal`). Production source must never import
  it (`no-prod-import-of-test-support` depcruise rule); `fitness/internal`
  shrinks to `executeFit`
- [ADR-0041](./ADR-0041-customer-facing-tools-command-group.md) — **`tools` is
  the customer-facing whole-tool management surface**
  (`list|install|uninstall|validate|data purge`), a veneer over the existing
  plugin machinery; `tools validate` IS the bootstrap admission pipeline
  factored into one callable (one validator, four consumers). Subcommands
  only — no flag aliases, no `tool` singular. `plugin add --domain tool`
  demoted to low-level machinery with a help-hiding deprecation path.
  `validate`/`install` execute untrusted code behind the install consent gate;
  `tools list` never dynamic-imports a runtime
- [ADR-0042](./ADR-0042-tool-storage-contract-and-state-store.md) — **Two-tier
  tool storage contract + host-owned `ToolStateStore`**. Tier A (no
  DDL/migrations/datastore-file writes/private schema imports) gates admission
  NOW for all tools — bundled ones already satisfy it. Tier B (no raw
  handles; host-API-only persistence) is enforced only after first-party
  persistence migrates behind host seams — enforcing earlier would break
  3.0.0 parity (graph/fit hold the raw handle today). `tool_state`
  (`tool|key|payload|updatedAt`) copies the ADR-0036 generic-table pattern so
  third-party tools get persistence parity without schema ownership
- [ADR-0043](./ADR-0043-tolerated-unclaimed-config-namespaces.md) — **Unclaimed
  config namespaces warn loudly instead of passing silently** (bounds the
  document-level catchall ADR-0023 chose): the composer already tolerates
  unclaimed top-level keys silently (`composer.ts` catchall) — the live typo
  hole. Now an unclaimed namespace gets a per-run warning with a did-you-mean
  suggestion, and a LOADED tool with a present-but-undeclared namespace is
  rejected instead of falling into the catchall. Claimed namespaces stay
  strict; shared-config portability across different install sets is preserved
- [ADR-0045](./ADR-0045-gated-louvain-community-partition-prototype.md) —
  **Louvain import-community shard partitioning: prototyped under a numeric
  gate, measured, and discarded** (rejected by measurement, not by taste): the
  B2 gate required ≥25% fewer cross-shard boundary calls on both corpora — the
  real corpus (ant-design) delivered −4.7%, and warm wall-time regressed 1.94×
  on the synthetic fixture. The measured matrix lives in the ADR's Outcome;
  the bench harness (`bench:partition`), flat-large fixture generator,
  `graph.partitionStrategy` knob, and profile shard metrics were kept; the
  full prototype is recoverable at tag `prototype/louvain-partitioning`
- [ADR-0046](./ADR-0046-tool-contract-versioning-policy.md) —
  **Tool contract version is bumped only on real contract changes** and takes
  the major.minor of the CLI release in which the change ships (e.g. a
  contract-breaking change released in v1.2.0 sets `TOOL_CONTRACT_VERSION =
  '1.2'`). Releases with no `Tool` interface or `ToolExtensionPoints` semantic
  change leave the constant untouched. Enforcement is via this ADR + JSDoc
  requirements + a fitness architecture check.
- [ADR-0047](./ADR-0047-per-tool-contract-versioning.md) —
  **Per-tool contract versions** (FITNESS_CONTRACT_VERSION, GRAPH_..., etc.)
  for the rich domain surfaces, separate from the core TOOL_CONTRACT_VERSION bus
  marker. Each tool declares its version; independent evolution + ratcheting
  while keeping the generic Tool contract narrow and stable.

### Superseded

- [ADR-0032](./ADR-0032-sharded-engine-default.md) — The **sharded** engine is
  the graph default; **`--exact` is the opt-out** (`--sharded` removed; bare
  `graph` shards when shardable, exact fallback otherwise; `isTTY` selects only
  the renderer; cache key carries `mode=exact|sharded`). Its 2026-06-10 amendment
  recorded a flat CI-ratcheted residual budget. **Superseded by
  [ADR-0033](./ADR-0033-cross-package-resolution-via-shared-hop.md)**, which
  corrects the resolution model (one shared hop) and replaces the flat budget with
  a directional invariant + completeness floor — **retaining this ADR's
  default-engine policy unchanged**

- [ADR-0031](./ADR-0031-graph-determinism-one-build-one-finalize.md) — Graph
  determinism: one build → one finalize → many renderers. `@graph-ignore`
  suppression runs in a single `finalizeGraphSignals` seam every path must cross
  (enforced by a branded `FinalizedSignals` type — un-suppressed signals fail to
  typecheck at `persistSession`), closing the recurring TTY-only waiver leak. The
  build engine is chosen deterministically; `isTTY` selects only the renderer,
  never the engine; and the catalog cache key carries `mode=exact|sharded` so the
  engines never clobber each other. **Superseded by
  [ADR-0032](./ADR-0032-sharded-engine-default.md)**, which flips the default
  engine to sharded and replaces `--sharded` with `--exact` (the suppression seam
  + renderer-by-TTY + cache-mode invariants carry over unchanged)
