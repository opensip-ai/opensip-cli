---
status: current
last_verified: 2026-06-22
owner: opensip-cli
indexable: true
---

# Plan Improvements (opensip-cli)

## Background

These prompts run sequentially against a draft plan. Each phase mutates the
plan; each subsequent phase operates on the prior phase's output. The order is
deliberate — earlier phases reshape structure, later phases refine within that
structure. Do not reorder without understanding what each phase assumes about its
input.

**This is the opensip-cli pipeline — a curtailed sibling of the main opensip
platform pipeline.** opensip-cli is a **local-first, single-process, SQLite-backed
CLI** (a generic tool-plugin dispatcher hosting `fit`, `graph`, `sim`). It has no
Postgres, no tenants, no DBOS, no HTTP server, no distributed tracing, no audit
chain, and no auth/RBAC. The platform pipeline's phases for those concerns are
**removed here, not stubbed** — adding them back would inject vocabulary the
codebase does not have. What remains is curtailed to the invariants that actually
govern this repo (the layer DAG, `RunScope`, the documented `ToolCliContext`
seams, the host-owned baseline/ratchet plane, the dogfood fitness gate, and the
ADR log). Mapping from the 11-phase platform pipeline:

| opensip platform phase | opensip-cli treatment |
|------------------------|------------------------|
| 1 Structural Correctness | **Kept** (phase 1), integration surfaces re-pointed to CLI surfaces |
| 2 Architectural Compliance | **Adapted** (phase 2) — layer DAG, RunScope, seams, Result/errors, dogfood checks |
| 3 Data Layer & Tenant Isolation | **Replaced** (phase 3) — SQLite/Drizzle datastore; no tenants/RLS |
| 4 SOLID & GoF | **Kept** (phase 4) |
| 5 DRY / Package Reuse | **Adapted** (phase 5) — opensip-cli substrate map |
| 6 Observability Foundations + 7 Per-Op Instrumentation | **Merged & curtailed** (phase 6) — opt-in OTel, logger evts, session payloads |
| 8 Production Hardening + 9 Audit/Provenance | **Merged & curtailed** (phase 7) — input sanitization, resource bounds, plugin trust |
| 10 Tests & Validation Sweep | **Kept** (phase 8) — Vitest + dogfood, no lab-host services |
| 11 Architecture Docs & DECs | **Adapted** (phase 9) — docs/public + ADRs, ADR↔fitness-check pairing |

Nine phases total. A consumer (e.g. the `backend-plan` skill's autonomous chain)
should create one progress entry per phase **as listed in this file** (Phase 1
through Phase 9), not a fixed count inherited from the platform pipeline.

---

## Phase 1 Prompt — Plan Structural Correctness

Read the plan thoroughly and revise it into a logically structured,
implementation-ready document that an AI agent can execute without ambiguity.
Begin by validating and correcting the overall structure: ensure all phases and
steps are ordered by true dependency, that the sequence reflects how the system
should be built incrementally, and that every step is concrete and executable.
Vague or high-level instructions are not acceptable — replace them with specific,
named files, functions, and integration points.

Every phase must explicitly include a step to wire up the functionality it
introduces. Do not allow partially implemented or disconnected components — each
phase must result in working, integrated functionality. If a phase produces a
class, the same phase must show where it is constructed and what calls it.

Verify integration-surface completeness for any user-facing or cross-package
feature. In opensip-cli a feature that exposes new behavior typically needs work
in *all* of these surfaces, not just one:

- **Command registration** — a declarative `CommandSpec` (`@opensip-cli/core/tools/command-spec.ts`) added to the owning tool's `commandSpecs`, mounted by the host (`packages/cli/src/bootstrap/register-tools-mount.ts`). Tools never receive a raw Commander program.
- **Tool manifest** — for a new tool, a `package.json#opensipTools` manifest and registration in the bundled set (`packages/cli/src/bootstrap/bundled-manifest.ts`) or discovery as a third-party/authored tool.
- **Config schema** — a namespaced Zod schema contributed to the config composer (`@opensip-cli/config`, ADR-0023) if the feature reads project config.
- **Output contract** — results flow through the `SignalEnvelope` / `CommandResult` currency (ADR-0011 / ADR-0024) and the documented `ToolCliContext` seams (`render` / `emitJson` / `emitEnvelope` / `deliverSignals` / `writeSarif`), never raw `console.log` / `process.stdout`.
- **Baseline / SARIF** — if the feature emits gateable findings, they are fingerprint-stamped signals that inherit the host baseline/ratchet plane (ADR-0036); no per-tool baseline code.
- **Report data** — if the feature contributes to the HTML report, a `collectReportData` contribution consumed by the CLI-owned `report` composition root.

Plans frequently land one or two surfaces and silently leave the others
unimplemented — call this out and add the missing surfaces as explicit steps.

Add two distinct quality phases. First, a **tests phase** that defines new tests
and modifications to existing tests impacted by the changes. Second, a
**validation phase** that exercises the system end-to-end against the real built
CLI and a real (temp) SQLite datastore — including the dogfood gate where
relevant. Subsequent phases enrich both — this phase scaffolds them with
placeholder content.

Assume there are no backwards-compatibility requirements. Do not introduce
temporary fixes, adapters, compatibility layers, deprecated-then-supported code
paths, or feature flags for migration. (Forward-compatible *optional catalog
fields* — e.g. a new `FunctionOccurrence` field absent on older on-disk
catalogs — are not a compat shim; they are the documented persistence-evolution
pattern and are allowed.)

If persistence/migration, observability, hardening/trust, or specific
architectural-compliance issues are missing or unclear, do not solve them here.
Note them as gaps and let the dedicated downstream phases handle them.

Output a clean, well-structured plan with phases ordered by true dependency,
explicit implementation steps, enforced wiring in every phase, complete
integration-surface coverage, and scaffolded tests/validation phases.

---

## Phase 2 Prompt — opensip-cli Architectural Compliance

Read the revised plan and enforce opensip-cli's codebase-specific architectural
invariants. These are non-negotiable rules documented in `CLAUDE.md` and enforced
by dependency-cruiser + the dogfood fitness suite. The plan must respect them
before pattern decisions, deduplication, or instrumentation are applied —
non-compliant code becomes harder to fix once those passes run.

**Layering (the DAG).** Enforce the layer order
`core → contracts → (lang-* / fitness / simulation / graph / config / targeting) → checks-* → cli`.
Verify, phase by phase: `core` imports nothing upward (not contracts/cli/tools);
`contracts` imports no tool/cli; tools (`fitness`/`simulation`/`graph`) never
import `cli` (would cycle); check packs never import `cli` or `contracts`;
`lang-*` packs never import `cli`/`contracts`/tools/each-other. If a phase needs
to violate a layer rule, the correct move is to refactor the shared piece down
into `core` (or the lowest common tier) — surface that as an explicit step, never
a depcruise disable. dependency-cruiser (`pnpm lint`) is the gate.

**Per-run state on `RunScope` — no module singletons.** Per-invocation state
(logger, parse cache, tool/language registries, recipe config, project context,
lazy datastore thunk) lives on `RunScope` (`@opensip-cli/core/lib/run-scope.ts`).
Library code deep in the tree reads `currentScope()` (AsyncLocalStorage); tools
read `cli.scope.foo`. The plan must not reintroduce module-level mutable state or
the removed `defaultToolRegistry` / pre-scope holder. Registration is always
explicit — `defineX(...)` returns a value the caller registers; **no import-time
side effects.**

**Only documented `ToolCliContext` seams.** Tool and host-command handlers use
only the documented seams: `render`, `emitJson`, `emitEnvelope`, `deliverSignals`,
`writeSarif`, the baseline seams (`saveBaseline` / `compareBaseline` /
`exportBaselineSarif` / `exportBaselineFingerprints`), `toolState` (ADR-0042),
`hostPlanes` when present, and read-only `runSession.timing`. Direct
`process.stdout` for run output, `console.*` for run data, raw datastore from
action bodies, or any `SessionRepo` / `persist*Session` writer are forbidden
(enforced by ESLint `no-restricted-properties`/`-imports`, the
`only-documented-toolcli-seams` fitness check, and runtime guards). The
composition root (bootstrap, error/report seams, `buildToolCliContext`) is the
only exempt surface.

**Host-owned baseline/ratchet plane (ADR-0036).** A tool inherits capture
(`--gate-save`), the net-new ratchet (`--gate-compare`), and export (SARIF +
git-trackable JSON) by emitting fingerprint-stamped signals — it authors **at
most a `Tool.fingerprintStrategy`**. The plan must NOT add per-tool baseline
tables, diff logic, or a second ratchet. The plane never re-fingerprints; tools
stamp at envelope construction.

**Host-owned run timing.** `StoredSession.startedAt/completedAt/durationMs` are
produced by the host from a single `RunTimer`. A tool RETURNS a
`ToolSessionContribution` (the `session` field of a `ToolRunCompletion`); it never
owns the generic row, imports `SessionRepo`, or re-introduces a session writer.
Internal per-stage timers stay tool-owned in the payload/envelope.

**Errors & Result.** Public/tool-facing methods return `Result<T, E>` from
`@opensip-cli/core`; never throw a generic `Error` — use the kernel's typed
errors. Reserve `throw` for genuine infrastructure boundaries (fs, child_process,
SQLite/Drizzle, config/YAML parse) and never wrap an already-`Result`-returning
call in redundant `try/catch`.

**CLI output & logger event names.** Production code writes through the documented
output seams, never `console.log`. Logger events use `@opensip-cli/core/logger`
with an `evt` of three-or-more dot-separated parts in the form
`domain.component.action[.status]`.

**Tool storage contract (ADR-0042).** Tool-owned state is opaque keyed JSON in
`tool_state` (max ~1 MB payload); the host never reads tool vocabulary. Don't
invent a parallel persistence path.

**Dependency policy.** New/changed direct deps respect the frontier-toolchain
posture (Node ≥24, the repo's TS/ESLint/vitest majors) and add the minimum
necessary. A new runtime dependency on a new package must be justified explicitly;
prefer an existing workspace substrate (see Phase 5).

**Fitness-check additions (dogfood).** For every plan phase that establishes a new
structural invariant — a new layer/seam rule, a new persisted-field contract, a
new boundary the team will rely on — add a corresponding fitness check (the
appropriate `checks-*` pack, or a `graph` rule for graph-shaped invariants) so the
invariant cannot regress silently. opensip-cli dogfoods itself (`pnpm fit:ci`,
`pnpm graph --gate-save`); an invariant introduced without a check will erode.
Phase 9 reinforces this from the other side: every new ADR is paired with a
fitness-check evaluation.

Update the tests phase to cover the architectural assertions this phase
introduces (e.g. a test that a new fitness check fires on synthetic input via the
`@opensip-cli/test-support` fixture-coverage harness). Output the plan with each
architectural compliance issue named, its location identified, and the corrective
change specified inline.

---

## Phase 3 Prompt — Persistence & Datastore

Read the plan and ensure any persistence change receives the rigor it needs.
opensip-cli persists through **`@opensip-cli/datastore` — SQLite via Drizzle**
(with an in-memory backend for tests). There are no tenants, no RLS, no pgvector,
no migrations-against-a-running-Postgres; the failure modes are different but
still real (a malformed catalog payload is invisible until a downstream read; a
forgotten migration breaks a fresh install).

**Datastore ownership.** New persistence lands in the right host-owned plane,
never as a bespoke table inside a tool:

- **Baseline / ratchet** → the generic `tool_baseline_entries` + `tool_baseline_meta` pair (ADR-0036), keyed by a `tool` column. A tool contributes fingerprints, not schema.
- **Tool-owned state** → `tool_state` (ADR-0042) — opaque keyed JSON, ≤ ~1 MB, owned by the tool, never interpreted by the host.
- **Sessions** → `sessions` / `session_tool_payload` / `session_host_metrics` (owned by `@opensip-cli/session-store`); the per-session payload is opaque per-tool JSON.
- **Tool catalogs / derived data** (e.g. the graph `graph_catalog` row) → the tool's own datastore-backed repository, governed by the derived-data persistence policy (ADR-0006).

If the plan inlines a new SQLite table inside a tool package that duplicates one
of the host planes, revise it to use the host plane.

**Schema evolution.** Schema changes go through datastore migrations. Persisted
payloads (catalog JSON, session payloads) must remain **forward-compatible**:
prefer optional fields with documented "absent ⇒ <default behavior>" semantics
(the `FunctionOccurrence.bodySize?` precedent) over breaking the on-disk shape.
Baselines are drop-and-recapture (CI-ephemeral) — a schema change that drops local
baseline rows is acceptable and must be called out (re-run `--gate-save`); the
committed JSON fingerprint baseline is a separate file artifact.

**Opacity boundary.** The host datastore plane holds zero tool vocabulary. A tool
must not push typed columns the host would have to understand; serialize into the
opaque payload. Conversely a tool must not reach into another tool's payload.

**Performance & bounds.** Reads happen on every CLI invocation — keep payloads
bounded and lookups O(occurrences-per-file) rather than O(catalog). Honor the
repo's `unbounded-memory` / `batch-operation-limits` checks; large in-memory
structures built during a build must be bounded or streamed.

Update the tests phase to cover persistence: a migration applies cleanly against a
fresh in-memory datastore; a round-trip write/read of any new payload preserves
shape; a pre-feature payload (missing the new optional field) still loads.
Output the plan with each persistence change assigned to the correct host plane or
tool repository, the schema-evolution strategy stated, and the opacity boundary
respected.

---

## Phase 4 Prompt — Software Patterns: SOLID & Gang of Four

Read the plan and evaluate whether SOLID principles and Gang of Four design
patterns are applied correctly, appropriately, and consistently. The goal is
correctness of usage — not maximization of pattern coverage. Patterns are tools
to manage complexity that already exists; they are not aesthetic improvements to
apply preemptively.

For every class, module, or interface introduced or modified by the plan,
identify concrete violations: overly coupled classes that share state through
globals or singletons (in this repo, the smell is reaching for module-level state
instead of `RunScope`), unclear responsibility boundaries (a class doing two
unrelated things), misuse of inheritance where composition would be clearer, leaky
abstractions that force callers to know implementation details, brittle
conditional chains that branch on a type tag and should be polymorphic, and
unnecessary pattern complexity (a Strategy with one strategy, a Factory that
always returns the same concrete type). Each violation must be paired with a
concrete fix — name the file, the class, and the corrected shape.

As a secondary goal, identify high-value opportunities to introduce a pattern
*only* where it would materially reduce coupling or eliminate a real source of
branching. Apply this codebase's narrow-port rule (CLAUDE.md — "if you need to
violate a layer rule, refactor the shared piece into core; one-implementer
interfaces are justified by a real benefit"): a new interface, abstract base, or
pattern scaffold is justified only by a named test seam or a named compile-time
invariant (e.g. the `GraphReadPort` that exists to make the embedded/SaaS storage
backends swappable and to fake the catalog in tests). Speculative framings
("future extensibility", "could grow into…") are forbidden — remove them and use
the concrete class directly until a real second consumer or test fixture appears.

Be especially skeptical of: new Strategy/Factory/Adapter scaffolding around code
with one production caller; abstract base classes used to share a constructor or
one helper (prefer composition or a free function); event-emitter indirection
added "for decoupling" within a single command's lifecycle; deep inheritance in
domain models. Be receptive to: replacing long if/else-on-string-tag chains with
polymorphism when the tag set is closed and stable (the graph `Rule` registry and
the `LanguageAdapter` contract are the canonical good examples); extracting a clear
port at a real boundary (datastore, graph read surface, language adapter) where a
fake already substitutes in tests.

Update the tests phase to cover any new test seams introduced by pattern changes.
Output the plan with each pattern decision documented in-line: for fixes, name the
violation and the corrective change; for new patterns, name the consumer benefit
(test seam or compile-time invariant) that justifies them.

---

## Phase 5 Prompt — DRY: Package Reuse Without Premature Abstraction

Read the plan and enforce DRY at two levels: **package-level reuse** (does an
existing opensip-cli package already provide this capability?) and **code-level
deduplication** (within or across packages, is the same concept expressed twice?).
Package-level reuse is the higher-leverage check — reinventing a capability that
already lives in `packages/` produces duplicate code paths that diverge silently.

**Package reuse audit.** Before the plan introduces any new abstraction, audit
whether the codebase already provides it. The mapping for common needs:

- Parsing / ASTs → `@opensip-cli/tree-sitter` (grammar-agnostic substrate) and the `@opensip-cli/lang-*` adapters. For TS-AST work prefer the canonical helpers from `@opensip-cli/lang-typescript` (`getSharedSourceFile`, `walkNodes`, `findEnclosingFunction`, comment/string strippers) over reinventing them.
- Body normalization / hashing → `packages/graph/engine/src/lang-adapter/body-digest.ts` (`normalizeWhitespace`, `hashBody`) — the single canonicalization site.
- Graph reads (catalog, callers/callees, indexes, blast) → `@opensip-cli/graph` (internal surface, ADR-0009) — never re-parse to recompute what the catalog holds.
- File targeting / globbing → `@opensip-cli/targeting` (`TargetRegistry`, `resolveTargets`, `applyGlobalExcludes`, ADR-0037) — never hand-roll glob walking.
- Config load + schema → `@opensip-cli/config` (composer + namespaced Zod registry, ADR-0023).
- Machine output / formatting → `@opensip-cli/output` (json / sarif / table formatters + delivery sink). Tools never import it; the composition root does.
- Persistence → `@opensip-cli/datastore`; sessions → `@opensip-cli/session-store`.
- Terminal UI primitives → `@opensip-cli/cli-ui` (Ink/React kit).
- IDs, logger, errors, retry, registries, `RunScope`, the Tool contract, language-adapter loader → `@opensip-cli/core`.
- Cross-package test scaffolding → `@opensip-cli/test-support` (PRIVATE, ADR-0040 — test files only).

If the plan introduces functionality any of these provide, revise it to reuse or
extend the existing package. A parallel implementation is a regression and must be
rejected.

**Code-level deduplication.** Apply the rule of three: two occurrences are
coincidence; wait for a third (or a documented imminent third caller) before
extracting. The shared concept must be genuinely the same concept, not just the
same shape.

**Tier placement for extracted code.** Extracted helpers live in the lowest tier
all callers already depend on; never introduce a new upward dependency to host a
shared helper. `core` stays domain-agnostic — a helper carrying tool vocabulary
belongs in the relevant tool, not `core`. If two `lang-*` packs would both need a
helper, it belongs in `@opensip-cli/tree-sitter` or `core` (lang packs must not
import each other). If two tools would both depend on a new helper, that is a
signal it belongs in `core`/`contracts`.

**Do not collapse:** per-tool config slices (each tool's namespace is
intentionally separate); per-package logger `evt` namespaces; textually similar
test fixtures across packages (test isolation outweighs DRY for fixtures).

Update the tests phase to cover newly extracted shared code (test the helper once,
not at every call site). Output the plan with: every existing-package opportunity
identified by package name and the function/class to reuse; every code-level
extraction concretely specified (source files, target file, exported symbol, tier
placement); every extraction backed by ≥3 concrete current callers.

---

## Phase 6 Prompt — Observability & Instrumentation

Read the plan and decide how the feature is observed. opensip-cli is a
short-lived, single-process CLI: there is **no always-on collector, no distributed
tracing, no correlation-ID plumbing, no profiling server, and no durable
state-machine to persist** (no DBOS). Observability here is three things —
**opt-in OpenTelemetry, structured logger events, and the session record** —
applied with restraint so a one-shot command stays fast and quiet by default.

**Opt-in OpenTelemetry (ADR-0004).** Telemetry is OFF by default and must never
require a running backend to function. If the feature has a meaningful
duration/throughput worth measuring, record it via the existing meter
(`getMeter('opensip-cli')`, e.g. the `opensip_cli.command.duration_ms` histogram
pattern). New instruments follow that naming shape and **bounded-cardinality
labels — never file paths, symbol names, or IDs as labels** (use enumerated tags
like `command`, `tool`, `outcome`). Recording is fire-and-forget; no error
handling, no behavior change when telemetry is disabled.

**Structured logging.** Log at decision points (command entry, dispatch, error,
terminal) via `@opensip-cli/core/logger` — not at every internal step. Each event
carries an `evt` of three-or-more dot-separated parts
(`domain.component.action[.status]`) and routes to the logger sink, never stdout
(which is reserved for run output through the documented seams). Messages that
embed user-supplied content (file contents, paths) must not leak secrets — see
Phase 7.

**Session record (the durable artifact).** The run's outcome is persisted as a
`StoredSession` by the host (Phase 3). The feature contributes a
`ToolSessionContribution` (`tool`/`cwd`/`recipe?`/`score`/`passed`/`payload?`) and
nothing else — timing is host-owned. Per-stage diagnostics belong in the opaque
payload or the `SignalEnvelope`, never in the generic session columns. Host-side
overhead (render/persist/egress) is the host's `StoredSessionHostMetrics`, not the
tool's concern.

**Restraint.** Do not add spans/metrics to pure I/O wrappers, boot paths, or test
fixtures. A new metric must answer a question the session record and logs cannot.

Update the tests phase to assert observability outputs where they are load-bearing:
the session contribution has the expected shape; a new metric records with the
expected labels (via an in-memory meter/exporter); logger events fire with the
expected `evt` names. Output the plan with each measurement point named
(file:function), each metric's name + labels stated, each log event named, and a
one-line justification for anything beyond the session record.

---

## Phase 7 Prompt — Hardening & Trust

Read the plan and enforce the operational concerns that determine whether a
feature is safe to run on a developer's machine and in CI. opensip-cli is a local
analysis CLI, not a network service — so this phase is **input safety, resource
bounds, secret hygiene, and plugin trust**, not auth/RBAC/rate-limiting/audit
chains (those platform concerns do not exist here and must not be invented).

**Input sanitization at boundaries.** Every input that crosses from the outside
(CLI args, `opensip-cli.config.yml`, target globs, file paths, a third-party
plugin's declared paths, and — for any server-style feature such as the MCP tool —
request arguments) is validated before it reaches analysis code. Path inputs are
resolved and constrained (no traversal outside the project root where that is the
contract); globs route through `@opensip-cli/targeting` with `globalExcludes`
applied; config is validated by its Zod schema (unknown keys rejected within a
tool's strict block). Validation happens at the boundary, never cargo-culted
inline in domain code.

**Resource bounds.** New code must satisfy — not suppress — the repo's own safety
checks: `unbounded-memory`, `batch-operation-limits`, `detached-promises`,
`toctou-race-condition`, `error-handling-quality`. A build/analysis pass over a
large repo must bound its in-memory structures (the graph engine's sharded-worker
pattern is the precedent for very large inputs). Any `@fitness-ignore` of a
*safety* check in new code requires an inline rationale and is a red flag the
phase must justify or remove.

**Secret hygiene.** Logs and persisted payloads never contain raw file contents
that may carry secrets, and never contain the stored API key (managed by
`opensip configure`). Error messages that wrap external output are truncated and
scrubbed before they reach the logger or a persisted session payload.

**Plugin trust & provenance (ADR-0041).** If the feature adds or changes a tool
package, respect the admission posture: **bundled first-party tools fail closed**
(a missing/incompatible manifest or a runtime that won't load aborts the run, never
a silent skip); installed/authored tools skip with diagnostics. Registration
records `ToolProvenance` (`bundled` / `installed` / `authored`) surfaced by
`plugin list`. External handler execution isolation is opt-in
(`OPENSIP_CLI_EXTERNAL_WORKER`); a feature that runs untrusted plugin code at host
privilege must say so. Do not honor a `'*'` trust wildcard.

**Outbound calls (only if present).** opensip-cli is local-by-default; the one
outbound surface is optional OpenSIP Cloud sync via the `@opensip-cli/output`
delivery sink (entitlement-gated). If the feature adds outbound I/O, route it
through that sink with a bounded timeout and a clear failure mode — never a bespoke
fetch loop — and keep it opt-in. No SSRF/rate-limit/security-header machinery
applies unless the feature genuinely opens a network surface, in which case state
it explicitly.

Update the tests phase to cover hardening: malformed/hostile input is rejected at
the boundary (path traversal, oversized config, bad globs); resource bounds hold
on a large synthetic input; a bundled-tool admission failure aborts rather than
silently skips; secrets never appear in a captured log/payload. Output the plan
with each concern addressed per surface: inputs validated, bounds enforced,
secrets scrubbed, plugin admission posture stated, outbound I/O (if any) routed
through the sink.

---

## Phase 8 Prompt — Tests & Validation Coherence Sweep

Read the plan and run a final coherence pass on the tests phase and the validation
phase. By this point every prior phase has added test obligations (architectural
assertions, persistence round-trips, pattern test seams, shared-helper coverage,
observability emissions, hardening assertions). This phase ensures the tests phase
coherently covers all of them, the validation phase exercises them end-to-end
against the real built CLI, and no obligation has been silently dropped.

Verify test coverage by category. **Unit tests** (Vitest, `*.test.ts` beside the
source): every new domain class/function has tests for its public surface;
`Result`-returning methods tested in both ok and err paths; pure helpers (graph
traversal, signature math, freshness) tested directly. **Fitness/rule tests**: any
new fitness check or graph rule from Phase 2 has a test with synthetic input
exercising both pass and fail cases — use the `@opensip-cli/test-support`
fixture-coverage harness where applicable. **Persistence tests**: migrations apply
against a fresh in-memory datastore; payload round-trips preserve shape;
pre-feature payloads (missing new optional fields) still load. **Scope tests**:
code that reads `currentScope()` is wrapped in `runWithScope(new RunScope({...}))`
per the CLAUDE.md test pattern — never left to rely on ambient state.
**Observability tests**: session contributions, new metrics (in-memory meter), and
logger `evt` names asserted where load-bearing. **Hardening tests**: boundary
rejection of hostile input, resource bounds, admission failure, secret scrubbing.

Verify the validation phase exercises the **real built CLI**, not mocks. The
canonical opensip-cli validation surfaces are: building the workspace
(`pnpm build`) and running the actual binary against a fixture project; the
**dogfood gate** (`pnpm fit` / `pnpm graph --gate-save`) where the feature affects
analysis output; and a real (temp/in-memory) SQLite datastore round-trip. There is
**no lab-host Postgres/OTel/Redis** — do not import platform infrastructure into
the validation phase. Validation should fail loudly if a prerequisite (a built
`dist/`, a fixture) is missing, never skip silently.

Confirm there are no tests on code paths the plan removed, no missing tests on
paths it added, no orphaned fixtures, and no `.skip(...)` / `.todo(...)` left as
load-bearing. Confirm the per-task verification standard
(`pnpm build && pnpm typecheck && pnpm test`, and `pnpm lint` before completion)
is present. Output the plan with the tests phase reorganized so each prior phase's
contribution is clearly grouped, and the validation phase enumerating the real
surfaces it exercises and the end-to-end flows it covers.

---

## Phase 9 Prompt — Architecture Docs & Decision Records

Read the finalized plan and add a closing phase that synchronizes project
documentation with the architectural changes the plan introduces. This phase runs
last so docs reflect the as-built system, not the as-designed plan. Undocumented
architectural shifts become invisible technical debt.

**Reader-facing docs.** For every phase that changes a user-visible surface (a new
command, a new graph rule, a new config key, a new tool), update the hand-edited
source under `docs/public/` (the numbered Diátaxis-ish sections — e.g.
`40-graph/`, `70-reference/`), then regenerate `docs/web-generated/` with
`pnpm docs:build` and include it in the same change (CI's `pnpm docs:check` is the
staleness gate). Contributor-only or cross-repo-consumer context that does not
belong on the website goes in `docs/internal/`. Each updated doc reflects the
*post-plan* state — the diff lives in git history.

**Decision records (ADRs).** For every phase that makes a load-bearing decision —
choosing one of several viable approaches, accepting a tradeoff, depending on an
internal-only surface (ADR-0009), evolving the catalog/persistence shape, adding a
new tool or seam — add a new `docs/decisions/ADR-NNNN-*.md` from
`docs/decisions/TEMPLATE.md` (sequential numbering; the log is **append-only** —
supersede via a new ADR, never rewrite). An ADR requires: context (what forced the
choice), options considered (≥2), the choice, and consequences (what gets easier,
what gets harder). Cite a parent opensip platform decision via
`related: [DEC-NNN]` when relevant. Mechanical changes (rename, file split, test
addition) are not decisions and need no ADR.

**Pair every new ADR with a fitness-check evaluation.** An ADR captures rationale;
a fitness check captures enforcement. For each ADR the plan introduces, record the
evaluation under the ADR entry (and the originating phase) in one of two forms:

- **"Check warranted"** — name the check by file path (the appropriate
  `packages/fitness/checks-*` pack, or a `graph` rule under
  `packages/graph/engine/src/rules/` for graph-shaped invariants), describe the
  invariant in one sentence, and ensure a step exists to author it. Keep the ADR,
  the implementation, and the check co-located in the originating phase. The ADR
  references the check by name; the check's source references the ADR number in a
  top-of-file comment.
- **"No check warranted"** — record the rationale in one sentence. Acceptable:
  the decision is non-structural (a library/ergonomics choice); the invariant is
  already enforced by the type system or by dependency-cruiser; the decision is
  one-shot with no recurrence surface. Unacceptable: "we'll add it later", "the
  team will remember", "it's obvious."

The evaluation outcome is part of the ADR — record it in a "Fitness check" line. An
ADR without that line is incomplete.

**Cross-reference.** Each new ADR is linked from the doc that embodies it; each
plan phase that produced an ADR references it by number so the plan stays
traceable after it archives to `docs/plans/completed/`. If the plan supersedes an
existing ADR, mark the old one "Superseded by ADR-NNNN" inline rather than
deleting it. Use stable relative paths so cross-references survive the archival
move.

Output the updated plan with a final documentation phase enumerating: every
`docs/public/` (and regenerated `docs/web-generated/`) and `docs/internal/` doc to
create or update by path; every new ADR by number, title, one-line summary, and
its fitness-check evaluation outcome; every fitness check the ADR pairing
produced (by file path and originating phase); every existing ADR to mark
superseded; and the cross-references to insert. The phase runs after all
implementation, testing, and validation phases.
