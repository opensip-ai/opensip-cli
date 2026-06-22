---
status: active
last_verified: 2026-06-22
owner: opensip-cli
---

# ADR-0056: Architecture audit remediation scope

```yaml
id: ADR-0056
title: Architecture audit remediation scope
date: 2026-06-22
status: active
supersedes: []
superseded_by: null
related: [ADR-0054, ADR-0020, ADR-0009]
tags: [architecture, hygiene, dogfood]
enforcement: not-mechanizable
enforcement-reason: >
  Remediation is a bounded hygiene program (guards, generated docs, ratchets).
  Individual items are mechanized per-phase (fitness checks, verify scripts,
  docs:check gates). The overall scope boundary ("no de-layering") is policy.
```

**Decision:** Preserve the layered plugin-host DAG unchanged. Remediate the
2026-06 first-look architecture audit via policy, ratchet, discoverability, and
documentation fixes only — no package merges, edge changes, or de-layering.

**Alternatives:**

- De-layer or merge bootstrap modules — rejected; audit unanimous that the DAG is
  the asset; bus-factor is addressed at discoverability, not structure.
- Rebuild external-tool isolation (dispatch default, host import) — rejected;
  ADR-0054 M4-E/F/G already landed; remaining gap is package integrity only.
- Ratchet safety waivers down automatically — rejected; initial budget freezes
  count ("no net-new"); declining schedule is a follow-up product decision.

**Rationale:** Tri-agent review (2026-06-22) validated findings against `main`
@v0.1.9. Structural risks are bounded. Stale audit items (pre-ADR-0054 isolation
narrative) were dropped. Executable work is captured in
`docs/plans/ready/architecture-audit-remediation/plan.md`.

**Consequences:** Implementation follows the plan's PR stack. Host-plane narrow
typing (R2/D1) defers until a Cloud consumer exists (Q2). Public third-party
ecosystem remains blocked until package attestation lands (Q7, per ADR-0054).

**Related specs / ADRs:** ADR-0054 (isolation already shipped); execution plan
under `docs/plans/ready/architecture-audit-remediation/`.

---

## Grouped audit findings index (R-ID → evidence → remediation)

| R-ID | Finding | Evidence (2026-06-22) | Remediation phase |
|------|---------|----------------------|-------------------|
| R1/R7 | Onboarding cost; architecture only in depcruise + prose | No generated arch map; ~57 bootstrap `.ts` files | Phase 1 (discoverability only — bootstrap cohesion deferred) |
| R16 | Bundled mount failures warn-and-continue | `register-tools-mount.ts:37–51` | Phase 0 |
| R9 | Bundle-vs-plugin posture implicit | `opensip-cli` static deps on all tools | Phase 2 |
| D3/R10 | Safety waivers unbounded; no cosmetic/safety split | Hundreds of `@fitness-ignore-*` in `packages/**/src` | Phase 3 |
| R13/R14/R15 | External tool trust/isolation gaps | **Partially closed by ADR-0054.** Remaining: attestation, `'*'` wildcard silence, stale public docs | Phase 5 |
| R17 | `raw-stream` escape hatch can spread silently | `rawStreamReason` required at define time; no inventory budget | Phase 4 |
| R18 | Raw Drizzle accessor beyond table-symbol depcruise rule | `requireDrizzleDataStore`; `restrict-raw-db-access` covers query shapes | Phase 4 |
| R2/D1 | Host-plane records opaque | `Record<string, unknown>` in `host-planes.ts` | **Deferred** (Q2 Cloud) |
| R3 | Frontier toolchain; no support matrix | Node ≥24, TS ~6, ESLint 10, vitest 4 | Phase 7 |
| — | Graph implementation strings say "seven-stage" | `graph/engine/package.json`, README, `orchestrate-spans.test.ts` | Phase 2 (conceptual public docs unchanged) |
