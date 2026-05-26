# Dogfood: candidate fitness checks from `opensip-ai/opensip/opensip-tools`

Source: `/Users/sb/Documents/Code/opensip-ai/opensip/opensip-tools/fit/src/checks/`

That repo's `fit/src/checks/` contains 319 check source files across six
categories. Most are domain-specific to that product (tenant isolation,
billing, audit chains, DBOS workflows, code-graph substrate). This file
classifies the remainder by portability into this codebase.

## Strong portability — port these

| Check | Source | Target pack | Effort | Notes |
|---|---|---|---|---|
| `testing-no-focused-tests` | `testing/no-focused-tests.ts` | `checks-typescript` | Direct port | Flags `describe.only`, `it.only`, `test.only`, `fit(`, `fdescribe(` in test files. Universally useful. |
| `quality-no-console-log` | `quality/no-console-log.ts` | `checks-typescript` | Adapt | Retarget allowlist: `packages/core/src/lib/logger.ts` + cli-ui Ink components. Flag everywhere else. |
| `quality-log-event-name-shape` | `quality/log-event-name-shape.ts` | `checks-typescript` | Direct port | This codebase already follows `evt: 'domain.component.action'` convention per CLAUDE.md. |
| `arch-callback-invocation-safe` | `architecture/arch-callback-invocation-safe.ts` | `checks-typescript` | Direct port | Generic resiliency: callbacks iterated from producer code must be wrapped in `safeXxx`. We have callback-iteration loops in plugin discovery and fitness execution. |
| `arch-cli-realpath-validation` | `architecture/arch-cli-realpath-validation.ts` | `checks-typescript` | Adapt | Retarget allowlist: `packages/cli/src/` and `packages/core/src/plugins/`. We already use `isPathInside` (`realpathSync` + containment) — this check is the regression gate. |

## Worth porting once the prerequisite lands

| Check | Source | Prerequisite |
|---|---|---|
| `security/subprocess-no-argv-secret` | `security/subprocess-no-argv-secret.ts` | Audit our `execFileSync` calls (npm install/uninstall in `plugin.ts`) — confirm no secrets pass via argv, then add this as the regression gate. |
| `foundation/foundation-tier-no-io` | `foundation/foundation-tier-no-io.ts` | We have depcruise enforcing layers; this duplicates the gate at fitness-check granularity. Useful as a belt-and-braces complement once we have an OTel/metrics tier. |
| `arch-canonical-iso-timestamp-default` | `architecture/arch-canonical-iso-timestamp-default.ts` | Codify a date-handling convention in CLAUDE.md first. |
| `arch-evt-must-be-string-literal` | `architecture/arch-evt-must-be-string-literal.ts` | Pairs with `quality-log-event-name-shape` — port both together. |

## Skip — not applicable

- Anything containing `tenant`, `billing`, `audit-jsonb`, `dbos-step`, `assessment-runner`, `code-graph-substrate`, `enrichment-*`, `decision-*`, `bundle-lifecycle`, `cost-registry`, `default-tenant`, `composition-root-via-module-register` (specific to that product's `register()` shape) — domain-specific to that codebase.
- `foundation/error-code-naming` and `error-code-shape` — that repo enforces 3+ segment `DOMAIN.COMPONENT.ACTION` codes. This codebase uses a different convention (`VALIDATION_ERROR`, `NOT_FOUND`, with optional dotted subcodes via `ToolErrorOptions.code`). Different shape; don't force it.
- `meta/package-health` — checks only the fit-checks plugin's own package.json. We can add an opensip-tools equivalent later if we decide we need it.
- `quality/docs-freshness` — shells out to git and ages docs by line-changes since a `last_verified` frontmatter date. Heavy and requires every doc to have frontmatter we don't currently use. Defer.
- `quality/drizzle-table-single-declaration` — single-schema codebase; check would have nothing to flag.
- `quality/invariants-drift` and `quality/error-message-redacted-before-persistence` — depend on conventions that codebase has but we don't.
- All `*-logger-prefix.ts` checks — bind specific log-prefix conventions to specific service paths (e.g. `arch-billing-ops-logger-prefix`). We don't have services in that sense.

## Implementation plan

1. **Phase 1** (this PR): port the 5 strong candidates into `@opensip-tools/checks-typescript`. Each one is ~80–150 lines including its test. Total: ~700 lines of code + tests.
2. **Phase 2** (separate PR): audit our `execFileSync` argv for secrets, then port `subprocess-no-argv-secret`.
3. **Phase 3** (separate PR, post-OTel): port the observability-tier checks if/when we add OTel instrumentation.

UUIDs must be regenerated per check (the source UUIDs are owned by the
other repo's registry).
