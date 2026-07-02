# Changelog

All notable changes to OpenSIP CLI are documented here.

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
