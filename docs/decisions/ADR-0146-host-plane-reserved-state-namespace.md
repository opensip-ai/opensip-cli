---
status: active
last_verified: 2026-07-09
owner: opensip-cli
---

# ADR-0146: Host-plane reserved state namespace

```yaml
id: ADR-0146
title: Host-plane reserved state namespace
date: 2026-07-09
status: active
supersedes: []
superseded_by: null
related: [ADR-0042, ADR-0107]
tags: [cli, datastore, host-planes, governance, migration]
enforcement: mechanizable
enforced-by: ['script:host-planes', 'script:migration-integrity', 'script:tools-data-purge', 'script:validate-tool']
enforcement-reason: >
  Runtime/binder/migration/API tests prove reserved identities, copy-only
  migration 0009, purge of both namespaces, and rejection of reserved metadata.id.
  Value-pattern fitness checks cannot prove migration byte semantics.

**Decision:** Host governance/audit/entitlement blobs store under the reserved
identity `@opensip-cli/host-plane:<toolId>` in `tool_state`. One shared predicate
`isReservedHostPlaneIdentity` rejects that prefix at runtime Tool admission
(`metadata.id`) and across every binder-derived owned key (metadata id, name,
primary/layout, aliases, sessionReplay, config namespace) via `toolOwnedKeys`
before any seam is callable. Migration `0009_host_plane_namespace` is copy-only
`INSERT…SELECT…ON CONFLICT DO NOTHING` (no delete/overwrite, no dual-read).
`tools data-purge` clears ordinary + matching reserved identities.
`HostGovernance.listForProject` and `HostAudit.exportForCloud` are removed from
the tool-facing plane. Host-plane RPC methods are frozen allowlists; error
replies never carry host stacks or raw exception text.

**Alternatives:**
- Shared ordinary `(toolId, governance|audit|entitlements)` keys — rejected:
  tool-owned state collides with host compatibility data.
- Dual-read migration / rewrite legacy rows — rejected: ambiguous ownership;
  copy-only preserves both interpretations.
- Project-wide host methods on ToolCliContext — rejected: unbound identity.

**Rationale:** ADR-0042's generic tool_state table remains the store; namespace
separation is a logical identity, not a second table.

**Consequences:**
- `LOGICAL_SCHEMA_VERSION = SCHEMA_VERSION_OFFSET + 10`.
- Tools cannot address the reserved prefix; purge input rejects it.
- Absent reserved rows keep current empty/permissive host-plane defaults.
