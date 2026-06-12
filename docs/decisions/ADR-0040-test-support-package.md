---
status: active
last_verified: 2026-06-12
owner: opensip-tools
---

# ADR-0040: Cross-package test scaffolding lives in an unpublished test-support package

```yaml
id: ADR-0040
title: Cross-package test scaffolding lives in an unpublished test-support package
date: 2026-06-12
status: active
supersedes: []
superseded_by: null
related: [ADR-0009, ADR-0013]
tags: [testing, packaging, layering, public-api]
enforcement: mechanizable
enforcement-reason: >
  dependency-cruiser rule `no-prod-import-of-test-support`
  (.config/dependency-cruiser.cjs) forbids any non-test module outside
  packages/test-support from importing it (liveness probed on introduction).
  `package.json#private: true` keeps it out of the release order
  (scripts/release-package-order.mjs filters private packages), so it can
  never ship. Core no longer publishes a `test-utils` subpath (exports map +
  the ESLint barrel rule's sanction list).
```

**Decision:** Cross-package TEST scaffolding lives in `@opensip-tools/test-support`
— a `private: true`, never-published workspace package consumed only as a
devDependency by test files. It hosts (1) the `RunScope` test sugar
(`makeTestScope` / `withScope` / `withScopeSync`), formerly the **published**
`@opensip-tools/core/test-utils/with-scope.js` subpath, and (2) the per-check
fixture-coverage harness (`runCheckOnFixture`, `planCoverageCases`,
`buildFixtureManifest`, …), formerly production source under
`packages/fitness/engine/src/fixture-coverage/` re-exported through
`@opensip-tools/fitness/internal`. `fitness/internal` shrinks to `executeFit`
(the SaaS-mode smoke test's seam). Production source must never import
test-support.

**Alternatives:**

- *Keep `core/test-utils` as a published subpath* — rejected: a test harness on
  the kernel's public surface is a quasi-public API that external consumers can
  (and eventually will) treat as a stable contract, and fitness production
  source importing it blurred the "tools read core's public barrel" policy.
- *Keep the fixture harness in fitness src behind `/internal`* — rejected: with
  the scope sugar leaving core's surface, `run-check-on-fixture.ts` (production
  source) would need to import the private test-support package — a phantom
  dependency in a published package. Moving the whole harness out also ends the
  anomaly of test infrastructure compiling into a published `dist/`.
- *Two packages (core-level scope sugar + fitness-level fixture harness)* —
  rejected as overweight: the only consumers needing the fixture harness (check
  packs) are already downstream of fitness, so one package with a fitness
  dependency serves both families without adding a publishable surface.

**Rationale:** Audit finding (architectural-health review, 2026-06-11): test
helpers exported from `@opensip-tools/core/test-utils`, consumed by fitness
*production* files, re-exposed through `@opensip-tools/fitness/internal` — a
controlled but steadily widening quasi-public test surface. The fix follows the
repo's own pattern for surfaces that must exist but must not be public:
make the boundary structural (separate private package + depcruise rule), not
conventional (a doc comment asking people not to import it).

**Consequences:**

- Because test-support depends on `@opensip-tools/fitness`, the **fitness
  engine's own tests cannot import it** (the dev edge would make the package
  graph cyclic and break turbo). Same for `core`. Their tests use core's
  public `RunScope` API directly via small file-local helpers — deliberate,
  documented duplication of ~3 lines over an architectural cycle.
- Graph/simulation/cli test utilities (`with-graph-scope`, `with-sim-scope`,
  telemetry tests) also use core's public API directly rather than coupling
  their test graphs to the fitness engine through test-support.
- Check packs consume `@opensip-tools/test-support` as a devDependency for
  fixture-coverage tests; `@opensip-tools/fitness/internal` no longer exports
  the harness.
- The ESLint check-pack barrel rule's sanctioned core subpaths shrink to
  `languages/*`.
