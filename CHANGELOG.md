# Changelog

All notable changes to OpenSIP CLI are documented here.

## [0.8.4] - 2026-07-22

The largest correctness-and-hardening cut since the production launch. It folds
in the post-0.8.3 observability and architecture work, the canonical-column and
finite-decode planes, cleared dependency advisories, and a broad
bug-correctness sweep — most consequentially, a class of security/quality
checks that had been silently missing real violations, and a live capability
trust-boundary gap.

### Security

- **The private dogfood check-pack is no longer auto-trusted.** The
  bundled-tools manifest listed `@opensip-cli/checks-dogfood` (a private,
  never-published, dev-only pack), which made capability admission treat it as
  operator-trusted unconditionally — short-circuiting the trust-policy grant
  check that gates external capability packs. It now requires explicit
  `plugins.checkPackages` selection plus an operator `policy trust` grant, wired
  through the release workflow and preflight.
- **Cleared transitive dependency advisories** surfaced by the live
  `dependency-vulnerability-audit` check: two HIGH `fast-uri` host-confusion
  advisories (pinned to the patched `^3.1.4`, within ajv's major) and a MODERATE
  `@hono/node-server` path-traversal (forced to `^2.0.5`; unreachable in the
  stdio-only MCP server, but removed from the tree regardless).
- **Telemetry endpoint secrets are redacted** before they can reach logs, and
  the gitleaks description field is no longer echoed unredacted.

### Fixed

- **Fitness checks no longer match against string-blanked source.** A family of
  security and quality checks — rate-limit coverage, centralized-crypto,
  webhook-signature verification, JWT validation, transaction/event/service
  patterns, unbounded-memory, heavy-import detection, error-code registration,
  the drizzle/fastify/error-handling/test-only TypeScript checks, and Python
  bare-except — previously ran their matchers over `contentFilter: 'strip-strings'`
  output, so real violations wrapped in computed, string, or template forms were
  missed and comments containing code-like text produced false positives. They
  now match against a code-aware AST/mask substrate, closing both gaps.
- **Signal/violation columns are canonically 1-based at construction** (ADR-0179),
  so SARIF, reports, and MCP evidence point at the correct character rather than
  one column early; a decode plane rejects non-finite numeric session fields
  (ADR-0180).
- **Bounded, JSON-safe run diagnostics** (ADR-0175) with a guaranteed `--json`
  fallback, bootstrap diagnostics folded into the run-outcome plane (ADR-0176),
  external-scanner lifecycle events on the diagnostics bus, and SARIF ingest that
  fails closed on an invalid artifact.
- **Language and call-graph accuracy across every adapter.** TypeScript now
  discovers `.mts/.cts/.js/.jsx/.mjs/.cjs`, resolves aliased and
  namespace/qualified imports, and names computed/private members; the Python,
  Rust, Go, Java, and C/C++ adapters fix parser edge cases (raw C strings,
  multi-character literals, carriage returns, bare-except continuation, macro
  token grammar, build-like source packages). Dynamic imports and positional
  paths that escape the project root are no longer resolved into the catalog.
- **A crashed background heartbeat can no longer take down the host.** The shared
  runtime-lease heartbeat ran an async task without a rejection handler, so a
  rejection became an unhandled rejection on a process-global timer; it now
  swallows the rejection.
- **CLI and config correctness:** prototype-pollution and trust-file corruption
  guards on the config document, `cli.artifacts` config now rejects unknown keys,
  signed-zero suite arguments compare correctly, version and numeric options are
  validated, session-purge dates are bounded against overflow, user-uninstall
  recovery is resumable, and nested command surfaces are complete. `--include-tests`
  no longer hard-codes a default, letting the resolved config supply it.

### Added

- **`timer-callback-async-needs-catch`** (checks-typescript, resilience) flags a
  `void`-detached async timer callback whose promise chain lacks a `.catch` — the
  gap that let the heartbeat rejection escape `no-floating-promises`.

## [0.8.3] - 2026-07-20

Promotes the 0.8.2 change set to npm `latest`. The 0.8.2 cut published a
complete staged set but did not promote: the independent macOS qualifier
false-failed on the `persistence.cache-init-promotion` journey's two
intentional clean command failures (a lock/refusal exit and a gate exit),
which its expected-abnormal-terminal allowlist never accounted for. All 59
journeys passed; the block was a harness gap, not a product defect. Per the
partial-publish policy (npm versions are immutable), the fix ships forward as
0.8.3 rather than re-cutting 0.8.2.

### Fixed

- **macOS release qualifier allowlists the cache-init-promotion journey's
  intentional non-zero exits** (`EXPECTED_NON_ZERO_EXIT` {1,2} +
  `EXPECTED_ABNORMAL_TERMINAL_COUNTS` positive-exit:2), so a journey that
  correctly asserts two clean command failures no longer reads as an
  `unexpected-abnormal-terminal`. Verified against the real 0.8.2 qualification
  evidence.

All other changes in this release are the 0.8.2 set below (capability-load
parity/ADR-0174, worker→host diagnostics, the `brace-expansion` DoS patch, the
four macOS qualify product fixes), carried forward unchanged.

## [0.8.2] - 2026-07-20

Carries the fixes for the four macOS qualification failures that stopped the
0.8.1 candidate from promoting, plus a capability-load parity fix and the
observability that surfaced it, so consumer-visible `latest` can finally move
off 0.7.0 as a coherent set.

### Security

- **`brace-expansion` DoS advisory** (exponential-time expansion of consecutive
  non-expanding `{}` groups) patched by pinning the `@5` override to `^5.0.7`.

### Fixed

- **One authoritative capability-load driver (ADR-0174)**: a tool's check surface
  no longer diverges by provenance. The in-process (bundled) and dispatched
  (external) `fit` paths resolved different pack sets — the dispatched path fell
  through to auto-discovery under a divergent anchor and dropped bundled packs.
  The host driver, keyed on the canonical project root, is now the single loader
  on both paths (worker-side for a dispatched tool); the engine's lazy loader
  observes it and no-ops.
- **Worker diagnostics fold back into the host run**: a dispatched worker's
  lifecycle events + metrics (capability-domain load results, denied packs,
  foreign-core skips) now reach `--json` diagnostics via `DiagnosticsBus.ingest`
  instead of dying with the worker; the load event names its anchor and pack set.
- **`report` accepts `--cwd`**, restoring the cache-init promotion journey that
  drives `report` from outside the project root.
- **`init` on a read-only project root fails as a structured `command.error`**
  (naming `opensip-cli.config.yml` and the underlying `EACCES`) instead of a
  soft `status: "ok"` JSON body with a nonzero exit.
- **Published installs no longer warn about the private `checks-dogfood`
  pack**: bundled fit-packs are seeded only when they actually resolve under
  the CLI install tree, keeping `fit --json` output pure under a PTY. The
  monorepo keeps dogfood trust-admitted when present.
- **node_modules probes fail loud on resource-class errors**: `EMFILE`/`EIO`
  during pack resolution now throw `SYSTEM.PLUGINS.FS_PROBE_FAILED` instead of
  silently reading as "package not installed" — under load that silently
  shrank the seeded check surface. Absence (`ENOENT`/`ENOTDIR`) and
  permission-denied ancestors still read as not-installed.
- **External tool workers no longer lose their final result to the exit race**:
  the dispatch supervisor defers its premature-exit rejection and the worker
  drains its terminal IPC send (the same race closed for capability workers in
  0.7.1), eliminating spurious `exit_nonzero` failures with empty output under
  heavy load.
- Agent-eval's MCP handshake expects surface epoch 8, matching the live server.
- Core discovery tests assert only their own temp tree, removing a false
  ambient-package failure under full-lane parallel coverage.

## [0.8.1] - 2026-07-19

Ships the 0.8.0 feature set to npm `latest`. The 0.8.0 cut reached a partial
`release-candidate-0.8.0` stage only: a one-time bootstrap of
`@opensip-cli/shared-analysis@0.8.0` left registry bytes that did not match the
staged release artifact, and npm permanently retires a version after unpublish,
so 0.8.0 could not be completed as a coherent set. Consumer-visible `latest`
remained on 0.7.0 throughout.

### Fixed

- **Release stage skip verifies registry digests** against the staged tarball
  before treating a version as already published, so a bootstrap or other
  non-staged publish fails at stage instead of at macOS qualification.
- Multi-process runtime lease races: retry shared acquire on concurrent temp
  inspection, convert linked-create TOCTOU into mutex wait, skip racing orphan
  mutex temps, and tolerate CAS races when unlinking orphan temps.
- YAGNI dogfood gate: consolidate duplicate helpers that tripped
  `failOnWarnings`.
- Host trust treats `checks-dogfood` as a bundled fit-pack; prettier/format
  cleanup on touched CLI files.
- Init e2e/unit tests isolate `HOME` so exclusive runtime leases cannot contend
  on the developer `~/.opensip-cli-coordination` under parallel suite load.

### Changed

- Document partial-publish recovery when a registry version exists with a
  different digest than the staged release artifact (unpublish-window recovery
  or next lockstep version — never re-pack and skip mismatched bytes).

## [0.8.0] - 2026-07-19

> **Not promoted to npm `latest`.** See 0.8.1. A partial
> `release-candidate-0.8.0` set may exist on the registry for most packages;
> `@opensip-cli/shared-analysis@0.8.0` was unpublished and cannot be
> re-published.

A cache-first continuity and fail-loud hardening release. Evidence stays
addressable from first run through `init` without losing parent-run identity,
capability packs trust the operator (not the analyzed repo), silent-wrong
analysis paths get loud diagnostics, and a new `@opensip-cli/shared-analysis`
layer owns cross-tool impact and agent-catalog assembly. CI gains a shared
setup artifact and a strict required surface.

While opensip-cli is pre-1.0, this **minor is potentially breaking** for
consumers that placed capability-pack trust in project-local config, assumed
report HTML could target non-impact runs without exact run selection, or
imported analysis helpers from `@opensip-cli/contracts` that now live in
`@opensip-cli/shared-analysis`.

### Added

- **Cache-first runtime evidence continuity** (ADR-0170): no-init runs keep
  rebuildable evidence in the user cache; MCP can serve that evidence before
  `init`; transactional adoption promotes cache → project `.runtime` with
  journaled recovery and leased writers.
- **Exact parent Run identity** on CLI, report, and MCP: retain sessions and
  parent runs together, select run-addressed report artifacts, and read
  canonical execution runs (`list_execution_runs` / `show_execution_run` style
  surfaces) instead of “latest.”
- **Coordinated runtime leases** and bounded SQLite integrity checks so
  concurrent invocations and uninstall/purge cannot clobber live evidence.
- **`@opensip-cli/shared-analysis`**: graph impact, review-brief, and
  agent-catalog assembly extracted out of contracts (ADR-0172).
- **Capability-pack operator trust ceremony**: `policy trust` / `policy untrust`
  on the user-level global config with provenance binding; analyzed-repo config
  is not a trust grant (ADR-0171).
- **Graph parse-failure surfacing**: unparseable sources are logged and the run
  reports a non-zero parse-failure count when coverage is partial.
- **Dogfood checks** for the string pre-filter superset invariant and
  no-full-replacement `vi.mock` posture (ADR-0173).
- **CI required surface + shared setup** (ADR-0168): cold-gate in the stable
  aggregator path, shared install/build artifact handoff, pinned actions,
  fork-safe SARIF uploads, report integration lane.
- **No-flaky-tests policy** (ADR-0169) and agent-eval orphan-sweep hardening.
- Platform acceptance **v2** macOS qualification profile and continuity
  evidence for cache→init journeys.
- ADRs 0168–0173 (CI surface, no flakes, cache-first continuity, capability
  trust, shared-analysis layer, pre-filter superset).

### Changed

- Capability-worker resource guard is **advisory defense-in-depth**; admission
  is the enforced trust boundary. Admitted packs still run with the host user’s
  filesystem and network authority.
- Report generation **fail-closes** for non-impact runs without an exact retained
  parent run and prunes orphan report artifacts.
- Graph warm reads skip full catalog re-validation when identity is trusted;
  impact-trim and cross-shard resolve take measured hot-path wins (O(1) known
  paths, fixed-cost byte search, clone-detection bucket caps).
- Fitness `FileCache` hits skip redundant `fs.stat`; core file locks yield
  instead of busy-spinning; a single shared SIGINT handler covers forked
  children.
- Init accepts polyglot language detection and surfaces transactional adoption
  state in the CLI UI.
- Graph engine types split into cohesive modules; MCP impact/test-selection
  reads extracted from the read-port facade.

### Fixed

- **`no-any-types` silent green**: pre-filter is a true superset of the AST match
  (including no-space forms like `:any` / `,any`); broader string pre-filter
  audit across checks.
- Graph catalog write/read and cloud-sync skip paths log **causes** instead of
  cause-less lines; disposer failures during scope teardown are logged, not
  swallowed.
- MCP trust downgrade uses set membership (not reason-count equality); NaN-safe
  graph read limit clamp with typed truncation classification.
- Uninstall/sessions purge: leased project and user-state removal, recovery
  when user data deletion is interrupted, purge of active local evidence.
- Live runtime cache pruning no longer deletes in-use runtimes.
- macOS qualification never-green lane and weekly correctness audit bugs.
- Release workflow GitHub-parser rejection + actionlint gate; main CI coverage,
  dogfood scope, Linux hang, and perf-SLO restorations.
- Repository quality-gate restoration: exact/sharded graph equivalence,
  persistence boundaries, fitness/uninstall findings, bounded workspace test
  concurrency without retries or timeout widening.

## [0.7.0] - 2026-07-15

An agent-context, first-run, and proof-of-change release. `opensip audit` works
before `init`, deterministic task-context evidence lands on MCP for agent edit
loops, the HTML report adds a visual proof-of-change surface, and a measured
performance program cuts large-repo cost without changing product contracts.
Install UX, reserved host names, and a black-box agent-eval harness round out
the control plane.

While opensip-cli is pre-1.0, this **minor is potentially breaking** for
consumers that assumed first-run always wrote project-local runtime state,
relied on unbounded report catalog embedding, or treated host command / suite
names as free for third-party tools.

### Added

- **Canonical audit visual proof** workflow: changed-code review with an HTML
  proof surface so humans and agents can see what the run decided (ADR-0155).
- **Deterministic agent task context** plane: bounded file-scoped context,
  impact, and test-selection evidence over MCP for edit loops without ad-hoc
  graph rebuilds (ADR-0160, ADR-0161).
- **Agent-eval harness** (`@opensip-cli/agent-eval`, private): black-box gold
  tasks that measure context-tool honesty and promotion readiness
  (ADR-0157, ADR-0158).
- **Visual proof-of-change** dashboard report and related suite presentation.
- **Measured performance program**: contributor benchmark/SLO lane, evidence
  docs, and optimizations for large inventories and sharded graph context
  (ADR-0163 local CPU profiling posture).
- **Init / capability UX**: optional tools and distribution footprint
  measurement guidance so adopters can see install cost before enabling packs.
- Host reservation of **command and built-in suite names** so plugins cannot
  shadow audit and other host surfaces (ADR-0159).
- Report control: `--max-catalog-mb` and a named escape hatch in truncation
  notices when the inlined graph catalog would blow report size.
- Installer: clearer download+install progress and upgrade messaging
  (`Updated opensip from vA to vB` when a prior version is present).
- DX: `pnpm opensip` / `pnpm opensip:audit` passthrough scripts and audit-first
  docs flow.
- ADRs 0155–0163 (audit command, impact proof, agent-eval, reserved names,
  task context, inventory ownership, TypeScript readiness, local profiling).

### Changed

- **First run without init**: `opensip audit` and related surfaces work in a
  supported project before scaffolding; rebuildable runtime state stays in the
  user cache so a first run does not write into the customer repo.
- No-init runtime cache is pruned instead of growing without bound.
- Dashboard bounds the inlined graph catalog (multi-hundred-MB reports reduced
  to single-digit MB class by default) and hardens oversized live-report paths
  against OOM in tests and real runs.
- Public docs cover plans 1–6 surfaces (audit, context, capability, perf,
  report, install).
- Tooling baseline: Prettier 3.9.4 format gate; TypeScript 6.0.3 test-typecheck
  reconciliation.

### Fixed

- Multi-pass bug and correctness sweeps (green-wash holes for security/path
  gates, silent host-command failures, faulting parity, coverage gaps).
- Context plane: evidence production/freshness bounds, unambiguous impact
  symbol identity, integrated graph policy gates, abandoned shared impact
  index cancellation.
- Graph: sharded context parity; wide-function and near-duplicate noise.
- CLI: single scope-aware runtime-state seam; typed host-command failure
  presentation instead of silent exit.
- Distribution offline measurement hardening; post-landing review and lint
  follow-ups across plans 1–6.

## [0.6.0] - 2026-07-12

An MCP audit-evidence correctness and efficiency release. Graph catalogs and
MCP tools now carry complete import evidence, optional declaration/reference
facts, four independent coverage facets, and exclusive compact projections so
agents can diagnose connectors, packages, and runtime wiring without flooding
context. Publishable packages fail closed on incomplete boundary maps and ship
runtime artifacts only; test typecheck runs as an isolated monorepo lane.

While opensip-cli is pre-1.0, this **minor is potentially breaking** for MCP
clients and tool authors that assumed mixed verbose payloads, identity-stable
`defineCommand` returns, or incomplete public package export maps.

### Breaking

- MCP graph tools default to **exclusive** compact `detail` modes
  (`summary` | `groups` | `nodes`) instead of combining nodes with groups or
  verbose mixed payloads. Identity searches (`search_symbols`,
  `search_declarations`) default to `detail=nodes` with **limit 20** (caller
  range still 1–500); other paged tools keep default 100 / max 500.
- Package samples, cycle proofs, and architecture row families are **opt-in**;
  default responses return counts/coverage without large evidence samples.
- `defineCommand()` **copies and freezes** the validated spec (including optional
  `staticHandler`); it is no longer an identity pass-through. Mutating a
  returned spec or relying on `===` with the input fails.
- Publishable package boundaries and production packlists are enforced: incomplete
  export allowlists, test files in published `dist`, and masked workspace deps
  fail CI. Consumers must use documented public barrels only.

### Added

- Optional catalog **semantic facts** (exact TypeScript): bounded declarations
  and cross-file references with present-empty vs absent semantics; public
  graph/read views and MCP tools `search_declarations` / `references_to`
  (default MCP inventory **21** tools; **22** with mutation).
- Complete module **import evidence** on exact catalogs (form/role/target/basis),
  workspace declaration-entry attribution, and independent dependency/semantic
  producer cache ABI segments (catalog version remains `3.0`, no SQL migration).
- Four **coverage facets** (inventory / evidence / grouping / projection) on
  graph MCP responses, independent of each other.
- Config `graph.auditTestSourceGlobs` and an explicit source-role matcher for
  audit-oriented test/production classification on reads.
- Core `CommandSpec.staticHandler` descriptors and plain per-run
  `RuntimeCommandInventory` on `RunScope`; CLI projects the full host+Tool
  surface; MCP `get_runtime_wiring` bridges handlers to declarations without
  inventing call edges (`w1:` runtime identity + `g1:` catalog join).
- `get_agent_catalog` additive `mcp` block: live server version, surface epoch,
  registered tool names/count, mutation posture, and canonical project root for
  connector diagnosis (reconnect for a new surface; `refresh_graph` is not a
  connector repair).
- Architecture gates for complete package export allowlists, production packlists,
  and derived Tool/package facts (ADR-0150, ADR-0151).
- Isolated per-package **test typecheck** lane wired into monorepo typecheck/lint.
- ADRs 0150–0154 (production artifacts only; package/export boundaries; dependency
  and declaration evidence; faceted compact MCP protocol; declarative runtime
  handler bridge). ADR-0153 supersedes ADR-0149.

### Changed

- Discovery diagnostics are caller-owned (`diagnosticIntent: normal | quiet`);
  freshness/probe paths use quiet discovery so agent logs stay aggregate-level.
- Managed agent guidance (`opensip init` blocks in AGENTS/CLAUDE) prioritizes
  MCP evidence tools, four facets, declaration/reference separation, and
  reconnect-vs-refresh diagnosis.
- Public graph, MCP, configuration, and CLI dispatch docs document compact
  defaults, audit source roles, and runtime inventory ownership.

### Fixed

- Package SCCs no longer include same-package self edges; architecture counters
  and workspace declaration imports are hardened against hostile keys and
  ambiguous attribution.
- Review follow-ups after the MCP audit rollout (red gates and correctness bugs
  across phases 2–9).
- Root `yagni.sarif` dogfood artifact is no longer tracked; packaging excludes
  tests from production builds.

## [0.5.3] - 2026-07-10

An MCP graph-audit readiness release. Agents can inspect occurrence-precise
call evidence, package boundaries, architecture views, and runtime wiring from
stored catalogs over MCP without re-running analysis; ordinary reads auto-swap
to a newly persisted catalog generation and report complete or partial
freshness. The HTML report overview suite expander keeps step columns aligned
with the table header.

### Added

- Graph public read surface for occurrence call views, package evidence
  (dependencies, why-depends, SCCs), architecture view, filter-first symbol
  search, dead-code paging, and source filters with project-bound cursors.
- MCP tools and projections for bounded, labelled audit evidence: occurrence-
  default walks (`who_calls`, `callees_of`, `trace_path`, blast radius),
  package tools, `get_architecture`, `find_dead_code`, `get_runtime_wiring`,
  and shared paging / identity / freshness envelopes.
- Catalog identity and generation lifecycle: opaque `g1:` generation keys,
  auto-swap on newly persisted external graph catalogs, complete/partial
  freshness without building a graph on ordinary reads; `refresh_graph`
  remains the sole explicit rebuild path (ADR-0148).
- ADRs 0148–0149 (catalog identity / auto-swap / freshness; bounded labelled
  MCP audit evidence).

### Changed

- MCP graph traversal defaults to occurrence-precise identity; body-twin
  reachability is explicit and label-preserving.
- Agent guidance and public MCP docs document the expanded tool inventory,
  freshness fields, and evidence-kind / confidence contracts.
- Dashboard suite steps render as sibling table rows (same columns as the
  overview header) with a darker child-row background.

### Fixed

- Overview Recent Activity: expanded suite child rows no longer indent out of
  alignment with the TIMESTAMP / RUN / … header columns.

## [0.5.2] - 2026-07-09

A modular-monolith boundary hardening release. Public packages fail closed on
raw datastore and host-plane access, external workers lose ambient DB capability,
MCP reads the graph only through `@opensip-cli/graph/read`, and architecture
gates enforce export maps and tool inventory so those boundaries stay true in CI.

### Breaking

- Public `DataStore` no longer exposes `transaction`; raw Drizzle handles, table
  objects, and `DEFAULT_TEST_BASELINE_IDENTITY` are not public barrel exports
  (use repositories; owners use `@opensip-cli/datastore/internal`).
- Fitness no longer exports the test-only `fileCache` value from the public
  barrel (tests use `fitnessTestFileCache` via `@opensip-cli/test-support`).
- Core no longer exports dead `fitnessEmptyCheckRegistryDiagnostic` /
  `fitnessPluginLoadFailedDiagnostic` builders.
- `HostGovernance.listForProject` and `HostAudit.exportForCloud` are removed from
  the tool-facing host-plane surface.
- External tool trust env vars (`OPENSIP_CLI_ALLOW_*_TOOLS`) no longer admit `*`;
  only exact ids are trusted (`cli.trust.tool_wildcard_ignored`).

### Added

- External workers install a denied ambient datastore thunk (`host-rpc-only`);
  privileged effects remain host-RPC only (ADR-0145).
- Host-plane storage identity `@opensip-cli/host-plane:<toolId>` with copy-only
  migration 0009 and dual-identity purge (ADR-0146).
- Public `@opensip-cli/graph/read` facade; MCP production consumes it (ADR-0147).
- Architecture gates: complete depcruise export-path map, manifest-derived Tool
  inventory, fail-closed internal-import owner allowlists, and workspace import-
  surface verification in lint.
- ADRs 0145–0147 (worker datastore capability, host-plane reserved namespace,
  public graph/read + package boundaries).

### Changed

- `applyToolContributeScope` is the single validated installer for every tool
  scope contribution (tests and CLI bootstrap share it).
- ToolCliContext seam inventory is extracted via the TypeScript compiler API;
  Vitest path aliases rebuild from declared package exports only.
- Worker mode resolution for external-tool and capability-pack workers is
  tightened; host-RPC baseline messages are allowlisted.

### Fixed

- HTML report overview ledger: suite and step Run cells show only the tool/suite
  badge (no duplicate suite name or command text beside the badge).
- `@opensip-cli/test-support` covers `parseCliJsonOutcomes` and
  `runTwoScopesConcurrently` so the package meets coverage floors after those
  helpers moved onto the private barrel.

## [0.5.1] - 2026-07-09

A presentation-identity and run-evidence patch. Human duration and score labels
now share one pure package across CLI, report, and host history; MCP run
summaries expose raw `durationMs`; and the host run ledger only suppresses a
delegated supervisor row after proving the child wrote correlated evidence.

### Added

- `@opensip-cli/format` — pure, zero-dependency `formatDuration` / `formatScore`
  and narrow display projectors (`projectDurationDisplay`,
  `projectSessionDisplay`) so CLI, HTML report, and host history cannot drift
  (ADR-0144).
- Host-owned run/run-step ledger for suite and standalone tool runs, with
  delegated-execution markers and child-evidence proof before supervisor-row
  suppression.
- Local fitness check `presentation-labels-via-format` and depcruise
  `format-imports-nothing` leaf rule (with gate-live probe).
- ADR enforcement frontmatter gate (`scripts/verify-adr-enforcement.mjs`) and
  private dogfood pack for opensip-internal architecture checks.

### Changed

- CLI live UI, host session history, suite step tables, and the HTML dashboard
  use `@opensip-cli/format` for duration and score labels (including recipe
  timeouts and check pass-rate text).
- MCP `RunSummary` includes host-stamped `durationMs` for agent semantic
  identity (raw evidence; no human labels on MCP).
- Graph heap re-exec preserves run correlation in the elevated child
  environment.
- Dependency toolchain refresh (Node types pinned to major 24).

### Fixed

- Report overview/ledger recipe columns stay bounded; overview is ledger-first.
- Session history indexes hardened.
- Dogfood fitness findings cleared (yagni ephemeral worker-spec allowlist,
  composition-root fan-out exemptions, public-api JSDoc).
- Cold dogfood gate and external-adapter fixture versioning for CI.

## [0.5.0] - 2026-07-07

A polyglot external-tool and suite-verdict release. This adds the first wave of
external scanner adapters, improves adapter discovery, introduces explicit fault
handling across live and suite output, and tightens stored-session and baseline
evidence so reports and MCP reads stay project-scoped and stable.

### Added

- Thirteen polyglot external scanner adapters (`@opensip-cli/tool-semgrep`,
  `tool-ast-grep`, `tool-ruff`, `tool-golangci-lint`, `tool-govulncheck`,
  `tool-cargo-deny`, `tool-bandit`, `tool-pip-audit`, `tool-cargo-clippy`,
  `tool-spotbugs`, `tool-pmd`, `tool-dependency-check`, `tool-cppcheck`) with
  coverage-gated acceptance suites.
- Adapter-language metadata on tool manifests and `opensip tools list
  --available` discovery (optional `--lang` filter).
- Unified suite/single-run result summaries with explicit fault verdicts and
  attention bullets in live output.
- Suite live view: one banner, headless step execution, compact aggregate
  checklist, and no double output across multi-step runs.

### Changed

- Suite `failOnFault` handling treats envelope-backed faults as non-blocking by
  default while still surfacing them clearly in results.
- Suite live output now renders through the standard five-section done-body
  contract (consistent with single-tool runs).
- Root `pnpm` shortcuts now cover the current top-level CLI command surface,
  including suite, tools, config, policy, repair, and agent-catalog commands.

### Fixed

- `fit --changed` (and suite audit's changed-scope fitness step) now applies the
  same target exclusions as a full `fit` run — no more false errors on test
  files or whole-repo invariant checks when nothing relevant changed.
- Dogfood gate cleared: all fit, graph, and yagni findings resolved (52
  warnings → 0).
- MCP latest-session reads are scoped to the project root.
- Baseline fingerprints disambiguate colliding occurrences with ordinals.
- Graph owner edges key by full occurrence identity.
- Dashboard recent activity groups suite runs as expandable rows and keeps
  pagination/sorting attached to the grouped evidence.
- Three bug-audit cycles harden SARIF, datastore, graph-impact, sessions, and
  suite orchestration paths.

## [0.4.2] - 2026-07-06

A small external-tool and CI-output patch. External adapter runs now render
consistently in the terminal and HTML report, and the compatibility matrix
script no longer writes report artifacts unless explicitly requested.

### Changed

- Compatibility matrix report output is opt-in instead of emitted by default.

### Fixed

- External tool scan/emit and dashboard overview tab align with the shared CLI
  rendering path so terminal and report views stay consistent.

## [0.4.1] - 2026-07-06

A session-provenance and report-polish patch. Stored runs now record which CLI
and engine versions produced them, HTML reports link those versions and hide
rows that do not apply, and the datastore migration chain is repaired for
`db:generate`.

### Added

- Session rows record CLI and per-tool engine version provenance on each run.

### Changed

- HTML report details link CLI release versions; the header shows the version as
  plain text.
- CI dependency and GitHub Action bumps (attest, upload-artifact, patch/minor
  npm group).

### Fixed

- Dashboard omits Engine/Baseline rows when they do not apply to a tool tab.
- Drizzle snapshot chain repaired so `db:generate` works again.
- Language-adapters doc no longer references the deleted `generic-types.ts`
  source file.
- Prettier `format:check` excludes generated report artifacts.

## [0.4.0] - 2026-07-06

An architecture-remediation and agent-workflow release. It hardens the layered
kernel after the July 2026 audit, makes the built-in audit suite changed-scope
by default, and tightens suite dispatch, MCP session reads, and gate verdict
fidelity across tools.

### Added

- Built-in `audit` suite runs changed-scope by default when git resolves,
  exposes `--full` for whole-repo scans, and stamps the resolved scope on suite
  results (ADR-0129).
- MCP session review helpers and repo-scoped reads so result tools serve only
  sessions recorded under the server's project root (ADR-0130).
- Shared suite step dispatch pipeline with worst-of exit capture and JSON
  outcome exit parity (ADR-0131, ADR-0132).
- Drizzle migration drift verification and activated vitest coverage-threshold
  enforcement in release preflight.

### Changed

- July 2026 architecture audit remediation: deleted the core language-query
  surface, removed unbound live and YAGNI glue, re-chartered contracts, and made
  dashboard tool tabs explicit (ADR-0105).
- Per-run scope now owns retention and profiler state instead of leaking across
  invocations.
- Suite steps share one host dispatch path; YAGNI verdict outcome persists and
  no longer clobbers gate results.

### Fixed

- Fitness check signals preserve fidelity; the wire provider stays byte-stable at
  `opensip-cli`.
- Graph suppresses per-unit egress on `--workspace` children.
- CLI outcome exits align with delivery; suite step errors are isolated in
  capture.
- Agent catalog parity validation and tool seam enforcement widened in config.
- Dogfood warning regressions cleaned after surface deletion.

### Breaking

- The core language-query surface is removed; consumers must use language
  adapters through the supported registry paths instead.

## [0.3.1] - 2026-07-03

An init scaffold reliability release. Freshly initialized projects can now run
both generated example loops immediately, and the public docs describe the
project-local plugin and repeat-init behavior consistently.

### Changed

- Public init, sim, and project-local plugin docs now describe managed agent
  guidance updates, summarized repeat-init output, and the generated example
  recipe workflow.

### Fixed

- Scaffolded fit checks no longer import `@opensip-cli/fitness`, so
  `opensip fit --recipe example` works out of the box after `opensip init`.
- Init e2e coverage now verifies both generated fit and sim example recipes.

## [0.3.0] - 2026-07-02

An agent-workflow and release-hardening release. It adds first-party review,
repair, impact, audit-suite, and GitHub Action surfaces; strengthens extension
trust and isolated capability loading; and makes releases more verifiable with
compatibility, quality, performance, and artifact checks.

### Added

- Review-result MCP tools, review-brief correlation, impact-analysis trust
  foundations, and a safe repair preview/apply/verify loop for agent-assisted
  changes.
- Built-in audit suite presets, no-init first-run support, and the OSS GitHub
  Action for repository CI adoption.
- Target framework conventions and a host-owned analysis run pipeline for more
  consistent tool execution.
- Detection-quality measurement, performance SLO benchmarking, public benchmark
  docs, compatibility/LTS policy, and verifiable release artifacts.
- Trust policy and evidence-authority egress contracts for extension and
  downstream evidence workflows.

### Changed

- External capability resources now load through isolated bridge paths with
  shared core helpers instead of duplicated per-tool loaders.
- The product documentation now centers the agent workflow wedge and refreshes
  generated package and web docs for v0.3.0.

### Fixed

- Dogfood `graph`, `yagni`, and `fit` runs are clean after consolidating
  duplicate bridge helpers, removing SARIF traversal recursion from the graph
  call graph, and simplifying a wide `tools list` helper.
- Local workspace package injection refreshes automatically before dogfood runs
  when needed, and stays silent when the injected packages already match source.

## [0.2.4] - 2026-07-01

An init UX and onboarding release. Repeat-init diagnostics summarize
pre-existing files by count instead of listing paths, and the scaffolded
sim example runs immediately after `opensip init` without extra plugin
dependencies.

### Changed

- Init success and partial-state views report how many files were preserved
  under `opensip-cli/` instead of printing a capped per-file preview.
- Scaffolded sim scenario and recipe use plain objects so
  `opensip sim --recipe example` works out of the box after init.

### Fixed

- Core package coverage stays above the 95% statement threshold used in
  release preflight.

## [0.2.3] - 2026-07-01

A config-discovery simplification release. Project config resolves from
`--config` or the root `opensip-cli.config.yml` only — the
`package.json#opensip-cli.configPath` indirection is removed so init and
runtime discovery stay aligned.

### Changed

- Config resolution drops `package.json#opensip-cli.configPath`; the canonical
  path is `<project-root>/opensip-cli.config.yml` unless `--config` overrides.
- `opensip init` and related docs now describe root-only config discovery.

### Fixed

- Init and bootstrap paths no longer diverge on where project config is found.

## [0.2.2] - 2026-07-01

An `opensip init` hardening release. File classification skips generated
dependency and build-output directories, and the init view caps long
pre-existing-file previews so repeat-init diagnostics stay readable on large
projects.

### Fixed

- Init file classification no longer walks `node_modules`, `dist`, `coverage`,
  or `.turbo` under `opensip-cli/`; symlink entries are handled safely via
  `lstat`.
- Partial-state and success init views cap pre-existing file listings at 40
  entries with a trailing overflow hint.

## [0.2.1] - 2026-07-01

An MCP-first agent-guidance release. Repeat `opensip init` now refreshes
managed OpenSIP guidance in known agent-instruction files and updates the
project `.gitignore`, without rewriting config or examples unless `--keep` or
`--remove` is explicit.

### Added

- MCP-first agent guidance refresh on repeat `opensip init`, including managed
  `AGENTS.md` / `CLAUDE.md` blocks and ADR-0109.
- `mcp-first-agent-guidance` and `mcp-results-no-rerun` fitness checks that
  enforce MCP-first routing in agent instruction files.

### Changed

- `opensip init` documentation and agent guides now describe the refresh
  behavior for existing projects.
- MCP client setup guide updated for the merged guidance refresh flow.

## [0.2.0] - 2026-07-01

An architecture-audit remediation and agent-ergonomics release. It hardens
host-owned guardrails across fit, graph, sim, and yagni; centralizes shared
JSON filter emission and validated-cell formatting; and documents MCP client
setup for Cursor, Claude Code, and Codex.

### Added

- Architecture audit P1 remediation (phases 0–7), including ADRs 0105–0108 for
  host run-pipeline deferral, primary-run presets, shared gate dispatch, and
  signal-repair routing.
- YAGNI session replay for dashboard history and agent consumption.
- MCP client setup guide for Cursor, Claude Code, and Codex.
- `graph --report-open` flag to open the HTML report after a run.
- `defineTool` scaffolding templates for third-party tool authors.
- Shared `emitAgentFilteredJsonOutput` in contracts so fit/graph/sim/yagni JSON
  filter dispatch cannot drift.
- Shared validated-cell formatting in cli-ui for live-run and fitness tables.

### Changed

- Primary run commands now enforce declarative presets; raw-stream command shells
  and baseline status writers are standardized across tools.
- Host gate dispatch is shared across tools instead of reimplemented per engine.
- Fitness authoring guardrails are strengthened, including unique check-id
  enforcement and preset-aware flag/report/raw-stream guards.
- Agent catalog avoids JSON examples for raw-stream commands; suite command is
  documented in the README.
- Report environment details move into header disclosure instead of a separate
  block.
- Near-duplicate function bodies flagged by graph are consolidated into shared
  helpers.

### Fixed

- P1-remediation review regressions, including fit run-pipeline boundary guards,
  cli-live semantic alias allowance, and yagni JSON filter/detector alignment.
- Graph async-waterfall in the run command tail.
- CLI hygiene guardrail cleanup and owning-tool resolution from command paths.
- YAGNI `defineDetector` throw contract is documented.

## [0.1.19] - 2026-07-01

A release-bookkeeping maintenance release. It advances the published package
set and generated documentation surfaces after v0.1.18, without introducing
new runtime behavior.

### Changed

- Package versions, public documentation release markers, generated package
  README links, and website documentation links now point at v0.1.19.
- The supported-release metadata now tracks v0.1.19 as the currently supported
  release line.

## [0.1.18] - 2026-06-30

A hidden-state, deterministic-gate, precision, and duplicate-signal hardening
release. It makes host-owned datastore/session lifecycle explicit, stamps
declared-input provenance onto emitted gate artifacts, moves duplicate finding
collapse into the CLI host output plane, and documents the resulting
retention, verdict-diagnosis, and precision-heatmap model for operators and
agents.

### Added

- ADR-0096, defining host-owned datastore lifecycle and session-retention
  ownership boundaries.
- ADR-0097, defining the allowlisted `declaredInputs` manifest for gate verdict
  determinism.
- ADR-0098, defining host-owned signal deduplication and suppression-catalog
  precision heatmaps.
- `cli.sessions` retention configuration for count, age, and SQLite size bounds.
- Host-owned session pruning and datastore reclaim primitives, with tests for
  count pruning, size reclaim, and non-fatal maintenance failures.
- Host-side signal normalization for `SignalEnvelope` output before JSON,
  terminal rendering, SARIF, cloud, report, and session delivery.
- Focused regression coverage for exact and near-identity signal collapse,
  envelope routing, and chunked bulk-insert analysis.

### Changed

- JSON outcomes, SARIF/cloud delivery, dashboard/report composition, and session
  persistence now receive host-stamped declared-input metadata.
- `fit` architecture checks now reject tool-owned session timing, retention, and
  SQLite reclaim ownership.
- Session cleanup now runs as best-effort host maintenance after successful
  session writes without changing tool verdicts or exit codes.
- Output/schema docs now describe the host-normalized envelope contract,
  including dedup identity order and the guarantee that `verdict.passed`
  remains tool-owned.
- Suppression catalog generation and triage docs now carry an explicit
  `false-positive`, `accepted-risk`, and `design-mismatch` taxonomy.
- The chunked bulk-insert check now understands formatted `.map(...)` windows
  and bounded map sources.

### Fixed

- Gate outputs are easier to compare across runs because CLI, Node, package
  manager, platform, tool, and baseline identity are captured in a compact
  manifest instead of being inferred from ambient host state.
- Project-local SQLite/session history growth is bounded by a documented default
  host policy instead of relying on manual cleanup.
- Duplicate findings from the same provider/source/rule/location/message are
  collapsed once at the host output boundary instead of leaking through every
  output sink.
- Silent early-return checks now skip explicit boolean-return contracts where
  `return false` is the expected result.
- Several implementation paths now avoid unnecessary suppressed findings called
  out by the refreshed precision heatmap.

## [0.1.17] - 2026-06-30

A customer-extension trust and startup diagnostics release. It keeps ambient
extension discovery deny-by-default, but makes explicit user actions such as
configuring a capability pack or installing/creating a tool count as trust
decisions. It also adds startup phase timing substrate and clearer degraded-load
diagnostics so slow or partially degraded startup paths are easier to attribute.

### Added

- Trust config support for explicit tool and capability-pack trust decisions.
- Startup timing instrumentation for pre-action/bootstrap phases.
- Tools command result metadata for trust-aware install/list/create flows.
- Planning updates for spec 23, low-friction customer extension trust.

### Changed

- `opensip tools install`, `tools create`, `tools list`, and `tools uninstall`
  now surface and preserve trust posture more directly.
- Configured capability packs and authored tools use explicit trust decisions
  instead of relying on hidden environment-variable allowlists.
- Public extension and tools documentation now describes the lower-friction trust
  flow for customer-owned tools and packs.

### Fixed

- Optional check-pack load failures no longer collapse useful diagnostics into
  misleading `"unknown"` or raw-cause package names.
- `fit` continues to fail closed for degraded required loads while preserving
  clearer optional-load warning text.
- `tools create` now bounds `opensip-cli.config.yml` edits and keeps
  `tools.trusted` updates compatible with the dogfood quality gates.

## [0.1.16] - 2026-06-29

A small diagnostics, live-run, and product-framing release. It tightens `fit`
startup failure handling, moves the YAGNI live audit path onto the same
worker-backed progress model as the other heavier tools, and publishes the
OpenSIP CLI/OpenSIP platform evidence-authority and identity decisions. It also
clarifies the no-project startup hint before the next npm publish.

### Added

- ADR-0094, documenting CLI-to-Cloud evidence authority, repository identity, and
  fidelity-preserving egress expectations.
- ADR-0095 and a canonical public guide explaining the relationship between
  OpenSIP CLI and the broader OpenSIP platform, including updated agent scaffold
  copy.
- A local planning snapshot for startup observability and load diagnostics.

### Changed

- `opensip yagni` live runs now execute through an internal worker command while
  streaming per-detector progress events back to the live UI.
- The no-project startup message now tells users to change into their project
  directory before running `opensip init`.

### Fixed

- `fit` now fails closed when required plugins or configured check packages fail
  to load, and it redacts absolute module paths from load-error diagnostics.
- Capability-pack loading now tolerates project-local package manifests that omit
  optional fields used by generated command-surface metadata.

## [0.1.15] - 2026-06-29

An external-scanner integration release. OpenSIP CLI can now wrap a
user-installed CLI scanner — Gitleaks, OSV-Scanner, or Trivy — as a first-class
Tool: it runs the scanner as a subprocess, normalizes its native output to the
platform `Signal` currency, and feeds the same session store, baseline ratchet,
SARIF/cloud egress, and HTML report as the built-in tools. The adapters are
**opt-in and not bundled** — install the one you want, then trust it. The changes
are additive: no built-in command or output shape changes, and the new artifact
store and config field default to safe values.

### Added

- `@opensip-cli/external-tool-adapter` — a new layer-3 substrate that turns a
  local scanner into an OpenSIP Tool from a descriptor plus a parser
  (`defineExternalToolAdapter(spec)`). It owns binary resolution (config/env →
  `PATH`, never a fetch), the run loop, the shared SARIF/JSON ingest, secret
  redaction, provenance, and the auto-added `doctor`/`version` commands
  ([ADR-0090](docs/decisions/ADR-0090-external-tool-adapter-substrate.md)).
- Three opt-in adapter packages (not bundled): `@opensip-cli/tool-gitleaks`
  (`opensip gitleaks` — committed-secret scanning), `@opensip-cli/tool-osv-scanner`
  (`opensip osv-scanner` — dependency vulnerabilities), and
  `@opensip-cli/tool-trivy` (`opensip trivy` — vulnerabilities + misconfigurations).
  Each adds a primary scan command plus `doctor` (binary/version/posture/ready,
  exit 0 ready / 2 not-ready) and `version`. Adapters are deny-by-default: after
  `opensip tools install`, trust one via
  `OPENSIP_CLI_ALLOW_INSTALLED_TOOLS=<id>`.
- A shared SARIF ingest (`ingestSarif`) that recovers four-bucket severity from
  the SARIF rule descriptor's `security-severity` (CVSS) before the lossy `level`
  fallback; the JSON adapters ship per-scanner parsers
  ([ADR-0091](docs/decisions/ADR-0091-external-scanner-finding-ingestion.md)).
- A host-owned raw-artifact store at `.runtime/artifacts/<tool>/<runId>/`
  (gitignored, `0600`, never egressed), extending the ADR-0080 `writeArtifact`
  seam with `ProjectPaths.artifactsDir`/`artifactDir(tool)`, mode-`0600` writes,
  and host-side retention governed by the new `cli.artifacts.keep` config field
  (default 10; `0` disables pruning).
- `--gate-save` / `--gate-compare` parity for adapters: scanner findings inherit
  the host-owned baseline ratchet (ADR-0036) verbatim via worker-side
  `message-hash` fingerprints, the same as `fit` and `graph`.
- A `network` posture declaration (`local-only` / `networked` / `auth-required`)
  surfaced by `doctor` and forward-mapped to the capability manifest's `requires`
  (`subprocess` + `filesystem` always; `network` only when networked/auth) —
  declaration-only in v1
  ([ADR-0092](docs/decisions/ADR-0092-external-adapter-network-auth-trust.md)).
- An authoring guide ([External tool adapters](docs/public/50-extend/08-external-tool-adapters.md))
  and a CLI reference section for the opt-in adapter flow.

### Security

- Secret-scanner findings are redacted before they leave the parser: only a short
  non-reversible preview (or hash) of a matched credential reaches a `Signal`; the
  raw value is never placed in `Signal.message`, `Signal.metadata`, or any egress
  payload. Raw scanner reports persist `0600` in the gitignored artifact store and
  are never egressed — only normalized `Signal`s leave the process (ADR-0091/0092).

## [0.1.14] - 2026-06-28

An agent-ergonomics and Cloud handoff release. Coding agents now have a
structured discovery surface, filtered and raw JSON inspection paths, changed-file
targeting, and graph impact analysis for edit loops. The CLI also ships the
OpenSIP Cloud SARIF handoff path and a published GitHub Action for turning local
`fit` findings into cloud tickets. The changes are backward-compatible:
human-readable output remains stable, agent filters are presentation-only, and
upload failures do not alter local findings.

### Added

- `opensip suite run/list/add` host-owned tool suites, with UUID-addressed suite
  config, shared option assembly, suite session grouping, and dashboard/history
  suite visibility.
- `opensip agent-catalog --json` — a structured discovery surface for agents,
  covering common command loops, output shapes, sessions, filters, and graph
  impact usage.
- Agent-oriented run controls across `fit`, `graph`, and `sim`: repeatable
  `--filter`, `--top`, and `--raw` JSON output, plus session `--summary-only` and
  raw replay paths for token-sensitive historical-result inspection.
- Changed-file targeting for agent edit loops: `fit --changed`, `--since`, and
  `--include-impacted`, backed by a shared git-change resolver and graph impact
  expansion.
- `opensip graph impact` — changed-to-impacted analysis over the persisted graph
  catalog, with `--changed`, `--since`, `--files`, `--top`, JSON output, and
  recommended follow-up commands.
- `opensip init` now writes an `AGENTS.md` playbook when absent, giving coding
  agents the recommended Discover / Edit / Final command loop for the project.
- Structured `signal.repair` metadata for agent-readable repair guidance.
- A published `opensip-ai/opensip-cli@v0` GitHub Action and cloud handoff guide
  for running `opensip fit --report-to` in CI.

### Changed

- `--report-to` Cloud handoff now posts SARIF with `Authorization: Bearer` and an
  `x-opensip-repo` header derived from the git `origin` remote, so Cloud can scope
  stored signals to the right repository before ticket reconciliation.
- Agent filters apply only to presentation surfaces (`--json` and session replay);
  gates, session persistence, and egress continue to use the unfiltered envelope.
- Agent recipes (`agent-fast`, `agent-risk`, `agent-final`) are documented as the
  recommended fast loop, risk loop, and final verification loop for first-party
  tools.

### Fixed

- Corrected changed-file and graph-impact edge cases that could break agent
  round-trips, including path handling, impact computation, and persisted session
  signal replay.
- Distinguished `401` and `403` failures on `--report-to` uploads so operators
  can tell invalid API keys from keys that lack `ingest:write`.
- Fixed OpenSIP Cloud authentication headers for `osk_` keys, including the
  entitlement probe, to use Bearer auth instead of `X-API-Key`.

## [0.1.13] - 2026-06-26

A worker-supervision and external-tool trust hardening release. External tool
execution now has clearer trust framing, tighter child environment inheritance,
trace propagation across fork boundaries, bounded worker resources, and shared
supervisor behavior across external dispatch and bundled live-engine workers.
All changes are backward-compatible; the new limits use conservative defaults
and are tunable through documented `OPENSIP_CLI_WORKER_*` environment variables.

### Changed

- External-tool dispatch worker child environment is now filtered to an explicit
  allow-list (`PATH`, `HOME`, `TMPDIR`, `OTEL_*`, etc.) instead of inheriting the
  full parent `process.env`. Use `OPENSIP_CLI_TOOL_ENV_PASSTHROUGH=VAR1,VAR2` when
  a specific tool needs additional parent vars (e.g. `HTTP_PROXY`).
- Wildcard `*` trust allowlists (`OPENSIP_CLI_ALLOW_PROJECT_TOOLS`,
  `OPENSIP_CLI_ALLOW_INSTALLED_TOOLS`) now emit a per-invocation deprecation
  warning with an explicit full-privilege caveat. Admission behavior is unchanged.
- Forked worker child stderr is now captured in a size-capped buffer by default
  (truncated tail surfaces on worker fault). Set `OPENSIP_CLI_WORKER_STDERR_INHERIT=1`
  to restore inherited stderr for debugging.
- Child-tree kill on settle/timeout/limit: POSIX process-group kill; Windows
  `taskkill /T /F`. Prevents forked grandchildren from leaking after supervisor settle.

### Added

- `TRACEPARENT` propagation into external-tool dispatch workers and bundled
  live-run worker forks for full child-process span-nesting parity with graph shard
  workers.
- Worker resource ceilings for forked dispatch and live-engine subprocess paths:
  IPC payload cap, captured-output cap, child memory limit (`--max-old-space-size` +
  RSS watchdog), host-RPC backpressure, heartbeat/liveness, and Ctrl-C cancellation.
  Configurable via `OPENSIP_CLI_WORKER_*` env vars (see dispatch implementation docs).
- Shared `forkAndSettle` primitive in `@opensip-cli/core` backing both the external
  dispatch supervisor and bundled live-engine subprocess transport.
- `failureClass` and truncated child `stderrTail` persisted on supervisor-side
  `ToolError` instances for operator triage.

## [0.1.12] - 2026-06-24

A graph-focused release, with report and YAGNI polish. It adds near-duplicate
(copy-paste-with-edits) function detection and a structured equivalence diagnostic,
hardens sharded≡exact graph equivalence and cross-language call resolution, and
refreshes the HTML report and the `yagni` live view. All changes are
backward-compatible; the new catalog signature field and rule are additive.

### Added

- `graph:near-duplicate-function-body` — a new advisory (warning-level) graph rule
  that flags clusters of near-clone function bodies (copy-paste-with-edits), the
  more common tech-debt signal that the exact `graph:duplicated-function-body`
  misses. It uses a per-function MinHash signature computed at graph-build time and
  LSH banding for O(n) candidate generation. Clusters are same-language and exclude
  exact-hash twins (which the exact rule already owns). Tunable via the new
  `graph.minNearDuplicateSimilarity`, `graph.minNearDuplicateBodySize`, and
  `graph.nearDuplicateLshBands` config keys.
- `GRAPH_EQUIV_DIAG` — point this environment variable at a file path to have
  `graph-equivalence-check` write a structured JSON diagnostic of every production
  decline/phantom divergence (owning occurrence, resolved targets, and the call
  edge as seen by both engines), making equivalence regressions debuggable in
  minutes.

### Changed

- Near-duplicate MinHash signatures are computed ~66× faster — each body shingle
  is hashed once and the signature values are derived with cheap mixers, instead of
  hashing every shingle k times — so cold graph builds stay fast despite the new
  per-function signature.
- `opensip yagni`'s live view now shows each detector as its own checklist row with
  live timing (matching the `graph` staged view), instead of a single aggregate
  "Running detectors…" spinner.
- The HTML report uses the OpenSIP coffee-cup mark, is titled "OpenSIP Report", and
  supports URL-hash deep links (e.g. `#code-paths/coupling`) so a specific tab/view
  can be shared or reopened directly.

### Fixed

- Restored byte-equivalence between the sharded and exact graph build engines for
  cross-package edges. The sharded engine now recovers cross-package method-call
  edges (by decoding pnpm-injected `dist/*.d.ts` paths back to workspace source) and
  re-export edges (by following relative-import barrels), which previously resolved
  only in the single-program exact engine — driving the equivalence gate's
  production divergences to zero.
- Tree-sitter call resolution (Go, Java, Python, Rust) now matches names within the
  same language only, so on the single-program build a call no longer falsely
  resolves to a same-named function in another language.

## [0.1.11] - 2026-06-23

A polish and hardening patch over 0.1.10. It unifies live-run terminal
rendering across tools, improves the YAGNI dashboard/reporting surface, and
tightens graph and release guardrails.

### Added

- Dashboard report support for the YAGNI tab, with the detectors view aligned to
  the graph catalog table.
- A per-file source-size guard for graph adapter parse reads, preventing
  unbounded-memory reads during graph analysis.

### Changed

- Consolidated live-run terminal rendering around `@opensip-cli/cli-live` and
  `@opensip-cli/cli-ui`, including one terminal-table renderer, consistent run
  banners, preserved shared progress, and rounded sub-second summary durations.
- Tightened the `detached-promises` check: same-file sync helper detection,
  expanded sync-call allowlists, and removal of 33 stale line-level waivers
  (budget 52 → 19).
- Tightened the `result-pattern-consistency` check: registration guards,
  fluent-builder preconditions, exhaustiveness probes, and expanded
  infrastructure-path detection; removed 27 stale waivers.
- Tightened the `error-handling-quality` check: disambiguate `Result.match`
  from `String.match`, probe-function contracts, and composition-root path
  allowances; removed 52 stale waivers (budget 54 → 2).
- Tightened the `toctou-race-condition` check: `this` Map field aliases,
  enclosing-scope locals, parse-cache receiver chains, and expanded safe paths;
  removed 14 stale waivers (budget 14 → 0).
- Tightened the `async-waterfall-detection` check: backoff/yield recognition,
  setup-then-run orchestration, and collect-then-count scan pairs; removed 6
  stale waivers.
- Phase 3 suppression reduction: `duplicate-utility-functions` excludes
  `packages/languages/lang-*` (ADR-0010); `isCheckAuthoringSource` skips
  check-pack paths for `performance-anti-patterns`, `batch-operation-limits`,
  and `unbounded-memory`; `module-coupling-fan-out` auto-exempts scope-augmentation
  barrels and documents a permanent floor of 4.
- Phase 4 residual audit: suppression catalog now records Phase 0 baseline
  deltas, SC6 status, and reopen-triage candidates; `pnpm gate:waiver-ratio`
  prints the summary in CI logs.
- Tightened the `throws-documentation` check: enclosing-factory `@throws`,
  object-property JSDoc, never-propagates try/catch, and instanceof-guarded
  rethrow heuristics; removed 9 product-runtime waivers.
- Tightened the `detached-promises` check: enclosing-scope sync helpers, OTel
  span methods, and tool-CLI/composition-root path allowances; removed 19
  product-runtime file-level waivers (budget 19 → 0).
- Tightened the `performance-anti-patterns` check: retry/settle detection,
  Promise.all/race batching, and intentional serial plugin/adapter/glob loops;
  removed 15 product-runtime waivers (budget 38 → 0).
- Tightened the `null-safety` check: schema-builder chains, `*For()` factory
  calls, Commander `optsWithGlobals`, and callback-index guards; removed 9
  product-runtime waivers.

### Fixed

- Suppressed the misleading graph "no adapter" warning during YAGNI auto-mode
  evidence collection.
- Fixed dashboard session-detail rendering for YAGNI report data.
- Hardened release/CI checks by verifying injected workspace copies include
  their entry point and by using the nested `fit baseline export` path.

## [0.1.10] - 2026-06-22

A maintenance patch over 0.1.9 (all of 0.1.9's changes are included below). It
adds the bundled advisory YAGNI reduction audit, a graph-dogfood cleanup, and
release-gate hardening.

### Added

- **`opensip yagni`** — bundled advisory YAGNI reduction audit
  (`@opensip-cli/yagni`). MVP detectors: `unused-config-surface`,
  `duplicate-body-candidate` (graph `bodyHash` evidence). Findings carry
  `metadata.yagni` (confidence, preservation argument, validation steps).
  Advisory defaults (`failOnErrors: 0`).
- **`yagni-ignore-hygiene`** fitness check for `@yagni-ignore-*` directive
  quality.
- Public docs: `docs/public/55-yagni/`, ADR-0057, configuration and CLI
  reference updates across README and `docs/public/`.

### Fixed

- Collapsed the worker fork-supervisor's `forkAndAwait` into an options object,
  clearing the `graph:wide-function` self-analysis warning.
- Hardened the release lane against latent CI breakage: the supply-chain check no
  longer flags a token used solely for the OIDC-uncovered `npm dist-tag` promotion;
  bundled tool-command manifests are deterministic (no machine-specific path baked
  into a flag default); and CLI branch coverage is stable above its threshold
  (a profiling test no longer drives the real inspector profiler in-process).

## [0.1.9] - 2026-06-22

A platform-hardening release: external tools now run inside a process-isolation
boundary, third-party tools reach parity with the bundled ones, and the graph and
language layers become layout- and language-agnostic.

### Changed

- **External tools now run out-of-process behind a fault-isolation boundary
  (ADR-0054).** Installed, project-local, and user-global tools execute in an
  isolated worker process — their command handlers, config validation, and
  lifecycle hooks no longer run in the CLI host, so a crash, `process.exit`, hang,
  or native fault in an external tool can no longer take down the CLI. The host
  loads external tools from their static manifest only and never imports their
  runtime; privileged effects (rendering, output, datastore, egress, SARIF,
  baselines) cross a structured IPC boundary back to the host. Bundled `fit`/`sim`/
  `graph` keep in-process execution as the trusted computing base.
- External tool config is validated in two passes: a coarse, manifest-declared
  structural check in the host (no untrusted schema code runs host-side), then the
  tool's own schema inside the worker.
- Third-party tools gained session/persistence parity — their runs save, list, and
  replay through the same machinery as the bundled tools (`sessions list --tool
  <id>` accepts any registered tool id).
- Graph cross-package resolution is now layout-agnostic: package attribution
  derives from each file's nearest `package.json`, so coupling and cross-package
  edges resolve correctly on any repository layout, not only `packages/<name>/`.
- The cross-language query layer is unified — the Rust, Python, Go, and Java
  tree-sitter adapters now implement the same `LanguageQueryAPI` as the TypeScript
  adapter.
- `graph index` gained `--build` (refresh the catalog before emitting the symbol
  index), alongside tool-command taxonomy refinements.
- Tool/host seam-discipline checks now ship in the fitness pack, so a tool author's
  own `fit` run enforces the command-handler output contract.

### Fixed

- The staged-release promotion step now authenticates correctly (`npm dist-tag` is
  not covered by OIDC trusted publishing), and the supply-chain policy check no
  longer flags a token used solely for that promotion.
- The lockfile now records the `@opensip-cli/tree-sitter` → `@opensip-cli/core`
  dependency, so a clean `--frozen-lockfile` install (as CI runs) succeeds.
- Resolved graph dogfood warnings and stabilized a flaky coverage measurement in
  the CLI profiling-telemetry tests.

### Changed

- Added a staged release publish lane with version-scoped candidate dist-tags,
  full-surface verification, and atomic promotion to `latest`.
- Made TypeScript null-safety analysis type-aware by default and shared the
  per-run TypeScript Program across checks to reduce repeated compiler work.
- Added simulation scenario and recipe catalog data to dashboard reports so
  `sim` contributions appear alongside other first-party tool data.
- Authored the dashboard report's client JavaScript as type-checked, bundled
  TypeScript modules (previously inlined template-literal strings invisible to
  the type checker and linter); behaviour is unchanged.
- `fit` verbose output now reports check counts — total available, disabled, and
  running — in its live progress display.
- Single-sourced the `cli:` config block from its Zod schema and expanded
  release/lint guardrails, including knip in the standard lint lane.
- Updated the curl installer output to use `==>` progress lines and a final
  success message.

### Fixed

- Closed audit findings around HTTPS egress policy, installed npm tool trust,
  plugin disablement, and datastore schema-stamp safety.
- Hardened SQLite lifecycle behavior with explicit close handling,
  `busy_timeout`, WAL checkpointing, and squash-safe migration stamping.
- Contained language grammar-load failures so one bad `.wasm` file no longer
  crashes the CLI.
- Removed always-pass simulation assertion helpers and clarified chaos timing
  units.
- Tightened telemetry endpoint warnings and bounded command-duration labels so
  observability output stays useful without high-cardinality metrics.
- Batched session listing to remove the N+1 query pattern in session history.

## [0.1.7] - 2026-06-18

A launch-prep release focused on simplifying the public command surface,
hardening release packaging, and making run output consistent across tools.

### Changed

- Moved extension-pack management under each pack-supporting tool:
  `opensip fit plugin ...` and `opensip sim plugin ...` replace the retired
  top-level `opensip plugin` group. Whole-tool plugins remain under
  `opensip tools ...`.
- Completed the canonical nested tool-command surface and removed the legacy
  flat-root aliases (`fit-list`, `fit-recipes`, `fit-baseline-export`,
  `graph-recipes`, `graph-lookup`, `graph-symbol-index`,
  `graph-baseline-export`, `sarif-export`, and `catalog-export`). Use the
  nested forms such as `fit list`, `fit recipes`, `fit export`,
  `graph recipes`, `graph lookup`, `graph index`, and `graph export`.
- Added a uniform primary-tool flag surface: `fit`, `graph`, and `sim` now carry
  the shared baseline flags plus a per-tool `--version`.
- Added discoverability commands for `graph list` and `sim recipes`.
- Centralized run rendering policy so default fresh `fit`, `graph`, and `sim`
  runs stay compact, while `--verbose` and replay/detail surfaces keep detailed
  tables.

### Fixed

- Ensured the release package order includes runtime workspace dependencies so
  tag-driven publishes do not omit required packages.
- Hardened subprocess correlation and graph shard diagnostics so worker logs,
  spans, and failure milestones retain run context.
- Moved fitness file caching onto per-run scope state to avoid cross-run cache
  contamination under concurrent execution.
- Cleared the current fit/graph dogfood findings ahead of the release.

## [0.1.6] - 2026-06-18

A maintenance release focused on closing unwired command-surface gaps and
cleaning release guardrails. No intended breaking CLI behavior changes.

### Changed

- Made `CommandSpec.scope` the runtime source of truth for the no-project
  bootstrap guard across top-level host commands, grouped host leaves, and Tool
  command specs.
- Aligned the knip guardrail with recursive project-local fitness check
  discovery and the path-spawned `tools validate` runtime probe entry.

### Fixed

- Restored documented no-project behavior for `agent-catalog`, `tools list`,
  `tools validate`, and global-default `tools install`, while keeping
  project-scoped commands such as `sessions list`, `report`, and
  `tools data-purge` fail-closed before handler dispatch.
- Removed stale schedule-config wording from the vocabulary docs so scheduling
  remains documented only as a strict-rejected roadmap field.

## [0.1.5] - 2026-06-17

A maintenance release focused on architecture-review follow-through and release
gate hygiene. No intended breaking CLI behavior changes.

### Changed

- Centralized host-reserved gate config keys so tool namespaces accept
  `failOnErrors`, `failOnWarnings`, and boolean `failOnDegraded` consistently
  while host config blocks remain strict.
- Split graph workspace and multi-path orchestration out of the main graph
  command handler while preserving finalized-signal delivery boundaries.
- Moved CLI profiling state onto per-run scope telemetry instead of module-level
  run state.

### Fixed

- Corrected the documented `failOnDegraded` config value from numeric `0` to
  boolean `false`, and added schema coverage so invalid numeric values are
  rejected.
- Hardened scoped config loading so graph, fitness targets/signalers, and
  simulation no longer re-read YAML behind an active run scope.
- Added structural `CommandSpec` validation to plugin admission and cleaned the
  resulting dogfood `fit` findings.

## [0.1.4] - 2026-06-16

A focused maintenance release for installer feedback and graph-rule runtime
hardening. No public API changes.

### Changed

- The curl installer now shows TTY progress animations while npm install and
  install smoke checks are running, while preserving quiet static output for
  non-interactive logs.

### Fixed

- Hardened graph rule evaluation hot paths by avoiding an O(N²)
  always-throws-branch lookup and tightening BFS loops in graph orchestration.

## [0.1.3] - 2026-06-16

A platform-hardening maintenance release focused on release-readiness and the
bootstrap/graph reliability work identified in the architecture review. No
intended user-facing CLI behavior changes.

### Changed

- Extracted the CLI pre-action bootstrap flow into an explicit planner and
  post-bailout executor, with table-driven phase-order tests for bailout
  safety.
- Split bundled-tool registration/discovery/mounting into smaller composition
  modules while preserving the shared tool-admission path.
- Moved sharded graph live builds through the graph worker path and added an
  operational smoke test for graph orchestration.

### Fixed

- Tightened per-run scope and logger guardrails so bootstrap context binding is
  easier to test and less prone to cross-run state leakage.
- Added architecture fitness checks that guard scoped logger configuration and
  documented raw-stream output exceptions.

## [0.1.2] - 2026-06-16

A maintenance release focused on analyzer accuracy. No public-API changes.

### Fixed

- Fewer false positives across the static analyzers, each narrowed without
  losing real findings:
  - `graph` orphan-subtree now treats a dynamic `import()` as a reachability
    edge; `duplicated-function-body` dedupes by physical identity so a function
    can't match itself; `always-throws-branch` no longer reads a `throw` inside
    a nested/returned closure as the outer function always throwing;
    `no-side-effect-path` no longer classifies telemetry/mutation-emitting
    helpers as pure.
  - `fit`'s `stubbed-implementation-detection` treats `{}` cast to a
    dictionary/record shape (`Record<…>`, index signature, mapped type) as a
    valid empty collection — while still flagging `{} as Map<…>`, which is a
    broken stub (`({}).get()` throws at runtime).

### Changed

- The bundled first-party tool set is now data-driven (a manifest) rather than
  hand-maintained CLI constants — lowering the cost of adding a first-party
  tool. No user-facing behavior change; bundled tools still fail closed.

## [0.1.1] - 2026-06-15

A maintenance release: a product-tagline refresh and an internal database
migration consolidation. No tool behavior or public-API changes.

### Changed

- Refreshed the product tagline to "codebase intelligence from your terminal"
  across the CLI banner, `--help` output, and package metadata/READMEs.
- Consolidated the bundled SQLite migrations into a single initial migration
  (no schema change). On the first run after upgrading from 0.1.0, the
  disposable `opensip-cli/.runtime/` cache re-initializes — sessions, baselines,
  and caches are re-captured on the next `fit`/`graph` run.

## [0.1.0] - 2026-06-15

Initial public release of OpenSIP CLI on the `@opensip-cli/*` + `opensip-cli`
identity. This is a `0.x` release: the public API (the Tool contract, the check
authoring API, the config + payload schemas, and the CLI surface) is not yet
frozen, and breaking changes may land on minor (`0.y`) bumps until `1.0.0`.

### Added

- `opensip` command distributed by the `opensip-cli` npm package.
- Polyglot `fit` checks across TypeScript, Python, Go, Java, Rust, and C/C++.
- CI baseline ratchet for surfacing net-new findings without blocking on an
  existing backlog.
- SARIF output and signal-sync plumbing for the upcoming OpenSIP Cloud.
- Static `graph` analysis with architecture rules, blast-radius signals, cycle
  detection, large-function detection, and duplicated-body detection.
- Self-contained HTML dashboard reports.
- `sim` engine for scenario-based load, chaos, and adversarial testing.
- Project scaffolding via `opensip init`.
- Plugin system for custom checks, recipes, scenarios, graph adapters, and full
  tools.
- Project-local and global extension paths with explicit trust controls.
- Session history, replay, and purge commands.
