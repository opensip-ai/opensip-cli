# Changelog

All notable changes to OpenSIP CLI are documented here.

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
