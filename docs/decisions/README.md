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
  `checks-*`/`graph-*` name-prefix scans are demoted to deprecated fallbacks
  (removal next major), enforced by a workspace-invariant test
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
  not a fast-climbing integer); **3.0.0 is the first GA/stable release** on the
  existing names (same-name 1.0 reset is impossible — 1.0.0 is burned on npm;
  rename rejected); old versions retired via `npm deprecate`, never `unpublish`
- [ADR-0013](./ADR-0013-fitness-curated-export-surface.md) — Curate the
  `@opensip-tools/fitness` public barrel to the check/recipe/plugin authoring
  surface + `fitnessTool`; drop engine internals (registries, recipe service,
  gate primitives, `FitBaselineRepo`, CLI handlers). Locked by a runtime
  export-surface test; applies ADR-0009 concretely to fitness

### Superseded

_(none yet)_
