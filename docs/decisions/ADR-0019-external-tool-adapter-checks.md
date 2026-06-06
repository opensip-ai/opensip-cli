---
status: active
last_verified: 2026-06-06
owner: opensip-tools
---

# ADR-0019: External quality tools run as first-party `command:` fit checks — wrap, don't reimplement; teach, don't ship

```yaml
id: ADR-0019
title: External quality tools run as first-party command-adapter fit checks (wrap, don't reimplement; teach, don't ship)
date: 2026-06-06
status: active            # active | superseded | deferred
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0014, ADR-0009, ADR-0007]
tags: [fitness, checks, tooling, ci, docs]
enforcement: not-mechanizable
enforcement-reason: >
  This is an authoring/architecture policy, not a single checkable invariant. The
  mechanism it standardizes already exists and is self-enforcing per tool: the
  `command:` adapter on `defineCheck` (see `clang-tidy-passthrough.ts`,
  `dead-code.ts` (knip), `semgrep-scan`, `dependency-vulnerability-audit`). Each
  wrapper, once built, IS the enforcement for its tool. The "don't ship opinionated
  wrappers to customers" half is upheld by review + the export-surface tests
  (ADR-0009/ADR-0013) plus the fact that wrappers presuming the host repo's config
  live only in opensip-tools' own check packs, never in a customer-facing recipe.
```

**Decision:** opensip-tools standardizes on **wrapping mature external quality
tools as first-party `command:` fit checks** so that `fit` is the single quality
entry point for *this* repository — joining the wrappers that already ship
(`clang-tidy`, `knip` via `dead-code`, `semgrep`, the package-manager audit) with
`eslint` and, with a carve-out, `dependency-cruiser`. The rule is **wrap, don't
reimplement**: a mature external tool is invoked through the `command:` adapter and
its output mapped to `Signal`s; native re-implementation as a fit check is reserved
for small, high-value checks that benefit from fit's shared parse/file cache.
**We do not ship these opinionated wrappers as checks** in the published check
packs (every consumer's lint/architecture config differs); instead we **teach the
pattern** in `docs/public/50-extend` and rely on this **public repository as the
living, dogfooded example** — customers read the real wrapper source we run
ourselves.

**Alternatives:**

- **(A) Wrap via the existing `command:` adapter; teach via docs + public
  dogfooding; don't ship wrappers as customer checks (CHOSEN).** Reuses a proven,
  in-production mechanism; unifies output (`Signal`, ADR-0011), suppression
  (ADR-0014), gate/ratchet, and dashboard behind one runner; turns our own source
  into the worked example. Con: not a performance win (each wrapped tool re-parses
  in its own subprocess — no shared parse); additive layer over each tool's config,
  not a reduction of it.
- **(B) Reimplement eslint/dependency-cruiser rules natively as fit checks
  (REJECTED).** Re-deriving a mature linter or graph-rule engine is unbounded
  maintenance and inevitably diverges from the canonical tool's semantics. The
  `command:` adapter exists precisely so we don't do this. (The repo already shows
  the cost of the split choice: `dead-code` *wraps* knip, while
  `circular-import-detection` and `module-coupling-fan-out` *reimplement*
  dependency-cruiser-style analysis natively — see Consequences.)
- **(C) Ship opinionated eslint/dependency-cruiser wrapper checks in
  `checks-universal` for customers (REJECTED).** A shipped wrapper that assumes a
  specific `eslint.config`/`dependency-cruiser.cjs` will no-op or emit false
  positives against a foreign toolchain, and it couples our published check pack to
  assumptions about the consumer's setup. Teach the pattern; let consumers wrap
  *their* config. The public repo is the reference implementation.
- **(D, status quo) Leave eslint + dependency-cruiser as independent `pnpm lint`
  steps indefinitely (REJECTED).** Fragments the `Signal` currency (ADR-0011), the
  inline-suppression model (ADR-0014), the baseline/ratchet, and the dashboard
  across N tool-specific formats. Misses the unification that is the platform's
  reason to exist.

**Rationale:** The mechanism is already proven in production — `defineCheck`
carries a first-class `command: { bin, args, parseOutput, expectedExitCodes,
timeout }` adapter, and four tools ship through it today
(`packages/fitness/checks-cpp/src/checks/clang-tidy-passthrough.ts`,
`checks-universal/.../quality/dead-code.ts` (knip),
`checks-universal/.../security/dependency-vulnerability-audit.ts`, and the
semgrep scan). Extending it to eslint and dependency-cruiser is therefore *not*
new architecture; it is finishing a pattern. The payoff is **unification, not
speed**: every finding becomes a `Signal` (ADR-0011) → one SARIF export, one Code
Scanning category, one dashboard; one suppression vocabulary (ADR-0014) instead of
`eslint-disable` + `depcruise-ignore` + knip ignores; one baseline ratchet; one
`--report-to` path. The secondary payoff is **credibility and pedagogy**: because
this repo is public, the wrappers we run in our own `fit:ci` are real, maintained,
copy-readable examples — customers can both *see that we dogfood it* and lift the
exact `command:` shape from source. This is strictly better than a synthetic doc
snippet that can rot out of sync with what we actually run.

**Consequences:**

- **eslint is the first increment** (separate local spec). It wraps `eslint` via
  `command:` and maps its JSON output to `Signal`s. Two requirements: (1) it must
  preserve **hard-fail-on-any-finding** semantics — lint errors are not subject to
  the net-new ratchet the way dogfood findings are; confirm the fit gate can
  express "fail on any finding from this check" per-check. (2) `eslint --fix`
  remains a separate developer workflow; the wrapper reports, it does not fix.
- **dependency-cruiser gets a bootstrap carve-out.** It may be surfaced through
  `fit`, but it **stays independently runnable** (the `pnpm lint` depcruise pass +
  `scripts/verify-gate-live.mjs`). The architecture gate guards the very layering
  `fit` depends on; routing it *only* through `fit` would mean a broken `fit`
  hides architecture regressions. Independence at that boundary is deliberate.
- **Codify wrap-vs-reimplement.** Default to the `command:` wrap for mature
  external tools; reimplement natively only for small, high-value checks that share
  fit's parse/file cache. This ADR does **not** mandate churning the existing
  native checks (`circular-import-detection`, `module-coupling-fan-out`) — it sets
  the rule for new ones and flags those two as the known prior inconsistency to
  revisit deliberately, not reflexively.
- **No wrapper checks in the published check packs.** Add a `docs/public/50-extend`
  guide ("wrap your linter as a fit check in ~20 lines") that links to the real
  source files (`clang-tidy-passthrough.ts`, `dead-code.ts`, the new eslint wrapper)
  as the canonical examples. The guide names the public source paths so readers go
  straight to what we run.
- **Additive, not a replacement.** The standalone tools and their ecosystems
  (editor integrations, `eslint --fix`, dependency-cruiser graph output) are
  unaffected; this consolidates CI + reporting + the teaching story, it does not
  retire the tools.
- Expect **no speedup** and a small subprocess overhead; the value is single-surface
  reporting and the public example, not wall-clock.

**Related specs / ADRs:** Implements the unification direction of
[ADR-0011](./ADR-0011-signal-output-currency-formatter-sink.md) (`Signal` as the
universal output currency) and [ADR-0014](./ADR-0014-shared-inline-signal-suppression.md)
(one inline-suppression model) by bringing the last independent quality tools under
that currency. The "teach, don't ship" half is the consumer-facing complement to
[ADR-0009](./ADR-0009-public-api-surface-policy.md)/[ADR-0013](./ADR-0013-fitness-curated-export-surface.md)
(curated surfaces — opinionated, config-coupled wrappers are not part of the
published authoring surface) and to [ADR-0007](./ADR-0007-marker-canonical-plugin-discovery.md)
(how a consumer authors and discovers their own plugin). The eslint wrapper and the
`50-extend` guide are tracked as follow-up work (local plan).
