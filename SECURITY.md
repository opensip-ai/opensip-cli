# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in opensip-tools, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

### How to report

1. **GitHub Security Advisories (preferred):** Use [GitHub's private vulnerability reporting](https://github.com/opensip-ai/opensip-tools/security/advisories/new) to submit a report directly.

2. **Email:** Send details to security@opensip.ai

### What to include

- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Potential impact
- Suggested fix (if any)

### Response timeline

- **Acknowledgment:** Within 48 hours
- **Initial assessment:** Within 5 business days
- **Fix timeline:** Depends on severity; critical issues are prioritized

### Scope

This policy covers all 31 first-party packages (the unscoped
`opensip-tools` CLI plus 30 `@opensip-tools/*` packages):

- `opensip-tools` — the CLI binary
- `@opensip-tools/core` — kernel (errors, logger, language adapters,
  plugin loader, Tool contract)
- `@opensip-tools/contracts` — Tool↔runner contract types (types-only)
- `@opensip-tools/datastore` — SQLite + Drizzle persistence layer
- `@opensip-tools/session-store` — SessionRepo runtime + sessions schema
- `@opensip-tools/output` — machine-output formatters + delivery sinks
- `@opensip-tools/dashboard` — self-contained HTML report generator
- `@opensip-tools/cli-ui` — shared Ink/React CLI primitives
- `@opensip-tools/tree-sitter` — grammar-agnostic web-tree-sitter substrate
- `@opensip-tools/fitness` — fitness engine
- `@opensip-tools/checks-{typescript,universal,python,go,java,cpp,rust}` —
  fitness check packs
- `@opensip-tools/simulation` — simulation engine
- `@opensip-tools/graph` — static call-graph engine
- `@opensip-tools/graph-adapter-common` — shared tree-sitter adapter scaffolding
- `@opensip-tools/graph-{typescript,python,rust,go,java}` — graph language adapters
- `@opensip-tools/lang-{typescript,rust,python,go,java,cpp}` —
  language adapters

### Out of scope

- Community plugins installed via `opensip-tools plugin add`
- Issues in upstream dependencies (report those to the respective projects)

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |

We recommend always running the latest version.

## Past advisories

### 0.2.5 (2026-05-04) — Plugin discovery path traversal & symlink escape

Affected: `@opensip-tools/core` and `opensip-tools` versions `< 0.2.5`.

A user-controlled `.opensip-tools/fit/package.json` or a symlink planted in
the plugin directory could cause the toolkit to dynamically import code
from arbitrary paths outside the plugin sandbox. Additionally, plugin load
failures did not fail the run, allowing a broken or malicious plugin to
silently suppress checks while CI reported success.

Fix: containment checks via `realpathSync` on all attacker-influenced paths
in plugin discovery, plus rejection of dependency names containing `..`,
leading `/`, or NUL bytes. Plugin load failures now propagate to a non-zero
exit code.

Upgrade to `0.2.5` or later. See `CHANGELOG.md` for full details.
