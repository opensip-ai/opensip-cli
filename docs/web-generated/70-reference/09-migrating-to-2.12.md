---
status: current
last_verified: 2026-06-08
release: v2.12.0
title: "Migrating to 2.12"
audience: [ci-integrators, plugin-authors]
purpose: "Everything a --json consumer must change for the 2.12.0 CommandOutcome wrapper, plus the new structured bootstrap errors and the governed env surface."
source-files:
  - packages/contracts/src/command-outcome.ts
  - packages/contracts/src/signal-envelope.ts
related-docs:
  - ./04-json-output-schema.md
  - ./10-environment-variables.md
  - ../../decisions/ADR-0024-command-outcome-and-observability.md
---
# Migrating to 2.12

**2.12.0 lands one breaking change in the pre-GA 2.x line:** `--json` now emits a
`CommandOutcome` wrapper instead of the bare result. The project stays pre-GA on
the long-lived 2.x major ([ADR-0012](https://github.com/opensip-ai/opensip-tools/blob/v2.12.0/docs/decisions/ADR-0012-versioning-and-release-policy.md));
breaking changes batch into 2.x minors, exactly as the 2.7.0 `--json` change did.
Everything else in this release — a diagnostics bus, a governed environment
surface — is additive.

This page is the migration checklist. Almost everyone affected is a **`--json` /
CI consumer**; plugin authors get a new error seam.

## 1. `--json` is now a `CommandOutcome` wrapper

Before 2.12.0, a run command emitted the bare `SignalEnvelope` at the top level:

```jsonc
// 2.11.0 and earlier — fit --json
{ "schemaVersion": 2, "tool": "fit", "verdict": { "passed": false, ... }, "signals": [ ... ] }
```

2.12.0 wraps it. The **byte-identical** envelope now rides under `.envelope`:

```jsonc
// 2.12.0 — fit --json
{
  "kind": "fit.run",
  "status": "ok",
  "exitCode": 1,
  "envelope": { "schemaVersion": 2, "tool": "fit", "verdict": { "passed": false, ... }, "signals": [ ... ] },
  "diagnostics": { "runId": "run_…", "events": [ ... ] }
}
```

**The one-line migration** — read one level down:

| You read (≤ 2.11.0) | Read now (2.12.0) |
|---|---|
| `.verdict.passed` | `.envelope.verdict.passed` |
| `.verdict.score` | `.envelope.verdict.score` |
| `.signals` | `.envelope.signals` |
| `.units` | `.envelope.units` |

```bash
# before
opensip-tools fit --json | jq '.verdict.passed'
# after
opensip-tools fit --json | jq '.envelope.verdict.passed'
```

The inner envelope is unchanged (`schemaVersion: 2`); only the outer nesting moved.

## 2. List / dashboard commands → `.data`

Commands that emit a `CommandResult` rather than a run envelope (`fit --list
--json`, `fit --recipes --json`, `graph --list-files --json`, `init --json`,
`sessions`, `plugin list --json`, …) now carry their result under `.data`:

```bash
# before:  opensip-tools fit --list --json | jq '.totalCount'
# after:   opensip-tools fit --list --json | jq '.data.totalCount'
```

## 3. Failures are now structured (`.errors`) — including bootstrap

Before 2.12.0, a failed `--json` run emitted a bare `{ "error": "…" }`, and the
highest-friction failures (no project found, config schema too new) emitted nothing
structured at all — they wrote to stderr and exited. Now **every** failure,
including those pre-handler bootstrap failures, is a structured outcome:

```jsonc
// 2.12.0 — fit --json in a directory with no opensip-tools project (exit 2)
{
  "kind": "bootstrap.error",
  "status": "error",
  "exitCode": 2,
  "errors": [
    { "message": "No opensip-tools.config.yml found. Searched from /path upward.",
      "suggestion": "Run opensip-tools init to get started." }
  ]
}
```

```bash
# before:  jq '.error'            (and nothing at all for no-project / bad-schema)
# after:   jq '.errors[0].message'   ·   check status with  jq -e '.status == "ok"'
```

Human (non-`--json`) output and all exit codes are **byte-identical** to 2.11.0.

## 4. Plugin authors: the `emitJson({ error })` seam is retired

If your tool handler emitted a bare error object on `--json`, switch to the new
host seam, which wraps a `status:"error"` `CommandOutcome` and sets the exit code:

```diff
- cli.emitJson({ error: result.message })
+ cli.emitError({ message: result.message, exitCode: result.exitCode })
```

The `one-outcome-shape` fitness check fails CI on the retired shape.

## 5. New, additive: diagnostics + a governed env surface

- Every outcome now carries a `diagnostics` field (`RunDiagnostics`): a
  JSON-emittable stream of lifecycle events (plugins loaded, project resolved,
  command executed). Purely additive — ignore it if you don't need it.
- Every environment variable the CLI reads is now declared and governed; see the
  generated [environment-variable reference](/docs/opensip-tools/70-reference/10-environment-variables/). No
  variable names changed.
