# Spec: Installed npm tool trust policy

## Objective

Close the trust-boundary gap between **project-local** executable tools (deny-by-default + `OPENSIP_CLI_ALLOW_PROJECT_TOOLS`) and **installed npm** tools (ambient auto-discovery + in-process `import()` with no opt-out beyond the new kill switch).

**Success criteria:**

- A repo with a malicious or buggy `opensipTools.kind: tool` package in ancestor `node_modules` cannot execute in the host process unless the operator explicitly opted in.
- Bundled first-party tools (`@opensip-cli/fitness`, `simulation`, `graph`) remain loadable without extra configuration.
- User-global authored tools (`~/.opensip-cli/tools/`) retain trusted-by-placement behavior unless policy changes.
- `opensip tools list` / `tools validate` can still probe packages without loading them into the long-lived host run (existing child-process probe path).
- Policy is documented in env-surface reference and contributor-facing extension docs.

**Out of scope (this spec):** Full ADR-0054 worker isolation (manifest/RPC across process boundary). This spec covers **host-process admission policy** only.

## Background (verified)

| Source | Behavior today |
|---|---|
| Project-local authored | `isProjectLocalToolTrusted` before import (`register-tools-discovery.ts`) |
| Installed npm | Manifest + `admitTool`, then `importToolRuntime` — no trust gate (`:272-289`) |
| Kill switch (shipped in audit-remediation branch) | `OPENSIP_CLI_SKIP_INSTALLED` + `--no-plugins` skips installed discovery entirely |

## Users

- **Operators** in untrusted/monorepo environments who need safe defaults.
- **Plugin authors** installing tools via npm who need an explicit opt-in path.
- **Maintainers** dogfooding with workspace-injected bundled tools (must not regress).

## Requirements

### R1 — Default-deny for ambient installed npm tools

Unless explicitly allowed, packages discovered via `discoverToolPackagesFromAnchors` with source `installed` must **not** be `import()`ed.

**Allowed without extra config (proposed):**

| Provenance | Load in host? |
|---|---|
| Bundled (`registerFirstPartyTools`) | Yes |
| User-global authored (`~/.opensip-cli/tools/`) | Yes (trusted-by-placement) |
| Project-local authored | Only if allowlisted (`OPENSIP_CLI_ALLOW_PROJECT_TOOLS`) |
| Installed npm (`node_modules` walk) | **No** unless allowlisted (new) |

### R2 — Explicit allowlist for installed tools

Introduce `OPENSIP_CLI_ALLOW_INSTALLED_TOOLS` (name TBD — align naming with project-local):

- Comma/whitespace-separated **tool ids** (manifest `id`, not package name) or `*`.
- Empty/unset ⇒ deny (paired with R1).
- Read **before** `importToolRuntime`, same timing as project-local trust.

### R3 — Preserve kill switch

Keep `OPENSIP_CLI_SKIP_INSTALLED` and `--no-plugins` as override-to-skip-all-installed (incident response). Precedence: kill switch wins over allowlist.

### R4 — Diagnostics

When an installed tool is skipped due to policy:

- Structured log: `cli.tool.installed_trust_denied` with `toolId`, `packageName`, `packageDir`.
- Stderr (one line, best-effort): how to allow (`OPENSIP_CLI_ALLOW_INSTALLED_TOOLS=<id>`) or use `--no-plugins` documentation link.
- Exit code: **do not** fail the whole CLI for skipped installed tools (mirror today's best-effort installed posture) unless the invoked subcommand required that tool.

### R5 — `tools install` / `tools validate` integration

- `tools install` should print the allowlist hint after successful install.
- `tools validate` static probe remains child-process isolated (no change to runtime policy).

## Design options (decision needed)

| Option | Pros | Cons |
|---|---|---|
| **A — Mirror project-local exactly** (`ALLOW_INSTALLED_TOOLS`, deny default) | Symmetric, predictable | Breaking for repos that already have ambient plugins |
| **B — Opt-in via config file** (`plugins.toolsAllow: [...]`) | Auditable in repo | Config load happens after bootstrap today — requires lifecycle change |
| **C — Deprecate ambient install; require `plugins.tools` explicit list only** | Smallest attack surface | Largest behavior change |

**Recommendation:** Option A for v1, with release note and migration period documenting `OPENSIP_CLI_ALLOW_INSTALLED_TOOLS='*'` escape hatch.

## Implementation plan (high level)

1. Add `isInstalledToolTrusted(id, env)` in `tool-trust.ts` (parallel to project-local).
2. In `admitInstalledTool` / discovery loop: after manifest admit, before `importToolRuntime`, check trust.
3. Register env spec in `host-env-specs.ts`; document in generated env reference.
4. Tests: deny by default; allow with id; `*` allows all; kill switch overrides; bundled unaffected.
5. Optional dogfood check: AST or path guard ensuring `importToolRuntime` for `installed` always passes through trust helper.

## Acceptance tests

- [ ] Installed tool package in fixture `node_modules` is **not** registered without allowlist.
- [ ] Same package loads when `OPENSIP_CLI_ALLOW_INSTALLED_TOOLS=<id>`.
- [ ] `OPENSIP_CLI_SKIP_INSTALLED=1` prevents load even with allowlist.
- [ ] Bundled `fit`/`graph`/`sim` still mount with zero env configuration.
- [ ] `opensip tools validate <pkg>` still works without host import.

## Open questions

1. Should **user-global authored** remain trusted-by-placement under the stricter policy?
2. Is `plugins.tools` explicit list in config intended to imply trust (future config-time allowlist)?
3. Timeline for ADR-0054 worker boundary relative to this policy gate?

## References

- `packages/cli/src/bootstrap/register-tools-discovery.ts`
- `packages/cli/src/bootstrap/tool-trust.ts`
- `packages/cli/src/bootstrap/skip-installed-plugins.ts` (kill switch — implemented)
- Architecture audit consensus: `docs/internal/coop/agents-log.md`