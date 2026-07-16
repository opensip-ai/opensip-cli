---
status: active
last_verified: 2026-07-12
owner: opensip-cli
---

# ADR-0155: Reserve A Canonical Audit Command

```yaml
id: ADR-0155
title: Reserve a canonical audit command
date: 2026-07-12
status: active
supersedes: []
superseded_by: null
related: [ADR-0093, ADR-0111, ADR-0129, ADR-0143, ADR-0159]
tags: [suite, agents, audit, cli, report]
enforcement: mechanizable
enforced-by: ['script:audit-command.test.ts', 'script:audit-command-contract.test.ts', 'script:suite-command-specs.test.ts', 'script:command-surface-parity.snapshot.test.ts', 'script:run-ledger-persist.test.ts', 'depcruise:cli-no-static-tool-package-import', 'depcruise:graph-no-cli']
enforcement-reason: >
  Command-surface, source-ownership, executor-parity, and ledger tests enforce
  the two local entry points. Existing dependency and session gates enforce the
  package boundary, so a new fitness check would duplicate narrower tests.
```

**Decision:** Reserve the host-owned top-level `opensip audit` command for the
curated built-in audit definition. It and `opensip suite run audit` share one
option definition, suite-command executor, orchestrator, output policy, Run
ledger, child-session plane, and exit policy; `audit` is not a Tool and is not a
general root alias for configured suites.

The two spellings intentionally differ only in how the suite name is resolved at
the call site: top-level `audit` supplies the built-in definition directly;
generic `suite run audit` uses normal suite resolution. **Amendment
(ADR-0159):** a configured `suites.audit` is no longer representable — the suite
name is reserved — so both spellings always execute the same curated built-in
definition. This prevents project configuration from silently replacing the
stable first-use and agent workflow while preserving the extensible suite plane
for non-reserved names.

**Alternatives:**

- **Mount every configured suite as a root command.** Rejected because names can
  collide with host and Tool commands, configuration would mutate the public
  command surface, and agents could not rely on stable command semantics.
- **Implement audit with a second orchestrator or synthetic Commander argv.**
  Rejected because option, output, persistence, and exit behavior would drift;
  Commander recursion would also re-enter host lifecycle hooks.
- **Keep only `opensip suite run audit`.** Rejected after the shared executor
  made a memorable root entry possible without bypassing the suite plane.
- **Let `suites.audit` replace the root command.** Rejected because a repository
  could silently redefine a canonical safety workflow. Configured workflows
  remain explicit through `suite run <name>`.

**Rationale:** Audit is the primary first-value path for humans and coding
agents, but its value comes from existing suite guarantees: one resolved scope,
serial command-spec dispatch, full signal envelopes, a host-built review brief,
and durable parent/step evidence. `executeSuiteCommand` is the single concrete
execution function used by both public entry points. `SUITE_RUN_OPTIONS` is the
single option descriptor list. The root command supplies the built-in resolved
definition directly; the generic form uses normal configured/built-in
resolution.

**Consequences:**

- `opensip audit` defaults to changed scope where Git resolution is trustworthy,
  falls back explicitly to full scope when necessary, and accepts `--changed`,
  `--since`, repeatable `--files`, `--full`, `--config`, and the shared host
  output flags.
- A successful machine result is the ordinary `SuiteRunResult`. Its `runId` is
  the authoritative persisted parent Run ID when persistence succeeded and is
  absent when persistence was unavailable; `suiteRunId` remains legacy
  correlation identity.
- `--open` is best-effort human presentation. JSON, CI, non-TTY, and remote-shell
  suppression never launch a browser, and report failure never changes the
  completed audit verdict or exit code.
- `suite run <name>` remains the general configured multi-tool workflow for
  non-reserved suite names. ~~A configured `suites.audit` affects
  `suite run audit`, never top-level `audit`.~~ **Superseded by
  [ADR-0159](ADR-0159-reserved-host-command-and-suite-names.md):** the name
  `audit` is reserved; both spellings always run the built-in definition.
- A Tool that declares `audit` as a root command or root alias (or declares a
  child under that root) is rejected after discovery and before runtime inventory
  or Commander mounting. The canonical host command remains available and
  unshadowed.
- Synthetic argv, Commander recursion, and another suite orchestrator are
  architectural regressions.
- `--open` on top-level `audit` and on `suite run audit` opens the Change Impact
  report for the completed parent run when browser launch is allowed; other
  suites open the ordinary report without a closed Change Impact selection.

**Related specs / ADRs:** Partially amends
[ADR-0111](ADR-0111-built-in-audit-suite-preset.md) and
[ADR-0143](ADR-0143-host-owned-run-step-ledger.md). Suite-name reservation is
ratified by [ADR-0159](ADR-0159-reserved-host-command-and-suite-names.md). Scope
semantics remain in [ADR-0129](ADR-0129-audit-suite-scope-defaults.md); the suite
plane remains in [ADR-0093](ADR-0093-host-owned-suite-plane.md). Implementation
specification: `docs/plans/specs/visual-proof-of-change.md` (local, gitignored).
