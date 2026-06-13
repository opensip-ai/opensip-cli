---
status: active
last_verified: 2026-06-13
owner: opensip-cli
---

# ADR-0048: Tool Stable UUID Identity

```yaml
id: ADR-0048
title: Tool Stable UUID Identity
date: 2026-06-13
status: active
supersedes: []
superseded_by: null
related: [ADR-0046, ADR-0047, ADR-0036, ADR-0027]
tags: [tool, identity, uuid, plugins, community, datastore, architecture, hygiene]
enforcement: mechanizable
enforcement-reason: >
  A dedicated (or extended) fitness architecture check (parallel to `no-placeholder-check-ids` for checks) will enforce that Tool `id` fields (in manifests and exported Tool objects) are real promoted UUIDs and not placeholder patterns. The check will reference this ADR (and the governing spec). DB schema updates will be additive.
```

**Decision:** Tools receive a stable machine identity using the exact same field name and semantics as Checks: `id` (a real UUID) in `ToolMetadata` (and supported in `ToolPluginManifest` / `ToolProvenance`). 

The previous human-facing / current key string in `ToolMetadata.id` is renamed to `ToolMetadata.name` (freeing `id` for the stable UUID and providing clarity). 

The stable `id` (UUID) for a tool will be persisted in the host datastore (additive column(s) in `tool_baseline_*`, `tool_state`, and related session tables) alongside the human `name` value (which continues to be stored in the existing `tool` column for compatibility and current human-facing queries). 

A fitness architecture check (in the style of the recent check-ID hygiene) will enforce real UUID values for Tool `id` fields (no placeholder patterns) and, for non-bundled published tools, the presence of a real stable `id`.

This uses the name `id` (not `stableId`) for the stable UUID on tools to ensure perfect consistency with the stable `id` already used by Checks.

**Alternatives:**
- Use `stableId` (or similar) for the stable UUID on Tools while Checks use `id` (rejected: creates exactly the naming mismatch the user explicitly called out; leads to long-term confusion in code, docs, agent-catalog, DB payloads, enforcement checks, and contributor mental models).
- Keep the human string named `id` on Tools and add the stable UUID under a different name (rejected: re-creates the ambiguity we just cleaned up for Checks; the human key was already being renamed to `name` for clarity and to align with the manifest's `name` distinction).
- Do not persist the stable `id` in the DB (only in provenance/JSON payloads) (rejected: fails the core goal of durable, queryable, collision-proof scoping for community tools in baselines, tool state, and sessions).
- Repurpose the manifest `id` to mean the stable UUID at the same time as the runtime change (rejected: larger breaking surface for plugin discovery, package.json declarations, the loader, and existing storage keys; we keep manifest `id` as the declared human key for compat in this cycle and support the stable UUID additively).

**Rationale:** 
Checks already have a well-established, enforced, and recently-cleaned-up model: `id` = real stable UUID (for SARIF, fingerprints, ratchets, ignores, dedup, etc.), with a separate human `slug`. 

For future community tool authors (the explicit motivation), human-chosen string keys will collide and authors will want to rename tools without losing historical data. A stable UUID `id` (recorded durably in the DB) solves this while preserving the human `name` (and short-form ergonomics) for UX, CLI commands, current storage keys, and on-disk layout.

Using the identical name `id` for the stable UUID on Tools (as on Checks) is the minimal-surprise, consistent choice across the entire platform. The rename of the old human `id` → `name` on `ToolMetadata` (already under discussion) makes room for this without ambiguity.

The DB persistence is additive (existing `tool` column keeps the human `name` value). Enforcement is mechanizable via fitness check (dogfoodable, parallel to the check hygiene work and ADR-0046/0047 contract-version checks).

This is primarily an identity addition (orthogonal to contract surface evolution in ADR-0046/0047) but will be called out in JSDoc, the new check, and contributor documentation because it changes the meaning of `metadata.id` for anyone reading Tool objects.

See the governing spec `docs/plans/specs/tool-stable-uuid-identity.md` for full technical context, DB schema details, first-party treatment, manifest evolution, and success criteria.

**Consequences:**
- `ToolMetadata` shape evolves: `id` (stable UUID) + `name` (human-facing, previously the value in `id`).
- First-party tools (`fitnessTool`, `graphTool`, `simulationTool`) will be assigned and declare real promoted UUIDs under `metadata.id`; their human key moves to `metadata.name`.
- New (or extended) fitness architecture check to enforce real UUID `id` values for tools and presence for published tools.
- Datastore schema updates (additive column(s) for tool stable `id` in baseline and tool-state tables; possible session table too). A migration will be required.
- Internal code, tests, fixtures, agent-catalog, provenance, plugin commands, etc. will be updated to use `.name` for the human tool identifier where the old `.id` was used for that purpose.
- Manifests for published tools will declare the stable `id` (additive).
- The `tool` column in DB and many runtime surfaces (envelopes, sessions, short ids) continues to use the human `name` value for now; the stable `id` is available for new durable uses and future evolution.
- JSDoc on `Tool`, `ToolMetadata`, `ToolProvenance`, etc. will document the new meaning of `id` (stable UUID, matching Checks) vs. `name`.
- No change to `TOOL_CONTRACT_VERSION` purely for this (per ADR-0046 policy; identity is tracked separately), but the evolution will be noted.
- Long-term: enables collision-free community tools, rename-stable history, and better global tool identity in catalogs/Cloud.

**Related specs / ADRs:**
- Governing spec: `docs/plans/specs/tool-stable-uuid-identity.md`
- ADR-0046 (Tool Contract Versioning Policy) and ADR-0047 (Per-Tool Contract Versioning) — this is identity, not contract surface.
- ADR-0036 (host-owned baseline plane) — the stable `id` will become usable for durable tool scoping in baselines.
- Recent check hygiene work (promotion of real `id` UUIDs for checks + `no-placeholder-check-ids` meta-check) — direct precedent and naming consistency driver.
- ADR-0027 (GA parity / plugin model) and related tool discovery work.