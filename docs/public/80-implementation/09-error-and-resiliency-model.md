---
status: current
last_verified: 2026-07-23
release: v0.8.4
title: "Error and resiliency model"
audience: [contributors, tool-authors]
purpose: "How failures are defined, constructed, normalized, retried, cancelled, and projected across CLI, workers, logs, and JSON."
source-files:
  - packages/core/src/lib/error-definition.ts
  - packages/core/src/lib/errors.ts
  - packages/core/src/lib/failure-envelope.ts
  - packages/core/src/lib/safe-diagnostic-data.ts
  - packages/core/src/lib/retry.ts
  - packages/core/src/tools/error-catalog.ts
  - packages/core/src/tools/report-failure.ts
  - packages/contracts/src/exit-codes.ts
  - packages/cli/src/bootstrap/report-failure.ts
  - packages/cli/src/bootstrap/last-resort-failure-net.ts
  - packages/cli/src/bootstrap/interrupt-abort.ts
related-docs:
  - ./04-coding-standards.md
  - ./05-layer-policy.md
  - ../50-extend/06-full-tool-plugins.md
  - ../70-reference/04-json-output-schema.md
  - ../70-reference/18-error-code-index.md
  - ../../decisions/ADR-0181-structured-error-definitions-and-failure-envelope.md
  - ../../decisions/ADR-0183-explicit-retry-cancellation-and-safe-failure-sinks.md
---

# Error and resiliency model

OpenSIP failures are **definitions first**, **presentation second**. Machine consumers (agents, CI, MCP, workers) key on stable codes and orthogonal axes — not on subclass names or message substrings.

## Orthogonal axes

| Axis | Values (summary) | Meaning |
|---|---|---|
| **source** | application / infrastructure / external | Where the failure arose |
| **defaultResponsibility** | user / tool-author / operator / environment / unknown | Who can act |
| **kind** | validation, not-found, network, timeout, cancelled, … | What class of failure |
| **retry** | never / transient / caller-policy | Default retry posture |
| **severity** | warning / error / fatal | Execution-failure severity (**not** finding `SignalSeverity`) |
| **exposure** | public / redacted / operator-only | How far fields may travel |
| **exitClass** | configuration / not-found / runtime / cancelled / … | Host-neutral exit bucket |

`ToolRunOutcome` (`passed` \| `failed` \| `degraded` \| `error`) is derived by the host from lifecycle phase + credible analysis evidence — never from definition severity alone (ADR-0060 / ADR-0181).

## Two control-flow styles

Keep both; unify **semantics**, not style:

1. **`throw` / `ToolError`** — exceptional and invariant failures  
2. **`Result<T, E = ToolError>`** — expected/recoverable local failures (`ok` / `err` / `tryCatch`)

Do not convert sites between styles for migration fashion. `SignalEnvelope` is **findings output**, not an error-handling mechanism.

## How to add an error

1. **Define or reuse** a catalog entry (`defineErrorCatalog`) with a stable `OWNER.DOMAIN.CONDITION` code (or legacy adapter during migration).  
2. Mark **public** vs **internal** stability; never reuse a published code for a new meaning — use `supersededBy`.  
3. Construct via `createToolError(def, message, { metadata, cause })` or subclass + `{ definition, metadata }`.  
4. Allowlist outward metadata with `publicMetadataKeys`.  
5. Test `normalizeFailure` / public projection does not leak secrets.  
6. For tools: set `extensionPoints.errorCatalog` and bump awareness of `TOOL_CONTRACT_VERSION` ≥ `1.1.0`.

```ts
import { createToolError, defineErrorCatalog } from '@opensip-cli/core';

const catalog = defineErrorCatalog(
  { id: '<tool-stable-uuid>', displayName: 'my-tool', packageName: '@scope/my-tool' },
  {
    'MYTOOL.RESOURCE.MISSING': {
      code: 'MYTOOL.RESOURCE.MISSING',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'not-found',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'not-found',
      operatorAction: 'List available resources and retry with a valid name.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['resourceId'],
    },
  },
);

throw createToolError(catalog.require('MYTOOL.RESOURCE.MISSING'), 'Resource not found', {
  metadata: { resourceId: 'abc' },
});
```

## Normalization and projections

`normalizeFailure(unknown)` is **total** (never throws). It produces a `FailureEnvelope` then:

- **public** — allowlisted metadata only  
- **machine / worker** — redacted axes for IPC and JSON  
- **operator** — may include bounded operatorDetail (stderr tails); still no raw `Error` objects  

Exit codes for any throw use `mapFailureToExitCode` (`@opensip-cli/contracts`): typed subclass ladder first (ADR-0066), then structural `isToolErrorLike` brands (duplicate physical `@opensip-cli/core`), then normalized definition `exitClass`.

## Host reporting

Tools call `cli.reportFailure({ error, message?, suggestion?, … })`. The host normalizes **once** and fans out to log, human/JSON, exit code, and diagnostics. Do not pre-stringify and lose structure.

Escaped process failures use a **minimal last-resort net** (synchronous coded line) — not the full async fan-out. Both `uncaughtException` and `unhandledRejection` force-exit after that write so the process cannot resume with undefined state.

## Retry and cancellation

- Prefer `withRetry` with `signal`, deadlines, and injectable clock in tests.  
- Definition `retry: 'never'` stops retries; untyped network-ish errors may still retry.  
- `ToolScope.abortSignal` is the host cancel signal (distinct from cloud `signalSink`).  
- SIGINT/SIGTERM: first interrupt aborts; second within the grace window forces POSIX **130** / **143**.

## Layer ownership

| Layer | Owns |
|---|---|
| **core** | definitions, envelope, safe diagnostic data, retry primitives, worker failure wire |
| **contracts** | numeric exit mapping, command outcome shapes |
| **cli** | effectful fan-out, last-resort net, interrupt coordinator |
| **tools / substrates** | package-owned catalogs and throw sites |

Core never imports contracts or cli.

## Contributor commands

```bash
pnpm --filter=@opensip-cli/core test
pnpm error-inventory:ratchet   # temporary Plan 01 no-new-debt (local campaign baseline)
pnpm docs:error-index          # regenerate error-code reference
pnpm docs:error-index:check
```

Generated inventory evidence and indexes are never hand-edited.

## Public API stability

Published error codes and versioned machine failure projections are public contracts:

- Additive projection fields are forward-compatible.  
- Breaking projection shape requires a new schema version + deprecation window.  
- Semantic change to a public code ⇒ new code + `supersededBy`, with a CHANGELOG note on release.

See [ADR-0181](../../decisions/ADR-0181-structured-error-definitions-and-failure-envelope.md) and [ADR-0183](../../decisions/ADR-0183-explicit-retry-cancellation-and-safe-failure-sinks.md).
