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
enforcement: not-mechanizable   # mechanizable | not-mechanizable
enforcement-reason: >
  If mechanizable, name the fitness check / graph rule / dep-cruiser rule that
  enforces it. If not, say why (judgment call, framework choice, etc.).
```

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
