---
status: active
last_verified: 2026-06-28
owner: opensip-cli
---

# ADR-0090: external tool adapters are a worker-dispatched installed substrate

```yaml
id: ADR-0090
title: external tool adapters are a worker-dispatched installed substrate
date: 2026-06-28
status: active
supersedes: []
superseded_by: null
related: [ADR-0084, ADR-0041, ADR-0054, ADR-0048, ADR-0061]
tags: [tools, adapters, scanners, packaging, isolation]
enforcement: mechanizable
enforcement-reason: >
  The substrate-is-layer-3 and adapter-is-layer-4 boundaries are dependency-cruiser
  rules (the substrate rule modeled on `output-imports-core-contracts-only`; the
  adapter rule scoped to `^packages/tool-(gitleaks|osv-scanner|trivy)/` so it does
  not collide with the layer-2 `tool-test-kit`). The "an adapter must be authored
  through the substrate" invariant is the NEW path-gated `adapter-must-use-substrate`
  fitness check. The host-never-imports-an-installed-runtime, no-new-CommandResult-variant,
  and no-`live-view` invariants are compile-time (the closed `ToolRuntimeImportPolicy`
  and `CommandResult` unions) and covered by the existing external-synthesis /
  `tools validate` tests (ADR-0082). See the Fitness check section.
```

**Decision:** Ship a non-bundled, opt-in **layer-3** substrate package
`@opensip-cli/external-tool-adapter` exporting `defineExternalToolAdapter(spec) →
Tool` — it returns `defineTool(...)`, so an adapter is an ordinary `Tool` and
there is **no new plugin kind**. Adapters built on it (the MVP set:
`@opensip-cli/tool-gitleaks`, `@opensip-cli/tool-osv-scanner`,
`@opensip-cli/tool-trivy`) are **installed, never bundled**. The host therefore
**never imports an adapter's runtime**: it registers a manifest-synthesized `Tool`
and **forks a worker at invocation**. Both the `scan` handler and the substrate's
auto-added `doctor`/`version` handlers run **worker-side**; the host seams they
need (`writeArtifact`, `saveBaseline`, `deliverSignals`, `reportFailure`,
`setExitCode`) cross the worker→host boundary through the **existing dispatch
RPC**. The substrate resolves the scanner binary by a layered lookup (config/env →
`PATH`; an install **hint** only, never a fetch) and reports readiness via a new
plain `AdapterDoctorReport` (not `ToolsDoctorResult`).

**Alternatives:**

- **Load adapters through the in-host dynamic-import admission path every bundled
  Tool uses** (`admit-tool-package.ts`) — rejected; that is the **bundled** path
  only. `ToolRuntimeImportPolicy` is `{ source: 'bundled' }` and a non-bundled
  host import is a **compile error**; `isHostRuntimeImportForbidden(env)` defaults
  `true`. Importing a third-party scanner wrapper into the host process would
  reintroduce exactly the trust/fault surface ADR-0054 isolates. Installed tools
  mount a synthetic `Tool` and dispatch to a forked worker — adapters inherit that
  path unchanged.
- **Bundle the three first-party scanners** (add them to
  `bundled-tools.manifest.json`) — rejected; they wrap **user-installed external
  binaries** that most projects will not have, and bundling would force every CLI
  install to carry scanner-specific surface area. Opt-in install keeps the core
  CLI scanner-agnostic and the adapters independently versioned/published.
- **A bespoke `kind: "adapter"` plugin marker with its own loader** — rejected;
  the synthetic-tool + worker dispatch path already exists and already enforces
  isolation. A new kind would be a parallel, less-tested admission path for no
  capability gain. `defineExternalToolAdapter` is a thin authoring helper over
  `defineTool`, not a new contract.
- **Reuse `ToolsDoctorResult` for the adapter `doctor`** — rejected (see ADR-0091
  / the frozen Phase-0 decisions): it is the host's global bootstrap-diagnostics
  inventory, its `type` collides with the `tools doctor` command, and
  `diagnostics: CliDiagnostic[]` is the wrong shape for binary/version/posture/ready.
  `CommandResult` is a **closed** union in `contracts` (layer 2) — the substrate
  (layer 3) and adapters (layer 4) cannot add a variant. The substrate defines its
  own plain `AdapterDoctorReport` and emits it via `cli.render({ type:'text-lines',
  … })` (human) / `cli.emitJson(report)` (`--json`).
- **Auto-fetch a missing scanner binary** — rejected; a network download triggered
  by a security scan is a surprising, unsigned supply-chain side effect. Resolution
  stops at config/env → `PATH`; a missing binary yields an `AdapterDoctorReport`
  with an **install hint**, never an install.

**Rationale:** opensip-cli already has every mechanism an external scanner needs —
the `Signal`/`SignalEnvelope` currency (ADR-0011), the worker fault-isolation
boundary (ADR-0054), the `tools` install/trust surface (ADR-0041), stable tool
identity (ADR-0048), and the host-owned baseline ratchet (ADR-0036). What it
lacks is a *shared authoring substrate* so a new scanner is "parse + map + declare
a binary," not a from-scratch `Tool`. Grounding the spec against the live 0.1.14
tree corrected the spec's central premise: the spec assumed adapters run **in the
host** via the bundled import path, but installed tools are **manifest-synthesized
and worker-dispatched** (`register-tools-discovery.ts` → `synthesizeExternalTool`;
`bind-external-dispatch.ts` → `dispatch-external-tool-command.ts` forks the
worker). Every "the adapter's `Tool` runs in the host" assumption is therefore
false: `scan` **and** `doctor` (the `execFile` binary probe) run worker-side, and
the worker replays a slim result through the host seams (proven by
`external-tool-dispatch.test.ts`). Recording this corrected execution model is the
load-bearing purpose of this ADR.

**Consequences:**

- **New layer-3 package** `@opensip-cli/external-tool-adapter` whose production
  dependencies are exactly `@opensip-cli/core` + `@opensip-cli/contracts`
  (`@opensip-cli/output` is a **devDependency** only, for the SARIF round-trip
  golden — see ADR-0091). It is publishable and non-private (required for `tools
  install` from npm), so it and the three adapters join the release contract
  (`RELEASE_PACKAGE_ORDER`, `RELEASING.md`, the package-count prose), substrate
  before adapters, placed near `@opensip-cli/mcp` (the ADR-0084 precedent for
  adding a publishable package). There is no "publishable but exempt from the
  release order" state.
- **The substrate auto-adds `doctor` and `version` commands** to every adapter so
  every scanner has the same readiness UX. The adapter's static
  `package.json#opensipTools.commands` (scan + doctor + version shells) is
  **generated and drift-gated**, never hand-authored: the bundled-tool manifest
  generator (`scripts/build-tool-command-manifests.mjs`) is extended to also derive
  and `--check` the adapter packages, because `assertCommandNamesMatch` throws on
  manifest↔runtime drift at install and at worker import.
- **The host never imports an installed adapter runtime.** Dispatch forks a worker
  that re-runs CLI bootstrap, re-discovers + imports the real runtime, runs the
  handler, and replays the result. The worker spawn reuses the
  `RunCorrelation`/`TRACEPARENT` threading mandated by ADR-0054 so a child failure
  is attributable to the parent run.
- **Distribution posture: repo-per-tool first, packs later, none bundled.** The
  three MVP adapters ship as independent packages; a curated "scanner pack" is a
  later, additive option. No adapter is ever added to
  `bundled-tools.manifest.json`.
- **Trust:** installed tools are **deny-by-default** — `opensip gitleaks …` needs
  `OPENSIP_CLI_ALLOW_INSTALLED_TOOLS=<uuid>` after install (the worker dispatch is
  the fault boundary; ADR-0054). Every acceptance test must export it. Adapters
  may not declare `output: "live-view"` (ADR-0082 — there is no in-host renderer to
  call).
- **MVP-unblock boundary vs spec 03.** The substrate + three first-party adapters
  add **no untrusted-JS surface**: they are opensip.ai-authored JS wrapping a
  user-installed subprocess (`execFile`, no shell), loaded through the normal
  installed-tool admission/worker path. No 03 Gate is implicated, so the MVP
  proceeds. The **public third-party adapter ecosystem** and capability
  *enforcement* stay gated on ADR-0061/03 (network/auth `requires` is
  declaration-only in v1 — ADR-0092).

**Fitness check:** every structural invariant this ADR introduces is paired with
its enforcement (an ADR without this section is incomplete):

| Invariant | Evaluation | Enforcement |
|-----------|-----------|-------------|
| An adapter is authored through `defineExternalToolAdapter` (not raw `defineTool` + hand-rolled scan/doctor/version shells) | **Check warranted** | NEW path-gated `adapter-must-use-substrate` — `packages/fitness/checks-typescript/src/checks/architecture/adapter-must-use-substrate.ts`, gated to `^packages/tool-(gitleaks\|osv-scanner\|trivy)/`; references this ADR in a top-of-file comment. |
| `external-tool-adapter` is layer-3 (deps = `core` + `contracts`, `output` devDep only); adapters are layer-4 (deps = the substrate + `core`) | **No new check** | dependency-cruiser: the substrate rule modeled on `output-imports-core-contracts-only`; the adapter rule scoped to `^packages/tool-(gitleaks\|osv-scanner\|trivy)/` (avoids the `tool-test-kit` collision, Risk R8). A fitness check would duplicate depcruise. |
| The host never imports an installed adapter runtime; adapters mount as a synthetic `Tool` + forked worker | **No check warranted** | Compile-time: `ToolRuntimeImportPolicy = { source: 'bundled' }` makes a non-bundled host import a type error; covered behaviorally by `register-tools.test.ts` / `external-tool-dispatch.test.ts`. A source-pattern check would duplicate the type. |
| The adapter `doctor` uses `AdapterDoctorReport`, never a new `CommandResult` variant | **No check warranted** | Compile-time: `CommandResult` is a closed union in `contracts`; adding a variant from layer 3/4 fails to typecheck. |
| Adapters may not declare `output: "live-view"` | **No new check** | Existing ADR-0082 external-synthesis + `tools validate` `external-output-modes` coherence tests. |
| Adapter `package.json#opensipTools.commands` matches the runtime `commandSpecs` (scan + doctor + version) | **No new check** | Existing `assertCommandNamesMatch` (throws at install/worker import) + the extended `build-tool-command-manifests.mjs --check` parity gate (`pnpm tool-manifests:check`). |

**Related specs / ADRs:** implemented by the local plan
`docs/plans/ready/04-external-tool-adapters/` (see its `IMPLEMENTATION-BRIEF.md`,
the corrected source of truth). Related:
[ADR-0084](ADR-0084-mcp-server-surface.md) (the precedent for adding a publishable
first-party tool package), [ADR-0041](ADR-0041-customer-facing-tools-command-group.md)
(the `tools` install/trust surface adapters mount through),
[ADR-0054](ADR-0054-tool-fault-isolation-boundary.md) (the worker fault-isolation
boundary external tools dispatch across),
[ADR-0048](ADR-0048-tool-stable-uuid-identity.md) (stable adapter identity), and
[ADR-0061](ADR-0061-tool-platform-launch-posture-and-extension-trust-tiers.md)
(the launch posture that keeps the public ecosystem gated while first-party
adapters ship). Finding ingestion/artifacts/exit modeling are
[ADR-0091](ADR-0091-external-scanner-finding-ingestion.md); network/auth
declaration + the trust bar are
[ADR-0092](ADR-0092-external-adapter-network-auth-trust.md).
</content>
</invoke>
