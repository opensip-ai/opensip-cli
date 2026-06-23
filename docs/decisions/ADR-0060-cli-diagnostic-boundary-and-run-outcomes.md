---
status: active
last_verified: 2026-06-23
owner: opensip-cli
---

# ADR-0060: CLI Diagnostic Boundary and Run Outcomes

```yaml
id: ADR-0060
title: CLI Diagnostic Boundary and Run Outcomes
date: 2026-06-23
status: active
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0024, ADR-0035, ADR-0051, ADR-0052, ADR-0053, ADR-0054, ADR-0059]
tags: [cli, diagnostics, tools, bootstrap, outcomes, plugins]
enforcement: not-mechanizable
enforcement-reason: >
  The decision spans CLI runtime behavior, JSON output, live rendering,
  bootstrap discovery, session persistence, and CI guardrails. The companion
  spec must add focused tests and fitness checks for the mechanizable pieces:
  no loader/discovery direct stderr, command-error JSON shape, fail-closed empty
  fitness registry, command-scoped bootstrap diagnostics, and injected workspace
  copy freshness.
```

**Decision:** The CLI host owns user-facing diagnostic presentation and command
outcome classification. Setup failures that prevent a credible scan produce a
typed command-error outcome outside the findings `SignalEnvelope`; only credible
scan runs produce findings envelopes with `passed`, `failed`, or strict
`degraded` outcomes.

**Alternatives:**

- Keep representing setup faults as `runFaulted` inside a normal findings
  envelope. Rejected because it renders contradictory summaries such as
  `FAIL (0 Errors, 0 Warnings)` and keeps overloading findings counts with run
  health.
- Treat every loader/discovery problem as a warning string printed directly to
  `stderr`. Rejected because it leaks absolute paths, corrupts live views, and
  gives each subsystem its own user-facing output style.
- Make discovery fully lazy by selected command. Rejected as the only approach
  because the host still needs static command surfaces before Commander can
  parse and dispatch commands.
- Use package names as general tool identity. Rejected because package names are
  distribution coordinates; stable ids and provenance remain the durable identity
  model. Package-name filtering is allowed only as a narrow prefilter for known
  bundled packages rediscovered as installed workspace copies.
- Classify stale bundled or first-party injected package copies as user
  configuration errors. Rejected because the user config is not the fault; this
  is an install/build integrity failure and must say so.

**Rationale:** The 2026-06-23 diagnostic-boundary incident exposed one pnpm
injection snapshot trigger and three independent architectural defects. A stale
injected `@opensip-cli/core` copy was missing `dist/tools/identity.js`, causing
plugin and fit-pack loading failures that dumped raw Node module-resolution
messages to the CLI. A stale injected `@opensip-cli/fitness` manifest still used
the pre-identity shape and was rejected during global installed-tool discovery,
so a `fitness` diagnostic appeared while running unrelated commands such as
`graph`. The fitness run could also report a failed findings summary with zero
findings, and the same class can become a green empty run when only check-pack
loading fails.

Existing decisions already provide most primitives. ADR-0011 makes
`SignalEnvelope` the findings transport, not a generic command-failure envelope.
ADR-0024 defines command outcomes and observability. ADR-0035 makes the host own
the findings verdict. ADR-0051 makes the host own run timing and persistence.
ADR-0052 centralizes bootstrap sequencing. ADR-0053 provides per-run logs.
ADR-0054 isolates external tool runtime faults. ADR-0059 makes tool identity
single-source. This ADR connects those primitives: command/run health must be
classified before findings rendering, diagnostics must cross host seams as
typed data, and unrelated bootstrap health must not leak into a selected
command's normal output.

**Consequences:**

- Loaders, discovery, capability registration, and tool engines must return typed
  diagnostics or typed errors to the host; they must not write user-facing
  diagnostic lines directly to `stderr`.
- The host renders diagnostics through one standard human format and one standard
  JSON shape, with detailed raw errors written to structured logs and referenced
  by run id or log path.
- A setup failure before a credible scan emits a command-error outcome and no
  findings envelope. Examples: required check-pack load failure, empty fitness
  registry, bundled install/build-integrity failure, or a required plugin that
  prevents the selected command from knowing what ran.
- A credible scan can still complete as `passed`, `failed`, or `degraded`.
  `Degraded` is valid only when the CLI can truthfully report which optional
  pieces failed while a meaningful scan ran.
- Empty registry and required-load failure are fail-closed. "Scanned nothing"
  must never be green, and dashboards must never represent an incomplete run as
  `score: 100`.
- Bootstrap discovery diagnostics are buffered as structured data. They are
  silent by default unless relevant to the selected command; global installed
  tool health belongs in a dedicated surface such as `tools doctor` or an
  expanded `tools list`.
- Known bundled package names may be filtered before strict installed-tool
  validation so stale workspace copies of first-party bundled tools do not appear
  as third-party tool health issues.
- Stale bundled or first-party injected package copies are install/build
  integrity failures. The user-facing action should point to rebuild/reinstall
  or workspace reinjection, not configuration edits.
- The pnpm injection guardrail must compare more than top-level entry points:
  injected `dist/` file sets and `package.json#opensipTools` must remain fresh
  against source.

**Related specs / ADRs:** `docs/plans/specs/cli-diagnostic-boundary-and-run-outcomes.md`.
Builds on ADR-0011 (signal output currency), ADR-0024 (command outcome and
observability), ADR-0035 (host-owned verdict), ADR-0051 (host-owned lifecycle),
ADR-0052 (bootstrap state machine), ADR-0053 (per-run logger scope), ADR-0054
(tool fault-isolation boundary), and ADR-0059 (tool identity single source).
