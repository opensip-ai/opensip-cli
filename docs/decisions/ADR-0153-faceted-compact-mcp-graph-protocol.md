---
status: active
last_verified: 2026-07-11
owner: opensip-cli
---

# ADR-0153: Use faceted exclusive compact MCP graph projections

```yaml
id: ADR-0153
title: Use faceted exclusive compact MCP graph projections
date: 2026-07-11
status: active
supersedes: [ADR-0149]
superseded_by: null
related: [ADR-0003, ADR-0084, ADR-0109, ADR-0123, ADR-0130, ADR-0147, ADR-0148, ADR-0152, ADR-0154]
tags: [mcp, graph, audit, coverage, compact, protocol]
enforcement: mechanizable
enforced-by: ['script:schemas.test.ts', 'script:graph-query-page.test.ts', 'script:graph-traversal-projection.test.ts', 'script:package-query-page.test.ts', 'script:architecture-query-page.test.ts', 'script:graph-context-privacy.test.ts', 'script:e2e-stdio.test.ts', 'script:tool-descriptor.test.ts', 'depcruise:no-cross-package-internal', 'depcruise:mcp-graph-internal-scope', 'eslint:mcp-no-current-scope']
enforcement-reason: >
  Strict Zod schemas, exclusive compact projections, cursor digests, privacy
  guards, 4 MiB serializer ceiling, and built stdio inventory tests enforce the
  faceted protocol. Graph/read package boundaries remain depcruise-enforced.

**Decision:** MCP graph tools use **four independent coverage facets**
(inventory, evidence, grouping, projection) and **exclusive** compact
representations (`summary` | `groups` | `nodes`). Compact-by-default replaces
verbose mixed payloads. ADR-0149’s still-active contracts are carried forward:
occurrence-default traversal with explicit body-twin union, labelled
call/import package evidence, runtime-edge-versus-call distinction, public
`@opensip-cli/graph/read` only, read-only/session-free ordinary reads,
project+generation+query-bound cursors, strict schemas, and the 4 MiB final
JSON ceiling.

Additional protocol choices in this ADR:

- **Identity-search default 20** for `search_symbols` and `search_declarations`
  (caller range 1–500). Unrelated paged tools keep default page size 100 / max
  500.
- **Package samples and cycle proofs are opt-in** (default 0). Architecture
  defaults to metrics with deterministic top-N (default 20, max 100).
- **Surface metadata:** `get_agent_catalog` reports live MCP version, surface
  epoch, registered names/count, mutation posture, and project root. Default
  inventory is **21** tools; mutation opt-in adds only `repair_apply_verify`
  for **22**. Registration caps (256 tools / 128-character names) are
  defensive, not targets.
- **Reconnect vs refresh:** A stale connector (mismatched surface
  epoch/names/version) requires a new MCP process/connection.
  `refresh_graph` rebuilds graph evidence only; it never repairs a cached
  connector inventory.
- **Logs:** Coalesced server/dispatch/query/freshness summaries on stderr;
  protocol-only stdout; no adapter/shard discovery flood on ordinary reads.

**Alternatives:**
- Keep verbose multi-family defaults — rejected: burns agent context on first
  pass audits without improving decisions.
- Flat single coverage flag — rejected: sample caps were incorrectly invalidating
  complete inventories.
- New server-info tool — rejected: `get_agent_catalog` already exists; additive
  surface metadata is enough for connector diagnosis.
- Preserve ADR-0149 defaults for compatibility — rejected: no backwards
  compatibility obligation on default detail volume (plan principle).

**Rationale:** Repeat modular audits need small, honest first responses and a
way to diagnose stale clients without conflating connector identity with catalog
generation. Facets make “inventory complete / samples omitted” honest.
Exclusive modes prevent accidental dual projection.

**Consequences:**
- Clients must request samples, proofs, large node sets, and reference sites
  explicitly.
- Cursor digests include every selector that changes the projection; tampering
  or selector drift yields typed cursor errors.
- Public docs and managed agent guidance describe 21/22 tools and reconnect
  diagnosis.

**Fitness check:** No check warranted — strict runtime protocol tests are the
direct evaluator.

**Related ADRs:** ADR-0149 (bounded labelled MCP audit evidence); ADR-0152 (evidence.
