---
status: active
last_verified: 2026-07-12
owner: opensip-cli
---

# ADR-0157: Measure Agent Usability From A Black-Box Package

```yaml
id: ADR-0157
title: Measure agent usability from a black-box package
date: 2026-07-12
status: active
supersedes: []
superseded_by: null
related: [ADR-0040, ADR-0095]
tags: [architecture, depcruise, testing, evaluation]
enforcement: mechanizable
enforced-by: ['depcruise:agent-eval-imports-nothing-workspace', 'depcruise:no-import-of-agent-eval', 'eslint:no-restricted-imports']
enforcement-reason: >
  The package-scoped ESLint no-restricted-imports rules close dependency-
  cruiser's test-file exclusion gap, and the dependency-cruiser types
  companion reruns the complete base ruleset so type-only source edges are
  covered as well.
```

**Decision:** Measure OpenSIP's agent-facing surface from outside it.
`@opensip-cli/agent-eval` is a workspace-private, never-published development
package with zero workspace source imports in either direction. It spawns
`packages/cli/dist/index.js` and speaks MCP over stdio. Its sole workspace
reference is a `devDependency` on `opensip-cli` for build ordering; that
reference grants no source-import exception.

The harness is not a Tool, command specification, check pack, or RunScope
consumer. It owns no production command surface and does not participate in the
runtime package-layer DAG it measures.

**Alternatives:**

- **Import MCP or Tool engine internals.** Rejected because coupling the
  instrument to the implementation under test would invalidate its call-count
  and response-byte measurements and make internal churn look like product
  regressions.
- **Extend `@opensip-cli/test-support` or `@opensip-cli/tool-test-kit`.**
  Rejected because those packages support in-process Tool and RunScope tests;
  they cannot prove the behavior of a built, scope-owning CLI process.
- **Host the harness in another repository.** Rejected because the fixtures,
  version, build, and exclusion proofs must advance atomically with the public
  surface being evaluated.
- **Implement the harness as a Tool plugin.** Rejected because an instrument
  for the Tool plane must not acquire that plane's capabilities or lifecycle.

**Rationale:** The workspace has no catch-all dependency-cruiser rule that
would constrain a new private package, and dependency-cruiser intentionally
does not inspect test files. The paired forward/reverse dependency rules and
package-scoped ESLint guard therefore make the isolation claim executable for
production, test, static, dynamic, value, and type-only imports.

The package deliberately replicates only the small process and SDK patterns it
needs. Its deterministic environment and bounded spawn behavior follow
[`scripts/cli-acceptance-core.mjs`](../../scripts/cli-acceptance-core.mjs), and
its stdio client follows the public-process pattern exercised by
[`packages/mcp/src/__tests__/e2e-stdio.test.ts`](../../packages/mcp/src/__tests__/e2e-stdio.test.ts).
Importing either implementation would cross the boundary this decision exists
to protect.

**Consequences:**

- The package remains outside release publication order, but its version,
  lockfile, tests, coverage, architecture inventory, and private-package
  governance advance with the monorepo.
- MCP surface changes are absorbed by versioned strategies. Frozen tasks,
  fixtures, assertions, and ground truth do not change merely to make a new
  surface look better.
- Replicated process and protocol precedents can drift. The fail-loud
  prerequisite probes, wire validation, and `--smoke` run are the rot canaries.
- Any future workspace source edge to or from `packages/agent-eval` requires a
  new ADR that replaces this posture; weakening an import rule is not a local
  implementation detail.

**Related specs / ADRs:** [ADR-0040](ADR-0040-test-support-package.md) provides
the private-package reverse-boundary precedent, and
[ADR-0095](ADR-0095-ai-native-guardrail-platform-posture.md) keeps model
execution out of the CLI. The local implementation plan is
`docs/plans/ready/03-agent-eval-harness/`.
