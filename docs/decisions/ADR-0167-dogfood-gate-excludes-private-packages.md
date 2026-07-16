---
status: active
last_verified: 2026-07-16
owner: opensip-cli
---

# ADR-0167: Exclude private, never-published packages from the dogfood fit gate

```yaml
id: ADR-0167
title: Exclude private, never-published packages from the dogfood fit gate
date: 2026-07-16
status: active
supersedes: []
superseded_by: null
related: [ADR-0020, ADR-0040, ADR-0157, ADR-0158]
tags: [fitness, dogfood, gate, config, testing]
enforcement: not-mechanizable
enforcement-reason: >
  The posture is a configuration policy realized directly by the `globalExcludes`
  entries in `opensip-cli.config.yml`; there is no separate static invariant to
  enforce. A meta-check asserting the exclude set equals the set of `private: true`
  packages would be disproportionate for the repo's three private packages, where
  adding one is already a deliberate, reviewed act. The config block IS the record.
```

**Decision:** The dogfood fit gate (`fit --gate-save`, run in CI's `build-and-test`
"Fit (dogfood)" step and the `cold-gate` job) enforces the **shipped product**
only. The repo's private, never-published packages — `@opensip-cli/agent-eval`,
`@opensip-cli/test-support`, and `@opensip-cli/checks-dogfood` (all `private: true`,
never on npm) — are excluded from fit's file targets via `globalExcludes` in
`opensip-cli.config.yml`, the same mechanism already used for other non-product
surfaces (docs, fixtures, generated migrations, coverage output). ESLint still
lints these packages; only the fit product gate stops treating them as shipped
source.

**Alternatives:**

- **Fix the harness code to pass the production bar.** Rejected as the primary
  fix: it holds a non-shipping, black-box eval harness ([ADR-0157](ADR-0157-agent-eval-black-box-harness.md)
  / [ADR-0158](ADR-0158-agent-eval-deterministic-measurement.md)) to the product's
  `detached-promises` / `async-waterfall-detection` / `duplicate-utility-functions`
  bar, produces heavy churn on code no customer runs, and — decisively — does NOT
  close the systemic gap: the next private package added under `packages/*/src`
  re-trips the gate. (The one genuine improvement it surfaced — a duplicated
  `delay` helper in agent-eval — can be done as ordinary polish, not gate
  appeasement.)
- **Blanket-disable the tripped checks via `disabledChecks`.** Rejected: it drops
  `detached-promises` and the others repo-wide, removing the guardrail on
  genuinely-shipping packages (`cli`, `core`, the graph engine). This is exactly
  the guardrail-weakening `CLAUDE.md` forbids.
- **Exclude only `agent-eval` (the package currently failing).** Rejected as
  incomplete: `@opensip-cli/test-support` sits in the `backend` target too and
  passes only by luck of its current content, and `@opensip-cli/checks-dogfood`
  escapes the `backend` glob only by path depth. Naming the posture and applying
  it to all three private packages removes the latent fragility rather than
  deferring the next occurrence.

**Rationale:** The dogfood gate exists to prove the **shipped CLI** analyzes clean
(`CLAUDE.md` "Dogfood Gate"; [ADR-0020](ADR-0020-dogfood-gate-hard-fail.md) owns
the gate's fail-on-error policy). The target model in `opensip-cli.config.yml` had
no concept of "shipping vs. non-shipping package": the `backend` target glob
`packages/*/src/**/*.ts` assumes every `packages/*/src` tree is product.
`@opensip-cli/agent-eval` (added 2026-07-13) is the first private package large and
behavior-rich enough to expose that — 84 legitimate-but-immaterial findings on a
harness that ships to nobody, reddening `build-and-test` and `cold-gate` on every
commit. Excluding the private harnesses is consistent with how docs, fixtures, and
coverage are already treated, and with the black-box, zero-workspace-import posture
`agent-eval` was explicitly designed for. `@opensip-cli/test-support`
([ADR-0040](ADR-0040-test-support-package.md)) and `@opensip-cli/checks-dogfood`
are likewise dev-only, never-published surfaces.

**Consequences:**

- The three private packages are listed in `globalExcludes`; a future
  `private: true`, never-published package should be added there when created.
- The dogfood gate's scope is now explicitly "shipped product," documented at the
  `globalExcludes` block. `fit --gate-save` returns to green on `main`.
- No check is disabled and no per-check override is added; shipping packages keep
  full fit coverage.

**Related specs / ADRs:** [ADR-0020](ADR-0020-dogfood-gate-hard-fail.md) (dogfood
gate hard-fail policy), [ADR-0040](ADR-0040-test-support-package.md) (test-support
is private), [ADR-0157](ADR-0157-agent-eval-black-box-harness.md) and
[ADR-0158](ADR-0158-agent-eval-deterministic-measurement.md) (agent-eval black-box,
zero-workspace-import posture).
