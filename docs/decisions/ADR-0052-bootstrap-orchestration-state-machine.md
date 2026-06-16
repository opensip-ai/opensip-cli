---
status: active
last_verified: 2026-06-16
owner: opensip-cli
---

# ADR-0052: Bootstrap Orchestration State Machine

```yaml
id: ADR-0052
title: Bootstrap Orchestration State Machine
date: 2026-06-16
status: active
supersedes: []
superseded_by: null
related: [ADR-0024, ADR-0030, ADR-0051]
tags: [cli, bootstrap, run-scope, testing, architecture]
enforcement: partially-mechanizable
enforcement-reason: >
  The ordered bootstrap phases can be unit-tested through a pure planner and
  table-driven hook tests. The architectural intent remains enforced by the
  no-module-singleton, only-documented-toolcli-seams, and env-via-registry checks.
```

**Decision:** Commander remains the integration boundary, but the logic currently
sequenced inside `packages/cli/src/bootstrap/pre-action-hook.ts` must be modeled
as an explicit bootstrap state machine before further orchestration changes land.
The hook may stay as the imperative adapter to Commander; phase decisions and
their side-effect gates belong in testable functions with ordered transition
names.

The state machine has these phases:

1. `read-command-options` — read Commander options and compute `cwd`,
   `cwdExplicit`, and `runId`; no project or datastore side effects.
2. `merge-cli-defaults` — load and merge the host `cli:` defaults; throws only
   configuration errors.
3. `resolve-project` — resolve `ProjectContext`; strict `--config` misses become
   `BootstrapError` exit 2.
4. `bailout-window` — run schema-version, no-project, and phantom-runtime checks.
   No logger file, datastore, scope entry, metrics, profiling, update nag, or
   tool initialization may happen before this phase completes.
5. `project-side-effects` — initialize project-scoped logging only when
   `project.scope === 'project'` and the project root exists.
6. `build-scope` — construct `RunScope` through `buildPerRunScope` with explicit
   registries, manifests, provenance, CLI defaults, and UI/update state.
7. `enter-scope` — bind `RunScope` via AsyncLocalStorage and assert
   `currentScope()` is present.
8. `host-start-effects` — diagnostics, metrics, structured start log, optional
   profiling.
9. `tool-preflight` — lazy `Tool.initialize()` and owning-tool capability loading.
10. `dispose` — `postAction` calls `disposeCurrentScope`; fatal parse/bootstrap
    paths should call the same idempotent seam when a scope was entered.

**Implementation spec:**

- Extract a `planPreActionBootstrap(...)` or equivalent pure planner from
  `pre-action-hook.ts`. It returns the phase inputs and bailout outcome without
  entering a scope or mutating the logger.
- Keep `buildPerRunScope(...)` as the only scope-construction function. It must
  reject conflicting tool `contributeScope()` slots before installing them.
- Keep `disposeCurrentScope()` as the public disposal seam for `postAction` and
  future fatal-path coverage. It must remain idempotent.
- Add table-driven tests for phase ordering: schema-version bailout,
  no-project bailout, agnostic command pass-through, strict config miss, and
  normal project run. The tests should assert "not called before bailout" for
  logger file init, `buildPerRunScope`, `enterScope`, `maybeInitializeOwningTool`,
  and capability loading.
- Do not split the hook into many side-effecting modules until the planner tests
  exist. Moving code first makes the ordering harder to audit.

**Alternatives:**

- Leave `pre-action-hook.ts` as the single audited sequencer (rejected as the
  long-term endpoint: it is easy to read in one file, but regressions in bailout
  order are too subtle and currently rely on indirect integration tests).
- Split immediately into phase modules without a state-machine contract
  (rejected: it lowers file length but hides the load-bearing ordering).
- Move bootstrap ownership into each tool command (rejected: it breaks the
  host-owned lifecycle model in ADR-0051 and would duplicate project/scope
  behavior per tool).

**Rationale:** The present one-file sequencer is defensible because Commander
only offers `preAction` / `postAction`, and the "no side effects before bailouts"
rule is easier to audit when it is linear. That same concentration makes it a
high-blast-radius file. A small state machine preserves the auditability while
making ordering executable in unit tests.

**Consequences:**

- Future changes to project resolution, logger setup, scope entry, metrics, or
  tool initialization must name the phase they change.
- New bootstrap tests should prefer the planner and `disposeCurrentScope()` seam
  over full Commander integration unless the behavior depends on Commander.
- `pre-action-hook.ts` may keep its cognitive-complexity waiver while it is the
  Commander adapter, but the business rules should migrate behind phase helpers.

