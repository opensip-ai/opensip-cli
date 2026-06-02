---
status: active
last_verified: 2026-06-01
owner: opensip-tools
---

# Architecture Decision Records

Durable architectural decisions for **opensip-tools**, one file per ADR. Each
record captures *what* was decided, the *alternatives* rejected, and the *why* —
so a future contributor can reconstruct the reasoning instead of re-litigating it.

ADRs are the **decision log** (the durable *why*). They complement, but are
distinct from:
- **`docs/specs/`** — forward-looking *how to build it* specs (an ADR records the
  decision; a spec implements it).
- **`docs/internal/`** — looser contributor notes, operational awareness,
  cross-repo relationships.
- **`docs/public/`** — reader-facing product/usage docs.

## Conventions

- **One decision per file**, named `ADR-NNNN-kebab-title.md` (zero-padded to 4).
- **Numbering:** this repo uses **`ADR-NNNN`**. The parent `opensip` repo uses
  **`DEC-NNN`** and our code/specs sometimes cite parent DECs — reference those
  under `related:` as `DEC-NNN`. The two namespaces are deliberately separate so
  IDs never collide across repos.
- **Append-only:** never rewrite a shipped decision. To change one, write a new
  ADR, set the old one's `status: superseded` + `superseded_by: ADR-NNNN`, and the
  new one's `supersedes: [ADR-NNNN]`.
- **Status** lives in each file's YAML block: `active` | `superseded` | `deferred`.
- Start from [`TEMPLATE.md`](./TEMPLATE.md). The parent's SaaS-specific
  `Audit-history impact` block is intentionally omitted here.
- This index is **hand-maintained** for now; add your ADR below when you create
  it. (A generator can follow, like `scripts/build-web-docs.mjs`.)

## Index

### Active

- [ADR-0001](./ADR-0001-graph-rules-actionable-precise-bounded.md) — Graph rules
  must be actionable, precise, and bounded (rankings are dashboard insights, not
  gate rules)
- [ADR-0002](./ADR-0002-coupling-bucketing-by-nearest-package.md) — Coupling
  buckets by nearest `package.json`, not a path heuristic (per-package `package`
  field; shipped 2.4.2)
- [ADR-0003](./ADR-0003-per-occurrence-edge-keying.md) — A body hash is not an
  occurrence identity: edges (shipped 2.4.2) and reachability adjacency (pending)
  key per occurrence, never the `byBodyHash` winner (body-twin de-union)

### Superseded

_(none yet)_
