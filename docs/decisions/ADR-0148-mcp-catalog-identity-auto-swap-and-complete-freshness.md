---
status: active
last_verified: 2026-07-10
owner: opensip-cli
---

# ADR-0148: MCP catalog identity, auto-swap, and complete freshness

```yaml
id: ADR-0148
title: MCP catalog identity, auto-swap, and complete freshness
date: 2026-07-09
status: active
supersedes: []
superseded_by: null
related: [ADR-0003, ADR-0084, ADR-0108, ADR-0147, ADR-0149]
tags: [mcp, graph, catalog, freshness]
enforcement: mechanizable
enforced-by: ['script:read-catalog-lifecycle.test.ts', 'script:catalog-generation.test.ts', 'script:e2e-stdio.test.ts']
enforcement-reason: >
  Public graph-read lifecycle tests, generation-controller golden/concurrency
  tests, and the built stdio process test prove identity, auto-swap, freshness,
  prior-generation retention, and explicit refresh ownership. A separate
  fitness check or graph rule would duplicate these executable boundary tests.

## Decision

Every ordinary MCP graph query probes the persisted catalog identity before it
reads. The controller derives one opaque generation key and atomically swaps to
a newly persisted immutable generation when the identity changes. The read path
reruns canonical adapter selection, discovery, file/config/cache-input checks to
produce complete or partial freshness, but it **never builds a graph**.

The generation-key encoding is exact and versioned:

```text
g1: + lowercase_hex(
  sha256(utf8(JSON.stringify([
    "opensip:mcp:catalog-generation",
    1,
    identity.language,
    identity.cacheKey,
    identity.filesFingerprint,
    identity.builtAt
  ])))

The tuple order, domain tag, and version are part of the contract. Components
remain JSON array elements, so delimiters, controls, and Unicode cannot create
tuple ambiguity. The raw `cacheKey`, `filesFingerprint`, and unhashed tuple do
not appear in responses, logs, metrics, or cursors. Responses may still expose
bounded operational context such as language and `builtAt`. Cursor binding keeps
the core ephemeral project key separate from this generation key and adds a
normalized query digest.

Catalog payloads may carry `adapterSelection` (forced or auto) and `engineMode`
(exact or sharded) without a SQLite schema or graph catalog version change.
Their absence in a legacy payload is queryable but yields partial verification;
the reader does not invent defaults. SQLite replacement remains atomic, so a
reader sees the old or new generation, never a torn payload.

Only `refresh_graph` may build. It first observes an externally persisted
generation and returns `no-op` or `reloaded` when that generation is completely
fresh. A missing/stale verdict or explicit `forceRebuild` may rebuild. A failed
probe, verification, or rebuild retains a usable prior generation, and
single-flight work shares one result with concurrent waiters.

## Alternatives

- Pin one generation for the process lifetime: rejected because an external
  `opensip graph` remains invisible until a duplicate build or restart.
- Silently auto-build on an ordinary read or startup: rejected by ADR-0084's
  explicit mutation boundary and by predictable latency requirements.
- Always rebuild on `refresh_graph`: rejected because it duplicates a successful
  external run that the server can atomically reload.
- Infer missing forced/auto or engine provenance: rejected because partial
  coverage is more truthful than invented freshness.
- Expose raw cache/fingerprint inputs or use `builtAt` alone: rejected because
  the former leaks cache inputs and the latter does not provide
  collision-resistant generation identity.
- Persist MCP generations or cursors: rejected because both are derived,
  process-local read state.

## Consequences

- A connected MCP process sees a catalog written by another real CLI process on
  the next graph read without invoking `refresh_graph`.
- Agents can distinguish project identity, catalog generation, generation
  source, and complete/partial freshness before making audit claims.
- Legacy catalogs remain useful while clearly reporting unavailable evidence.
- ADR-0084 remains active: persisted-generation auto-load is not the rejected
  silent auto-build behavior. ADR-0147 remains the public graph-read boundary.

**Related plans and decisions:** [Spec 21](../plans/specs/21-mcp-graph-audit-readiness.md), its [ready plan](../plans/ready/mcp-graph-audit-readiness/plan.md), the [Spec 20 modular-boundary prerequisite](../plans/specs/20-modular-monolith-boundary-hardening.md), [ADR-0147](./ADR-0147-public-graph-read-and-fail-closed-package-boundaries.md), [ADR-0084](./ADR-0084-mcp-server-surface.md), [ADR-0003](./ADR-0003-per-occurrence-edge-keying.md), [ADR-0108](./ADR-0108-graph-cache-key-includes-resolution-mode.md), and [ADR-0149](./ADR-0149-bounded-labelled-mcp-audit-evidence.md).
