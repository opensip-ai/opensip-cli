# docs/plans — local planning inventory

Gitignored scratch space for implementation specs and execution plans. Durable
decisions graduate to `docs/decisions/`; reader-facing facts to `docs/public/`;
contributor-only context to `docs/internal/`.

Last inventory: **2026-06-29** (dogfood pushback roadmap; specs consolidated under
`specs/`).

> **📍 Authoritative strategy & roadmap: [`00-master-plan.md`](00-master-plan.md).**
> The master plan consolidates the four-agent review
> ([`docs/internal/coop/agents-log.md`](../internal/coop/agents-log.md)) into the
> distilled product/platform strategy, the full backlog (specs 01–22), the
> floor-vs-GTM partition, the dependency-ordered build sequence, risks, and the two
> open product decisions. **Where this inventory and the master plan differ, the
> master plan wins** — in particular the spec-04 wedge is no longer "undecided"
> (recommended: *local architecture-evidence plane*; security = acquisition only),
> spec **05** is re-weighted **High** (moat centerpiece), and new specs **09–22**
> are not yet reflected in the table below.

## Layout

| Directory | Purpose | Current state |
|-----------|---------|---------------|
| `specs/` | Requirements — what to build, success criteria, promotion triggers | **8 active draft specs** (see below) |
| `ready/` | Execution plans — phased `plan.md` + `phase-N-*.md` derived from specs | Empty — populate when a spec is promoted |
| `backlog/` | Optional staging for raw ideas before they become specs | Empty |
| `completed/` | Archived shipped specs (optional) | Not created — shipped work is recorded in code + ADRs + git history |

## Active specs (`specs/`)

Draft specs seeded from 2026-06-28 dogfood pushback. Promote to `ready/` only after
each spec's promotion trigger is met: scope anchored to the live tree, config/CI key
names identified, and test obligations made explicit.

| # | Spec | Priority | Notes |
|---|------|----------|-------|
| 01 | [`01-hidden-state-gate-hardening.md`](specs/01-hidden-state-gate-hardening.md) | P0 | **Build first.** Gate verdicts must be a pure function of repo snapshot + declared inputs — not warm caches, stale injected packages, formatter/linter drift, or datastore contents. Folds session/datastore lifecycle into the same invariant. |
| 02 | [`02-precision-and-dedup-hardening.md`](specs/02-precision-and-dedup-hardening.md) | P0/P1 | Use `docs/internal/suppression-catalog.json` as a false-positive heatmap; fix top-waiver slugs (incl. `chunked-bulk-insert`); add identity/near-identity signal dedup as noise reduction. |
| 03 | [`03-suite-plane-correctness-and-v2.md`](specs/03-suite-plane-correctness-and-v2.md) | P1 | Fix worst-of aggregation and grouped output semantics before v2 features (parallel, fail-fast, per-step cwd). Regression-test the step-findings-drop bug first. |
| 04 | [`04-product-wedge-decision.md`](specs/04-product-wedge-decision.md) | P1 | **Decision memo** (rename: *Wedge **and Positioning** Decision*). **Recommendation no longer open** — wedge = *local architecture-evidence plane*; security = acquisition/orchestration only; agents = read substrate. Must reconcile `03-vs-other-tools.md` in the same PR. Product ratification owed. See master plan §1.2. |
| 05 | [`05-correlation-v0-and-risk-layer.md`](specs/05-correlation-v0-and-risk-layer.md) | **High** (was P1/P2) | **Moat centerpiece** (re-weighted). Evidence/entity correlation over graph + tool signals (graph blast-radius, **identity stability tiers** incl. CLI↔Cloud divergence). Defer composite risk scoring. After 02. |
| 06 | [`06-impact-analysis-trust-foundation.md`](specs/06-impact-analysis-trust-foundation.md) | P1/P2 | Fixture matrix for `fit --changed`, `graph impact`, `--include-impacted`; conservative fallback when graph is stale. Required before verified repair automation. Pull earlier if wedge = agent workflow. |
| 07 | [`07-agent-apply-verify-loop.md`](specs/07-agent-apply-verify-loop.md) | P2 (P1 if agent wedge) | `signal.repair` apply + targeted verify loop; MCP write surfaces gated on impact trust and deterministic gates. |
| 08 | [`08-sandboxed-extension-marketplace-rd.md`](specs/08-sandboxed-extension-marketplace-rd.md) | P2/P3 | **Strategic fork:** first-party/trusted extensions only vs fund sandbox R&D for a public marketplace. Promote only when marketplace is the chosen wedge. |

### New specs (09–22) — from the four-agent review + v0.1.15 launch follow-up

Defined in the [master plan](00-master-plan.md) §2.2. Two are drafted as spec files;
the rest are scoped in the master plan and not yet drafted here.

| # | Spec | Priority | Tier | File? |
|---|------|----------|------|-------|
| 09 | [`09-enterprise-trust-policy-plane.md`](specs/09-enterprise-trust-policy-plane.md) — PDP kernel + PEP phases (provenance, org-config, audit, gate-governance) | **Critical** | Floor | ✅ |
| 10 | [`10-capability-resource-isolation.md`](specs/10-capability-resource-isolation.md) — workerize + enforce `requires` for in-process capability packs | High | Floor | ✅ |
| 11 | [`11-platform-compatibility-lts-and-migration.md`](specs/11-platform-compatibility-lts-and-migration.md) — LTS/deprecation windows + config migration + machine-output compat window | High | Floor↔GTM | ✅ |
| 13a | [`13a-verifiable-self-distribution.md`](specs/13a-verifiable-self-distribution.md) — checksums, SBOM, signing, pinned Action | High | Floor | ✅ |
| 13b | [`13b-air-gap-offline-mirrors-and-rollback.md`](specs/13b-air-gap-offline-mirrors-and-rollback.md) — offline/air-gap install, internal mirrors, signed containers, rollback (**GTM-gated**) | Medium | GTM | ✅ |
| 17 | [`17-detection-quality-measurement.md`](specs/17-detection-quality-measurement.md) — labeled multi-language precision/recall corpus | High | Quality | ✅ |
| 18 | [`18-scale-and-performance-slos.md`](specs/18-scale-and-performance-slos.md) — repo-tier time/memory budgets + large-repo benchmark | High/Med | Quality | ✅ |
| 20 | [`20-platform-evidence-authority-and-egress-contract.md`](specs/20-platform-evidence-authority-and-egress-contract.md) — implements [ADR-0094](../decisions/ADR-0094-cli-cloud-evidence-authority-and-egress-fidelity.md) | **Critical** | Platform floor | ✅ |
| 21 | [`21-enterprise-autonomy-approval-and-change-control.md`](specs/21-enterprise-autonomy-approval-and-change-control.md) — auditable approval/kill-switch/rollback for autonomous Cloud merge (**GTM-gated**) | GTM-gated | GTM | ✅ |
| 22 | [`22-startup-observability-and-load-diagnostics.md`](specs/22-startup-observability-and-load-diagnostics.md) — structured capability-load diagnostics + startup/pre-action timing attribution | High | Operability floor | ✅ |
| 19? | [`19-human-triage-and-report-surface.md`](specs/19-human-triage-and-report-surface.md) — **PROPOSAL, not consensus**; may fold into 05/16 or be Cloud's job | Medium (proposed) | GTM | ⚠️ proposal |

**Absorbed (not standalone):** 12 (org-config) → spec 09 PEP; 14 (MCP lifecycle) →
spec 07; 15 (audit trail) → spec 09 PEP; 16 (support bundle) → deferred.

### Dependency chain (full)

```
01 gate hardening
├── 02 precision/dedup ──► 05 correlation/arch-evidence (HIGH, moat) ──► 20 evidence authority
├── 03 suite correctness
├── 06 impact trust ──► 07 apply/verify
├── 09 trust-policy PDP ──► 10 capability isolation ; ──► 20
└── 17 detection-quality ; 18 scale/perf SLOs ; 22 startup/load diagnostics (parallel)

13a verifiable distribution ──► 09 provenance PEP ; ──► 20
11 compat/LTS ──► 13b ; ──► 20
20 evidence authority ──► 21 autonomy approval (GTM-gated)
04 wedge+positioning ──► reorders 05/07 ; runs parallel with 01–02
22 startup/load diagnostics ──► feeds 18 perf attribution
```

**Suggested sequence (full 5-phase build order in [master plan](00-master-plan.md)
§3.3):** promote **01** first (cold CI lane + datastore policy + non-TS repo + fix
dangling ADR pointers). Run **04** as a positioning memo in parallel. Floor =
01/09/10/13a/20 (+ 02/03/05/06). GTM = 13b/16/19/21 — demand-gate behind a design
partner.

Specs **04** and **08** are decision memos — they produce ADRs or a short positioning
doc, not phased implementation plans.

## Ready to execute (`ready/`)

Empty. When a spec is promoted, create `ready/<slug>/` with `plan.md` and
`phase-N-*.md` files (file:line anchors verified against the live tree). Use
`backend-plan` / `build-phase` skills to generate and execute phased plans.

Previously local phased plans (MCP server, ecosystem-readiness, external-tool-adapters,
tool-suites) were pipeline-enriched on 2026-06-27 but are **not on disk** in this
inventory. Recover from backup or re-derive from ADRs when resuming that work:

- MCP read server — ADR-0084
- Ecosystem readiness — ADR-0087/0088/0089 (reserved)
- External tool adapters — ADR-0090/0091/0092 (reserved); first-party MVP may proceed
  ahead of public ecosystem gates
- Tool suites — ADR-0093 (reserved); coordinates with spec **03**

## Shipped milestones (reference)

Canonical record is code + ADRs + CHANGELOG/git history — not archived spec files.

| Milestone | Shipped | Notes |
|-----------|---------|-------|
| AI agent ergonomics | `main` (`74504c41`) | Live-run filters/compaction, `graph impact`, `fit --changed`, `signal.repair`, agent recipes, `AGENTS.md` scaffold. ADR-0085/0086. |
| D2 type-aware null-safety | `main` (v0.1.8) | Type-aware `null-safety` default on via `createTypeCheckedProgram`. |
| Tool command taxonomy | `main` (`56ca647a`) | `docs/public/50-extend/07-command-taxonomy.md` + authoring doc updates. |
| Enterprise arch hardening (Plans 06–08) | `main` | Unified logging (ADR-0077), plugin compatibility (ADR-0074), state observability (ADR-0075), tool authoring DX (ADR-0076), platform contract audit (ADR-0068/0070/0071). |

## Conventions

- **Spec** (`specs/`) = what to build — problem, target state, scope, non-goals,
  acceptance criteria, dependencies, promotion trigger.
- **Plan** (`ready/`) = how to build — phases, file hints, PR slices.
- **Promotion:** spec → `ready/` phased plan when the promotion trigger is satisfied.
- **Ship:** delete the spec/plan when merged; durable rationale lives in ADRs and
  public docs. Optionally archive under `completed/` with a merge header.
- **Supersede:** delete or replace with a short stub — do not leave stale full specs
  beside shipped work.

Deferred platform work (recreate a spec only if product need appears): parallel batch
command, `OPENSIP_PARALLEL_ISOLATION`, `@opensip-cli/supervisor`.
