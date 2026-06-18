# Changelog

All notable changes to OpenSIP CLI are documented here.

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
