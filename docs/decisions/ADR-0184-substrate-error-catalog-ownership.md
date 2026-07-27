---
status: active
last_verified: 2026-07-25
owner: opensip-cli
---

# ADR-0184: Let substrate packages own error codes

```yaml
id: ADR-0184
title: Let substrate packages own error codes
date: 2026-07-25
status: active
supersedes: []
superseded_by: null
related: [ADR-0181, ADR-0183, ADR-0055, ADR-0151]
tags: [errors, plugins, architecture]
enforcement: mechanizable
enforced-by: [script:extract-error-catalog-metadata, script:verify-core-exports, type-structural]
enforcement-reason: >
  Cross-owner code uniqueness is enforced twice: at build time by the catalog manifest that
  generates docs/public/70-reference/18-error-code-index.md, and at runtime by
  ToolRegistry.getErrorCatalogIndex(), which now aggregates substrate catalogs alongside tool
  catalogs and throws ErrorDefinitionError on a collision.
```

**Decision:** A package that is not a Tool may own registered error codes. Ownership is keyed
on its npm package name, it declares codes through `defineErrorCatalog` exactly as a Tool
does, and the CLI composition root supplies the resulting catalogs to the per-invocation
`ToolRegistry` — which aggregates them with tool catalogs under one collision rule. Core is
the single exception to package-name keying: it keeps its already-published owner id
`opensip-cli.core`.

**Alternatives:**

- *Leave substrates unable to own codes (status quo).* Rejected: it is the reason a
  `@opensip-cli/codebase` failure normalized at the composition root recorded the **host** as
  the owner of a failure the host never raised, and why `legacyFamilyCode`'s family fallback
  erased the failure axes.
- *Give every substrate a synthetic tool UUID.* Rejected: a UUID that identifies no Tool is a
  lie in the evidence, and it would make `agent-catalog` and MCP report tools that do not
  exist.
- *Route substrate codes through the depending Tool's catalog.* Rejected: `@opensip-cli/codebase`
  is consumed by `graph`, `mcp` and the host, so its codes would have two or three owners
  depending on the call path — the exact ambiguity registration exists to remove.
- *A process-global catalog map.* Rejected: it reintroduces module-level mutable run state,
  which the RunScope work removed on purpose, and pnpm's `injectWorkspacePackages` can place
  two physical copies of a package in one process, so "global" would not even be global.
- *Build-time uniqueness only, no runtime aggregation.* Rejected: first-party collisions are
  indeed settled at build time, but a **third-party** tool can claim a substrate-owned code,
  and that is only knowable at runtime.

**Rationale:** Before this decision the only registration path was
`ToolExtensionPoints.errorCatalog`, so ownership was available exclusively to Tools. That is
an accident of where the extension point was introduced, not a property of the domain:
`config`, `datastore`, `session-store`, `output`, `codebase`, `targeting` and `tree-sitter`
all produce failures with distinct, actionable semantics, and all of them were being reported
through a family fallback that flattened those semantics to `SYSTEM_ERROR` — kind `invariant`,
retry `never`, action "report a bug".

Substrates are folded into the aggregate **before** tool catalogs
(`packages/core/src/tools/error-catalog.ts`), so a tool contributing a code a substrate
already owns is reported as a collision instead of silently taking ownership by merge order.
The registration entry point is `ToolRegistry.registerSubstrateCatalog`, which is idempotent
per package name because the host legitimately builds more than one registry per process (the
lightweight command probe does).

Keeping core on `opensip-cli.core` is deliberate: that owner id is already published in the
generated error-code index, so re-keying it to `@opensip-cli/core` would break the one owner
identity that is already public. Core therefore has two catalogs under one identity —
`coreSystemErrorCatalog` (the legacy adapter that `definitionFromLegacyCode` and
`fromNativeError` resolve against, unchanged) and `coreErrorCatalog` (codes registered from
this decision onward). A unit test pins that the two are disjoint, because two definitions for
one code would let resolution order decide the axes.

**Consequences:**

- Adding a substrate catalog is a deliberate host change: export the catalog, add it to
  `HOST_SUBSTRATE_ERROR_CATALOGS` in the CLI bootstrap, and add its module to
  `CATALOG_SOURCES` in `scripts/extract-error-catalog-metadata.mjs` so the build-time manifest
  and the generated index see it.
- Substrate catalogs are static, not discovered. These are first-party packages compiled into
  the CLI; discovering them would add a filesystem walk to every startup to answer a question
  already settled at build time.
- `@opensip-cli/contracts` deliberately gets **no** owner. It is a contract facade; its sites
  migrate onto core codes.
- `@opensip-cli/tree-sitter` now declares a dependency on `@opensip-cli/core`. The layering
  rule in `.config/dependency-cruiser.cjs` already permitted it ("depends on web-tree-sitter
  and optionally core"); only the manifest entry was missing.
- The build-time extractor resolves file-local shared axis bases (`...TOOL_AUTHORING`), because
  definitions that share a responsibility/kind cluster spread a base rather than repeating
  eight axes — and without resolution the published index would show blank axes for exactly
  the most consistent definitions.

**Related ADRs:** ADR-0181 (structured error definitions and the failure envelope) introduced
`ErrorDefinition`, `defineErrorCatalog` and the Tool-only registration path this ADR widens.
ADR-0183 (explicit retry, cancellation and safe failure sinks) supplies the axes these
definitions are chosen against. ADR-0055 / ADR-0151 govern the core export allowlist that the
new public exports pass through.
