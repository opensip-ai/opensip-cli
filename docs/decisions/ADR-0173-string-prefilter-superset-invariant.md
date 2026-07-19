---
status: active
last_verified: 2026-07-18
owner: opensip-cli
---

# ADR-0173: A check's string pre-filter must be a superset of its authoritative matcher

```yaml
id: ADR-0173
title: A check's string pre-filter must be a superset of its authoritative matcher
date: 2026-07-18
status: active
supersedes: []
superseded_by: null
related: [ADR-0040]
tags: [fitness, checks, quality, false-negatives]
enforcement: mechanizable
enforced-by: ['local:string-prefilter-superset']
enforcement-reason: >
  The invariant is semantic; the private checks-dogfood check
  string-prefilter-superset mechanizes its two proven high-confidence
  violation classes (whitespace-edged QUICK_FILTER keywords; an end-anchored
  regex tested against whole-file content), path-gated to opensip's own check
  packs, with must-FAIL/must-PASS fixtures under the ADR-0040 harness.
```

## Decision

Any fitness check that gates an expensive AST/regex pass behind a cheap string
pre-filter must keep the pre-filter a **strict superset** of what the
authoritative matcher can match: every input the matcher would flag must pass
the filter. A filter narrower than its matcher is a silent false-clean — the
worst failure mode for a deterministic-evidence guardrail.

The shipped instances this decision fixes:

- `no-any-types` required punctuation around `any` (`': any'`, `'any)'`, …),
  so valid TypeScript a formatter would rewrite (`:any`, `,any`, line-final
  `as any`) returned CLEAN without running the AST pass. The gate is now the
  bare substring — a guaranteed superset of any `AnyKeyword` node.
- Three peers had the same class of defect (case-sensitive filters against
  case-insensitive matchers; `'.post('` missing generic call forms), and
  `in-memory-repository-detection` was **dead in production**: its anchored
  `/Repository$/` patterns were tested against whole-file content, which only
  matches a file whose final bytes are the stem — its fixture had been
  authored newline-free to game the gate. Anchors belong on the extracted
  name, never the content gate.

## Alternatives considered

- **Drop cheap pre-filters entirely** — rejected: they exist for a real
  per-file cost reason on large repos; removing them regresses the
  resource-bound posture. The superset gate keeps the perf win and moves
  precision to the authoritative pass, which is already memoized on the
  shared per-run Program.
- **Case-by-case review** — rejected: that is exactly how the shipped
  `no-any-types` false-green (and the dead repository check) got through.

## Consequences

- Pre-filters get broader (more files reach the AST pass); the shared-Program
  memoization keeps this cheap, and the repo-wide preflight of the widened
  filters surfaced zero new findings on this codebase.
- New cap/filter authors register non-conventional spellings explicitly; the
  dogfood check fails the gate on the two mechanized violation classes.
