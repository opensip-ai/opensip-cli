---
status: active
last_verified: YYYY-MM-DD
owner: opensip-cli
---

# ADR-NNNN: <short imperative title>

```yaml
id: ADR-NNNN
title: <short imperative title>
date: YYYY-MM-DD
status: active            # active | superseded | deferred
supersedes: []            # [ADR-NNNN, ...]
superseded_by: null       # ADR-NNNN
related: []               # [ADR-NNNN, ...] or parent-repo [DEC-NNN]
tags: []                  # e.g. [graph, rules, packaging]
enforcement: not-mechanizable   # mechanizable | not-mechanizable  (ADR-0137)
# If mechanizable, list the live enforcer(s) — origin-tagged — or NONE-YET for a
# tracked gap. Omit `enforced-by` when not-mechanizable; give a reason instead.
enforced-by: []                 # e.g. [local:my-dogfood-check, shipped:no-eval,
                                #       depcruise:no-core-to-cli, script:foo.test,
                                #       graph:cycle, eslint:no-restricted-imports,
                                #       type-structural]  |  NONE-YET
enforcement-reason: >
  If not-mechanizable, say why (judgment/policy/posture — no static invariant).
  If mechanizable, optionally add detail beyond `enforced-by`.
```

<!--
Enforcement convention (ADR-0137), verified by scripts/verify-adr-enforcement.mjs
in `pnpm lint`:
- enforcement: mechanizable    ⇒ `enforced-by:` REQUIRED. Origin-tag each enforcer:
    local:<slug>   — project-local dogfood check (opensip-cli/fit/checks/*.mjs)
    shipped:<slug> — fitness check in packages/fitness/checks-* (the product)
    depcruise:<r> | graph:<r> | eslint:<r> | script:<name> | type-structural
    NONE-YET       — mechanizable but no check exists yet (a tracked gap)
  A local:/shipped: slug must exist AND its origin tag must match where it lives.
  opensip-cli-internal architecture checks belong in opensip-cli/fit/checks
  (local), NOT the shipped product packs.
- enforcement: not-mechanizable ⇒ `enforcement-reason:` REQUIRED (why it's a
  judgment/policy call with no static invariant); no `enforced-by`.
-->


**Decision:** One or two sentences stating exactly what was decided. Present
tense, imperative. This is the load-bearing line.

**Alternatives:** The options considered and rejected, each with a one-line
reason. (At least one — "we considered nothing else" is a smell.)

**Rationale:** Why this choice over the alternatives. Cite real files/measurements
where they ground the decision.

**Consequences:** What changes as a result — new constraints, follow-up specs,
things future contributors must do. Omit if none.

**Related specs / ADRs:** Links to the specs that implement this decision and any
related ADRs. Omit if none.

<!--
Conventions:
- One decision per file. Filename = ADR-NNNN-kebab-title.md (zero-padded to 4).
- ADRs are append-only: never rewrite a shipped decision. To change one, write a
  new ADR and set the old one's `status: superseded` + `superseded_by`, and the
  new one's `supersedes`.
- This repo uses ADR-NNNN; the parent `opensip` repo uses DEC-NNN. Reference a
  parent decision as DEC-NNN under `related`.
- The `Audit-history impact` block from the parent's DEC template is intentionally
  omitted — OpenSIP CLI is a static-analysis CLI with no audit chain.
- After adding/changing an ADR, update README.md's index.
-->
