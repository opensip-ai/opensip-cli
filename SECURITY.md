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

This policy covers:
- `@opensip-tools/cli` — the CLI binary
- `@opensip-tools/core` — the framework
- `@opensip-tools/checks-builtin` — built-in fitness checks
- `@opensip-tools/simulation` — simulation engine

### Out of scope

- Community plugins installed via `opensip-tools plugin install`
- Issues in upstream dependencies (report those to the respective projects)

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |

We recommend always running the latest version.

## Past advisories

### 0.2.5 (2026-05-04) — Plugin discovery path traversal & symlink escape

Affected: `@opensip-tools/core` and `@opensip-tools/cli` versions `< 0.2.5`.

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
