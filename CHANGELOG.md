# Changelog

All notable changes to OpenSIP CLI are documented here.

## [1.0.0] - 2026-06-12

Initial production launch of OpenSIP CLI.

### Added

- `opensip` command distributed by the `opensip-cli` npm package.
- Polyglot `fit` checks across TypeScript, Python, Go, Java, Rust, and C/C++.
- CI baseline ratchet for surfacing net-new findings without blocking on an
  existing backlog.
- SARIF output and OpenSIP Cloud signal sync.
- Static `graph` analysis with architecture rules, blast-radius signals, cycle
  detection, large-function detection, and duplicated-body detection.
- Self-contained HTML dashboard reports.
- Experimental `sim` engine for scenario-based load, chaos, and adversarial
  testing.
- Project scaffolding via `opensip init`.
- Plugin system for custom checks, recipes, scenarios, graph adapters, and full
  tools.
- Project-local and global extension paths with explicit trust controls.
- Session history, replay, and purge commands.
