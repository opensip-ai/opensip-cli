---
status: superseded
last_verified: 2026-07-11
owner: opensip-cli
---

# ADR-0149: Bounded labelled MCP audit evidence

```yaml
id: ADR-0149
title: Bounded labelled MCP audit evidence
date: 2026-07-09
status: superseded
supersedes: []
superseded_by: ADR-0153
related: [ADR-0003, ADR-0084, ADR-0109, ADR-0123, ADR-0130, ADR-0147, ADR-0148]
tags: [mcp, graph, audit, package, runtime-wiring]
enforcement: mechanizable
enforced-by: ['script:public-read-surface.test.ts', 'script:graph-handlers.test.ts', 'script:live-runtime-wiring-read-port.test.ts', 'script:e2e-stdio.test.ts', 'depcruise:no-cross-package-internal', 'depcruise:mcp-graph-internal-scope', 'eslint:mcp-no-current-scope']
enforcement-reason: >
  Public API locks, SDK handler and hostile runtime-wiring tests, built stdio
  inventory tests, dependency-cruiser, and the MCP currentScope import rule
  enforce the evidence, bounds, injection, and package-boundary contracts.
  Superseded by ADR-0153 for faceted exclusive compact projections and live
  surface diagnosis; carried-forward occurrence/package/runtime bounds remain
  authoritative via ADR-0153.

## Decision

MCP audit evidence is occurrence-precise by default, labelled by evidence kind
and confidence, bounded on every high-volume path, and tied to one project,
generation, and normalized query.

- **Call evidence:** traversal defaults to occurrence `symbolId`. Explicit
  body-twin reachability first filters both endpoints of canonical occurrence
  edges, then groups surviving occurrences by body hash. Excluded owners or
  targets cannot leak back through a global twin adjacency.
- **Package evidence:** call and import edges remain distinct. Combined views
  preserve labels and proving samples; `why_depends` and package SCCs do not
  turn different evidence sources into an unexplained count.
- **Runtime evidence:** `RuntimeWiringReadPort` is an injected, immutable view of
  captured admitted manifests, provenance, the live registry, CommandSpecs,
  nesting, host-mount contracts, handler dispatch, and external worker posture.
  It is not a source call graph. Accessor command surfaces are refused rather
  than invoked, handler source is never stringified, and raw provenance paths or
  manifest hashes are never exposed. Top-level host commands remain an explicit
  coverage gap.
- **Bounds:** default page size is 100 and maximum 500; page continuation and
  coverage truncation are separate. Walk depth is at most 5 and visited nodes at
  most 2,000. Runtime snapshots stop at 10,000 nodes and 20,000 edges, text at
  256 characters, groups at 500, and final JSON at 4 MiB. A ceiling yields
  partial coverage or a bounded typed error, never silent omission.
- **Protocol:** strict schemas reject unknown keys and hostile enum/path/cursor
  values. Cursors bind the project key, opaque generation/snapshot key, query
  digest, and a compact `r1:` SHA-256 identity of the stable continuation key
  (never the potentially large raw sort tuple). Tool-dispatch completion logs
  carry only the registered tool name, bounded duration, and `ok`, `tool-error`,
  or `thrown` outcome.

The four protocol additions are `package_dependencies`, `why_depends`,
`package_cycles`, and `get_runtime_wiring`. Together with the existing surface,
the exact default inventory is 19; mutation opt-in adds only
`repair_apply_verify` for 20. These are MCP registrations, not new OpenSIP Tool
plugins or session-producing runs.

All graph feature reads cross the free-function `@opensip-cli/graph/read`
boundary and return `Result`. MCP production does not import graph repositories,
rules, raw indexes, `graph/internal`, or ambient `currentScope` state.

## Alternatives

- Use one representative twin as the caller/callee result: rejected because the
  chosen occurrence can have different owners, visibility, and edges.
- Union twins before filtering endpoints: rejected because excluded test or
  generated occurrences can fabricate production reachability.
- Merge call/import/runtime evidence into one unlabeled graph: rejected because
  an audit could no longer state what actually proves a boundary.
- Derive live manifest/CommandSpec wiring from static calls only: rejected
  because registration and function-valued dispatch are runtime composition.
- Put runtime wiring into the graph engine: rejected because it would move host
  vocabulary into the language-agnostic graph domain.
- Return unbounded arrays or persist cursors: rejected for memory/context safety
  and because cursors describe one ephemeral generation/query.

## Consequences

- Architecture audits can distinguish static call, import, and live runtime
  composition evidence and report confidence/coverage honestly.
- Large fan-in, package, twin, and wiring queries have deterministic continuation
  and explicit hard-cap reasons.
- Result replay remains independent and session-free; refresh remains the sole
  graph mutation.
- Spec 20 and ADR-0147 remain the sanctioned graph-consumption boundary.

**Related plans and decisions:** [Spec 21](../plans/specs/21-mcp-graph-audit-readiness.md), its [ready plan](../plans/ready/mcp-graph-audit-readiness/plan.md), the [Spec 20 modular-boundary prerequisite](../plans/specs/20-modular-monolith-boundary-hardening.md), [ADR-0147](./ADR-0147-public-graph-read-and-fail-closed-package-boundaries.md), [ADR-0148](./ADR-0148-mcp-catalog-identity-auto-swap-and-complete-freshness.md), [ADR-0084](./ADR-0084-mcp-server-surface.md), [ADR-0003](./ADR-0003-per-occurrence-edge-keying.md), [ADR-0109](./ADR-0109-mcp-first-agent-guidance-init-refresh.md), [ADR-0123](./ADR-0123-impact-analysis-trust-foundation.md), and [ADR-0130](./ADR-0130-mcp-repo-scoped-session-reads.md).
