---
status: active
last_verified: 2026-06-23
owner: opensip-cli
---

# ADR-0061: Tool-platform launch posture and extension trust tiers

```yaml
id: ADR-0061
title: Tool-platform launch posture and extension trust tiers
date: 2026-06-23
status: active
supersedes: []
superseded_by: null
related: [ADR-0030, ADR-0054, ADR-0028, ADR-0058, ADR-0036, ADR-0051, ADR-0056]
tags: [platform, trust, plugins, security, isolation]
enforcement: mechanizable
enforcement-reason: >
  The host/tool boundary that this posture rests on is already mechanized by two
  existing fitness checks: `only-documented-toolcli-seams` (tools and host
  handlers may use only the documented `ToolCliContext` seams) and
  `host-tool-runtime-import-boundary` (the CLI source has zero static imports of
  first-party tool runtimes). Those guard the control plane this ADR declares
  mature. The NEW guards this posture requires — a per-tier admission enforcer,
  a capability/permission gate (incl. a network policy), an extension-contract
  version-range check, and a wildcard-admission deprecation warning — are
  specified in specs 01 and 03 and are NOT yet landed; this ADR records the
  decision, the specs land the enforcement.
```

**Decision:** OpenSIP CLI adopts an **ecosystem-ready, ecosystem-gated** posture.
v0.1 is a **curated first-party platform** with support for **trusted/private
external extensions** (installed, project-local, and user-global), and the
**public untrusted third-party ecosystem stays CLOSED** until three gates are
green: (1) a capability/permission model that includes an explicit network
story, (2) an extension-contract version *range* that retires exact-epoch
lockstep, and (3) consumption-side verification plus a per-tool trust policy.
The isolation the platform already ships is **FAULT isolation, not CAPABILITY
(confidentiality) isolation**: an admitted external tool survives crashes,
hangs, and OOM without taking down the host, but it runs at **full user
privilege** — it inherits the parent environment (including secrets) and can
call `node:fs` / `node:net` / `child_process` directly. Accordingly, this ADR
**re-scopes the platform principle "a tool must not take down the platform" to
HOST-PROCESS stability, not user-data confidentiality**, and it names the
**canonical extension trust-tier matrix** below as the single source of truth
for how each extension surface is admitted, isolated, and warned about.

**Alternatives:**

- **Open the public untrusted ecosystem now.** Rejected: it would ship
  fault-isolation as if it were security — a real liability, since an admitted
  tool can read `~/.ssh`, exfiltrate `.env`, and make arbitrary network calls
  (`dispatch-fork-core.ts:146-147` spreads the full parent env; no permission
  flags / `resourceLimits` at `:159-164`) — and exact-epoch compatibility
  (`compatibility.ts`, `manifest.ts:48`) makes every release a flag-day for
  every third-party tool.
- **Defer the ecosystem entirely / stay curated-only forever.** Rejected: it
  forgoes the network effects that justify a plugin platform and strands the
  plugin investment (the clean dispatcher, the worker fault boundary, the
  manifest/compatibility path); and the honesty + isolation work is needed
  regardless, because trusted/private extensions already run today.
- **Treat all "external" extensions as one tier.** Rejected: it flattens three
  genuinely distinct admission defaults (installed npm = deny-by-default;
  project-local authored = deny-by-default; user-global authored =
  trusted-by-location) and erases the most important distinction of all — that
  external **capability packs** (custom checks, graph adapters) load **in-process
  with no worker** (`capability-discovery.ts:307`), so the "external isolation"
  story does not cover the most common extension at all.

**Rationale:** A seven-turn two-agent architecture review reached consensus that
opensip-cli is a credible v0.1 tool platform and needs **no platform redesign**:
the control plane is mature, the host is a plugin-clean dispatcher with zero
static imports of tool runtimes (enforced by `host-tool-runtime-import-boundary`),
and the layered package DAG is the asset — do not de-layer. The defect is not
structural; it is a **conflation of fault isolation with capability isolation**,
visible directly in the code:

- **Dispatch forks external tools but runs bundled in-process.**
  `mount-command-spec.ts:187-192` branches on provenance: external → fork;
  bundled → `spec.handler` in-process.
- **The fork inherits everything and is capped only by a wall clock.**
  `dispatch-fork-core.ts:146-147` spreads the full parent env (behind a *waived*
  `env-secret-exposure` fitness check); `:159-164` sets no `execArgv` permission
  flags and no `resourceLimits`. The only bound is a single wall-clock timeout
  (`DEFAULT_DISPATCH_TIMEOUT_MS = 120000` at `:52`, enforced `:175-180`), which
  is **not reset per RPC upcall**; kill-on-settle is SIGTERM on normal settle and
  SIGKILL only on timeout (`:172`, `:177`) and targets the **direct child only**,
  so grandchildren leak (no process-group kill).
- **The worker "context" is a seam shim, not a sandbox.**
  `tool-command-worker-context.ts` mediates the documented `ToolCliContext`
  seams (live-view seams fail loud); it does not stop the child from reaching the
  filesystem, the network, or `child_process`. Verified-absent supervisor
  controls: max IPC payload cap, captured-output cap (stdout is `ignore`, stderr
  is `inherit`, so a child can flood the host terminal), child memory limit,
  heartbeat, and cancellation. The FRR `ResultAccumulator` holds handler payloads
  worker-side unbounded and crosses IPC unbounded; host-RPC upcalls hit the real
  host datastore/FS/egress with no backpressure for the full 120s.
- **Capability packs are even less isolated.** External checks and graph adapters
  load **in-process** via `await import(...)` at `capability-discovery.ts:307`,
  with per-package `try/catch` skip-never-throw (`:328-345`) — import-error
  isolation only, no worker boundary, so they are neither fault- nor
  capability-isolated, and they do **not** pass through `checkCompatibility`
  (they are selected by marker / export-shape / schema, not the `===` Tool gate).
- **Compatibility is bounded integer epoch admission (ADR-0074).**
  `checkCompatibility` admits `MIN_SUPPORTED_PLUGIN_API_VERSION <= apiVersion <=
  PLUGIN_API_VERSION`; capability packs declare target domain epochs in
  `package.json#opensipTools`. Compatibility gates are not capability isolation.
- **Trust tiers already diverge by location.** `register-authored-tools.ts`:
  project-local authored is deny-by-default (`OPENSIP_CLI_ALLOW_PROJECT_TOOLS`),
  but **user-global authored** (`~/.opensip-cli/tools/`) is **trusted-by-location**
  — it loads without an allowlist (ADR-0030); both are external provenance and
  still worker-forked (ADR-0054 M4-G). Installed npm tools are deny-by-default
  (`OPENSIP_CLI_ALLOW_INSTALLED_TOOLS`). The wildcard `*` admits all and logs
  once (`tool-trust.ts`) — a footgun documented by ADR-0030, so changing its
  behavior is an ADR-0030 amendment, not free.
- **Provenance ships on the publish side, not the consumption side.**
  `release.yml:236,248` and `RELEASING.md:273-274` already publish with
  `npm publish --provenance`. The gap is consumption-side verification at
  install/load + a per-tool trust policy — not "attestation not landed".
- **Telemetry is not a black hole.** Workers re-enter through the
  telemetry-wrapped CLI boundary (`index.ts:200` `runWithTelemetryContext` +
  `bootstrap/index.ts:115` `initTelemetry`); child spans nest via
  TRACEPARENT-in-env on the graph shard path (`shard-runner.ts:401`/`:415`,
  worker `shard-worker.ts:205-211`). The residual is trace-context parity across
  the fork paths (the dispatch worker and the fit/sim live-run worker do not yet
  inject the active traceparent — see spec 01), not absence of telemetry.
- **Crash semantics are narrower than first stated.** An ordinary thrown Error or
  async rejection from a bundled handler **is** caught
  (`mount-command-spec.ts:178-207` + `index.ts:200` `parseAsync().catch ->
  handleParseError`). Only JS-uncatchable faults (`process.exit`, native
  segfault, OOM) genuinely kill the host. The claim "uncaught exceptions kill the
  CLI" is overstated and must be split into catchable vs. uncatchable classes.

Given all this, the honest posture is to keep building toward third-party tools
while keeping the **public untrusted** ecosystem closed behind the three gates,
and to treat today's external tools as **trusted/private extensions** — admitted
deny-by-default for installed + project-local, with the explicit, documented
caveat that **each admitted tool runs at full user privilege**.

**Trust-tier matrix (canonical).** This table is the single source of truth for
extension admission, isolation, and warnings; the specs reference it by ADR
number rather than restating it.

| Surface | Default admission | Process boundary | Ambient authority | Compat policy | Provenance / verify | Docs warning |
| --- | --- | --- | --- | --- | --- | --- |
| **Bundled tools** (fit / graph / sim / yagni) | Trusted (manifest) | In-process (TTY-live forks for UX) | Full host — *is* the TCB | Co-built, always matches | First-party, `--provenance` | n/a (trusted core) |
| **Installed npm tools** (whole Tool) | Deny-by-default (`OPENSIP_CLI_ALLOW_INSTALLED_TOOLS`; `*` footgun) | Worker fork (ADR-0054) | Full **user** privilege — fault-isolated, **NOT** capability-isolated | Exact-epoch (`===`) | Publish-side ships; consumption-side missing | Yes — "runs at full privilege" + maturity label |
| **Project-local authored** (sidecar) | Deny-by-default (`OPENSIP_CLI_ALLOW_PROJECT_TOOLS`; `*`) | Worker fork | Full user privilege | Exact-epoch | Authored content, no verify | Yes — clone-risk (committed in-repo) |
| **User-global authored** (`~/.opensip-cli/tools/`) | **Trusted-by-location** (loads w/o allowlist) | Worker fork | Full user privilege | Exact-epoch | Location = trust, no verify | Yes — name it a tier; **trust != sandbox** |
| **Bundled capability packs** (`checks-*`, `graph-*`) | Trusted (bundled) | **In-process** (`capability-discovery.ts:307`) | Full host — grows the TCB | Co-built | First-party | Bundled-TCB governance |
| **External / custom capability packs** (custom checks, graph adapters via `plugins.<domain>`) | Listed in `plugins.<domain>` | **In-process — NO worker** (import-error isolation only) | Full host; can crash host; full authority | Descriptor-level (not the `===` Tool gate) | No verify | Yes — strongest: the "external isolation" story does **NOT** cover these |

**Consequences:**

- **The trust-tier matrix above is canonical.** Docs, specs, and any future
  admission code reference it as the source of truth; new extension surfaces must
  be added as a row before they ship.
- **Platform principle 2 must be reworded.** "A tool must not take down the
  platform" is re-scoped to **host-process stability**, not user-data
  confidentiality. Wherever the principle is stated as a security/isolation
  guarantee, it must say fault isolation, and must state that admitted tools run
  at full user privilege.
- **Wildcard `*` removal is an ADR-0030 amendment, not a free behavioral
  change.** The near-term action is to **deprecate + warn now** (a louder,
  per-invocation warning, not a once-logged line); behavioral removal of `*` is a
  later ADR-0030 amendment with its own migration note.
- **A NAMED decision is required on the user-global trusted-by-location tier** —
  whether to preserve it (a documented "this is your machine, you own it" tier)
  or change it to deny-by-default like the other external tiers. This ADR records
  that the decision is open and owed; it does not pre-decide it.
- **Doc-honesty corrections land via spec 01.** Specifically: split fault vs.
  capability isolation everywhere the isolation story is told; fix the
  attestation label (publish-side ships, consumption-side is the gap); correct
  the stale bootstrap module count (the assessment's "~59" is wrong; the count is
  ~60 production `.ts` files and drifts — spec 01 sets the precise value rather
  than hard-coding it); split crash
  semantics into catchable (ordinary throw/rejection — caught) vs. uncatchable
  (`process.exit`, segfault, OOM — genuinely fatal); and confirm/retire the stale
  ADR-0028 "live-runs-off-thread" enforcement text superseded by ADR-0058
  (`live-view-through-cli-live` only forbids ink `render` imports, not the
  off-thread selector).
- **The three implementation specs are
  `docs/plans/specs/arch-improvements/01..03`** (local-only; `docs/plans` is
  gitignored): 01 = posture/honesty corrections + the per-tier admission and
  wildcard-deprecation guards; 02 = subprocess execution model and the fork-cost
  investigation; 03 = the three-gate investigation (capability/permission +
  network, extension-contract versioning, consumption-side verification).
- **Follow-up ADRs are authored from the specs' investigation phases** (numbers
  TBD): a follow-up ADR for the **capability/permission model incl. network**
  (from spec 03), a follow-up ADR for **extension-contract versioning** (range
  semantics retiring exact-epoch; from spec 03), a follow-up ADR for
  **consumption-side verification + per-tool trust policy** (gate 3; from spec
  03 — may merge with the capability/permission ADR), and a follow-up ADR for
  **subprocess-all / bundled-subprocess default** with a fork-cost model (from
  spec 02). None of these are written now; the specs scope the investigation that
  produces them.
- **The public untrusted ecosystem stays CLOSED** until all three gates are
  green. Interim, external tools are documented as trusted/private extensions
  with the full-privilege caveat, and the in-process capability-pack surface is
  documented as the **least** isolated extension surface.

**Related specs / ADRs:** Implemented by
`docs/plans/specs/arch-improvements/01-trust-framing-and-cheap-hardening.md`,
`docs/plans/specs/arch-improvements/02-supervisor-and-execution-path-hardening.md`, and
`docs/plans/specs/arch-improvements/03-ecosystem-readiness.md`
(local-only). Builds on ADR-0030 (authored-tool discovery + trust tiers; this
ADR's wildcard-deprecation and the user-global tier decision are ADR-0030
amendments), ADR-0054 (external fault-isolation boundary + the supervisor
resource-control gaps named here), ADR-0028 (off-main-process live runs; its
enforcement text is stale, see spec 01), ADR-0058 (shared live-run shell that
superseded ADR-0028's guard), ADR-0036 (host-owned baseline plane), ADR-0051
(host-owned run timing), and ADR-0056 (architecture audit remediation).

**Extended by:** [ADR-0081](ADR-0081-capability-pack-trust-and-resource-declarations.md)
adds exact-name admission for non-bundled in-process capability packs and records
`opensipTools.requires` as declaration-only trust metadata.
