---
status: active
last_verified: 2026-06-09
owner: opensip-cli
---

# ADR-0030: Authored-Tool discovery realizes the three-sources-one-path claim

```yaml
id: ADR-0030
title: Authored-Tool discovery realizes the three-sources-one-path claim
date: 2026-06-09
status: active
supersedes: []
superseded_by: null
related: [ADR-0027, ADR-0012]   # GA parity cutover (the claim this realizes); 3.0.0 reservation
tags: [plugin-parity, cli, core, security, tool-discovery]
enforcement: mechanizable
enforcement-reason: >
  The deny-by-default trust gate is unit-pinned: `tool-trust.test.ts` asserts an
  un-allowlisted project-authored sidecar fail-closes (PluginIncompatibleError →
  exit 5) BEFORE its module imports, and that an allowlisted / wildcard one is
  admitted with `project-local` provenance. The integration test
  (`authored-tool-load.test.ts`) drives the real bootstrap end-to-end for both
  authored sources. The allowlist env var is a declared `EnvVarSpec`, drift-guarded
  by `host-env-specs.test.ts` + the `env-surface-doc` reference test. Layering
  (discovery in `core/plugins`, wiring in `cli/bootstrap`; `core` imports nothing
  from `contracts`/`cli`) is held by dependency-cruiser.
```

**Decision:** Wire **authored-Tool discovery** so the [ADR-0027](./ADR-0027-ga-parity-cutover.md)
claim that "bundled, installed, and project-local tools travel the same manifest →
admit → import path" is *true* for the authored source, not aspirational. An
authored Tool declares identity via an `opensip-tool.manifest.json` **sidecar**
(no `package.json` marker) in one of two locations, discovered at bootstrap and
routed through the existing `loadToolManifest → admitTool → importToolRuntime →
register` machinery:

1. **`~/.opensip-cli/tools/<name>/`** — a new `ToolSource: 'user-global'`,
   **trusted-by-default**. The user placed it in their own home dir (the `npm i -g`
   analogue for authored code), so it loads without an allowlist.
2. **`<project>/opensip-cli/tools/<name>/`** — `ToolSource: 'project-local'`,
   **deny-by-default**. It is TRACKED source committed beside `opensip-cli/fit/`
   and `opensip-cli/sim/`, but it rides in with a `git clone` before you've read
   it — so it is admitted only when its `id` (or `*`) appears in
   `OPENSIP_CLI_ALLOW_PROJECT_TOOLS`; otherwise the CLI **fail-closes (exit 5)
   before any import**. The trust decision always precedes the dynamic import.

`plugin add --project` is **unchanged** — it installs an npm package into the
gitignored `.runtime/plugins/tool/` and keeps provenance `installed`. Authored
sidecars are a different mechanism with authored provenance.

**Alternatives:**

- *Infer the source from path shape inside the kernel walk.* Rejected — it leaks
  cli/path-context vocabulary into `core` and makes provenance implicit. The walk
  is source-agnostic (takes a plain `string` root); the caller assigns the source
  per root, so the tag is carried, never inferred.
- *Make the project-authored leg trusted-by-default (like fit/sim packs).* Rejected
  — fit/sim authored content is data (checks/scenarios) the engine interprets; an
  authored Tool is arbitrary executable code mounted as a whole subcommand. A
  cloned repo must not run that code by mere presence. Deny-by-default + a
  documented allowlist is the threat model.
- *Reuse `project-local` for both authored locations.* Rejected — a globally-authored
  tool (trusted) and a project-authored one (clone-risk) are different trust
  postures that must be distinguishable in provenance, so `user-global` is added
  to the union and `project-local` is re-scoped to the project sidecar.
- *Skip a same-id project tool that fails to load (like the installed leg).*
  Rejected for authored tools — installed tools are ambient (a stray bad plugin
  must not take fit/graph/sim down), but an authored tool is first-party-intent.
  An authored tool whose runtime fails to load is fail-closed.

**Rationale:** The dormant `admitProjectLocalTool` already encoded the exact
trust-before-import admission policy; it simply had no discovery caller, so the
project-local leg of the ADR-0027 claim was unreachable. A narrow `core/plugins`
sidecar walk (mirroring `discoverPackagesInNodeModules`) plus a thin
trusted-by-default `admitUserGlobalTool` sibling (sharing the
`loadToolManifest → admitTool` tail with the project leg) wires both authored
roots through the one runtime-load seam without a parallel admission hierarchy.

**Consequences:**

- `ToolSource` gains `'user-global'`; `project-local` is re-scoped to the project
  authored sidecar. No shim preserves the old broader meaning (it had no
  production caller).
- One new env var, `OPENSIP_CLI_ALLOW_PROJECT_TOOLS`, declared as a first-class
  `EnvVarSpec` and documented in the env-surface reference.
- `plugin list` (human + `--json`) surfaces `user-global` / `project-local`
  provenance rows alongside `bundled` / `installed`; every admitted authored tool
  records a `ToolProvenance` (source + `manifestHash`).
- Existing `fit`/`graph`/`sim` output (human + `--json`) is byte-identical; the
  only additive user-visible deltas are the new `plugin list` provenance rows and
  the un-allowlisted-project-tool exit-5 path.

**Related specs / ADRs:** [ADR-0027](./ADR-0027-ga-parity-cutover.md) (the parity
cutover whose three-sources-one-path claim this realizes);
[ADR-0012](./ADR-0012-versioning-and-release-policy.md) (the 3.0.0 reservation).
