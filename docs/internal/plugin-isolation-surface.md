# Plugin isolation surface (ADR-0054, ADR-0061)

Internal reference for external-tool **fault** isolation and extension trust tiers.
Public docs: `docs/public/50-extend/06-full-tool-plugins.md`.

**Canonical trust-tier matrix:** [ADR-0061](../decisions/ADR-0061-tool-platform-launch-posture-and-extension-trust-tiers.md).
The table below mirrors ADR-0061 for contributor convenience only — if it drifts,
ADR-0061 wins.

## Two isolation properties (always pair them)

| Property | Status | Meaning |
|----------|--------|---------|
| **Fault isolation** | Landed (ADR-0054) | A worker crash/hang/OOM becomes a structured `ToolError`; the host survives. |
| **Capability / confidentiality isolation** | **Absent** | An admitted external tool runs at **full user privilege** — it can read the filesystem (including `~/.ssh` and `.env`), and make arbitrary network calls. It is fault-isolated, **not** capability-isolated. |

> An admitted external tool runs at full user privilege: it can read the filesystem (including `~/.ssh` and `.env`), and make arbitrary network calls. It is fault-isolated (a crash/hang/OOM does not take down the host), not capability-isolated.

## Trust-tier matrix (contributor reference — canonical source: ADR-0061)

| Surface | Default admission | Process boundary | Ambient authority | Compat policy | Provenance / verify | Docs warning |
| --- | --- | --- | --- | --- | --- | --- |
| **Bundled tools** (fit / graph / sim / yagni) | Trusted (manifest) | In-process (TTY-live forks for UX) | Full host — *is* the TCB | Co-built, always matches | First-party, `--provenance` | n/a (trusted core) |
| **Installed npm tools** (whole Tool) | Deny-by-default (`OPENSIP_CLI_ALLOW_INSTALLED_TOOLS`; `*` footgun) | Worker fork (ADR-0054) | Full **user** privilege — fault-isolated, **NOT** capability-isolated | Bounded integer epoch (`MIN..PLUGIN_API_VERSION`, ADR-0074) | Publish-side ships; consumption-side missing | Yes — "runs at full privilege" |
| **Project-local authored** (sidecar) | Deny-by-default (`OPENSIP_CLI_ALLOW_PROJECT_TOOLS`; `*`) | Worker fork | Full user privilege | Bounded integer epoch (current-epoch source, not package artifacts) | Authored content, no verify | Yes — clone-risk |
| **User-global authored** (`~/.opensip-cli/tools/`) | **Trusted-by-location** (loads w/o allowlist) | Worker fork | Full user privilege | Bounded integer epoch | Location = trust, no verify | Yes — trust ≠ sandbox |
| **Bundled capability packs** (`checks-*`, `graph-*`) | Trusted (bundled) | **In-process** (`capability-discovery.ts:307`) | Full host — grows the TCB | Target domain epoch (`targetDomain` + `targetDomainApiVersion`) | First-party | Bundled-TCB governance |
| **External / custom capability packs** (custom checks, graph adapters) | Listed in `plugins.<domain>` | **In-process — NO worker** | Full host; can crash host; full authority | Target domain epoch gate (compatibility ≠ isolation) | No verify | Yes — strongest gap |

**In-process capability-pack gap:** external custom checks and graph adapters load via
`await import(...)` at `packages/core/src/plugins/capability-discovery.ts:307` with
per-package try/catch skip-never-throw — import-error isolation only, no worker
boundary. ADR-0074 adds target-domain epoch compatibility before routing; it does
**not** add capability isolation. The "external isolation" story does **not** cover
the most common extension.

## Shipped (M4-E / M4-F / M4-G)

| Mechanism | Module | Behavior |
|-----------|--------|----------|
| Synthetic host registration | `synthesize-external-tool.ts` | Host mounts manifest-derived `commandSpecs` without importing runtime |
| Worker dispatch | `bind-external-dispatch.ts`, `dispatch-fork-core.ts` | External provenance always forks `__tool-command-worker` |
| Lifecycle gating | `tool-provenance.ts` (`shouldRunHookInHost`) | External hooks skip in host; run in worker |
| Runtime import boundary | `host-tool-runtime-import-boundary` check | Host may not `import()` external runtimes outside admission/dispatch |
| Bundled mount fail-closed | `register-tools-mount.ts` | Bundled `mountOneTool` failure → `PluginIncompatibleError` (exit 5) |
| External worker child env | `build-external-worker-child-env.ts` | Explicit allow-list + `OPENSIP_CLI_TOOL_ENV_PASSTHROUGH` escape hatch |

## Trust admission (pre-import)

- Project-local: deny-by-default; `OPENSIP_CLI_ALLOW_PROJECT_TOOLS` allowlist.
- Installed npm: deny-by-default; `OPENSIP_CLI_ALLOW_INSTALLED_TOOLS` allowlist.
- Wildcard `*` admits all and emits a **per-invocation** `cli.trust.wildcard_allowlist`
  deprecation warning (DEPRECATED + full-privilege caveat).

## Consumption verification inventory (ADR-0068)

Producer provenance for first-party packages ships via OIDC/`npm publish --provenance`.
**Consumption-side** verification (install/load checks for third-party packages) is
policy-defined but **not implemented** in the loader yet (spec 03 owns enforcement).

| Consumption point | Package identity | Default admission (ADR-0061) | npm provenance possible? | Likely verify time |
| --- | --- | --- | --- | --- |
| Global installed npm whole Tools | npm name + version pin | Deny-by-default (`OPENSIP_CLI_ALLOW_INSTALLED_TOOLS`) | Yes (if publisher ships provenance) | Install + load |
| Project-local authored Tools | Sidecar path + manifest | Deny-by-default (`OPENSIP_CLI_ALLOW_PROJECT_TOOLS`) | No (authored source) | Admission (`tools validate`) + load |
| User-global authored Tools | Sidecar path under `~/.opensip-cli/tools/` | Trusted-by-location | No | Load (explicit policy TBD) |
| Project-pinned fit/sim packs | npm pin in `plugins.*` | Config-listed | Yes | Sync/install + capability load |
| Marker-discovered fit packs | `opensipTools.kind: fit-pack` + target epoch | Trusted when bundled; non-bundled requires exact `OPENSIP_CLI_ALLOW_CAPABILITY_PACKS` | Yes for external npm | Capability load |
| Graph adapters | `plugins.graphAdapters` or marker | Trusted when bundled; external = explicit | Yes for external npm | Per-run capability load |

### Strict-mode target policy (not enforced yet)

| Provenance state | Bundled first-party | Enterprise strict (non-bundled) | Non-strict default |
| --- | --- | --- | --- |
| Present + matches | `allow` (TCB) | `allow` when allowlisted | `allow` |
| Missing | n/a (release gate) | `deny` unless approved exception | `warn` |
| Mismatch | n/a | `deny` unless approved exception | `warn` |
| Authored (no npm provenance) | n/a | `deny` without explicit project admission | `warn` at admission |

Bundled first-party packages are trusted TCB — verified by release provenance, not
per-install consumer checks. User-global authored trust-by-location must be decided
explicitly in enterprise policy; it does not inherit silently from filesystem path.

## Remaining gaps

| Gap | Status |
|-----|--------|
| Capability / confidentiality isolation | **Absent** — admitted tools run at full user privilege |
| In-process capability packs | **Strongest gap** — no worker boundary for custom checks/adapters |
| Consumption-side provenance verification | Publish-side ships; **install/load enforcement is the gap** (ADR-0068 policy only) |
| Off-thread-selector fitness check | **Lapsed** — `live-runs-off-thread` removed; `live-view-through-cli-live` (ADR-0058) forbids ink `render` imports only |

**Public third-party ecosystem MUST NOT open until consumption-side verification +
capability/permission model ship (ADR-0061 gates).**

## Tool independence (ADR-0064)

`@opensip-cli/clone-detection` is the canonical example of the platform's tool-independence rule: when two tools need the same logic, **refactor the shared piece into a leaf substrate** — never add a tool→peer-tool dependency edge. Graph and yagni both depend on `@opensip-cli/clone-detection` for duplicate/near-duplicate detection math; neither depends on the other. Enforcement: dep-cruiser `clone-detection-imports-nothing` (leaf package) + the existing `yagni-no-graph*` rules (yagni must not import graph engine/adapters). See [ADR-0064](../decisions/ADR-0064-shared-clone-detection-substrate.md).

## Related ADRs

- ADR-0061 — tool-platform launch posture and extension trust tiers (canonical matrix)
- ADR-0054 — tool fault isolation boundary
- ADR-0056 — audit remediation scope index
- ADR-0030 — authored tool discovery
- ADR-0064 — shared clone-detection substrate (tool independence)
