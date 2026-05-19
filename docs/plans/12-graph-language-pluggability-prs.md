---
status: proposed
last_verified: 2026-05-18
title: "graph Tool — language pluggability: PR-2 and PR-3 file plan"
audience: [contributors, maintainers]
purpose: "File-by-file diff sequencing for PR 2 (extract lang-typescript) and PR 3 (introduce GraphLanguageAdapter contract). Lets a reviewer or contributor know exactly what changes in each PR before any code is written."
related-docs:
  - ./10-graph-language-pluggability.md
  - ./11-graph-language-adapter-contract.md
---

# graph Tool — language pluggability: PR-2 and PR-3 file plan

This doc operationalizes [`10-graph-language-pluggability.md`](./10-graph-language-pluggability.md) into a reviewable diff sequence for the two refactor PRs. PR 1 is the plan docs (already in this directory); PR 4 is contributor docs (separate file); PRs 5+ are deferred adapter implementations.

The two PRs split is deliberate: **PR 2 is a code-move, PR 3 is the contract.** A reviewer can approve PR 2 by checking that no logic changed; PR 3 is where the architectural decisions land. Mixing them would mean every move *and* every contract decision lives in one diff — too big to review well.

---

## PR 2 — Extract `lang-typescript` subdirectory

### Intent

Move every TypeScript-specific source file under `packages/graph/engine/src/` into a new `packages/graph/engine/src/lang-typescript/` subdirectory. **No logic changes. No new abstractions.** Imports update to point at the new paths; everything else is identical.

### Files moved (no content edits)

```
packages/graph/engine/src/pipeline/walk.ts
  → packages/graph/engine/src/lang-typescript/walk.ts

packages/graph/engine/src/pipeline/inventory.ts
  → packages/graph/engine/src/lang-typescript/inventory.ts

packages/graph/engine/src/pipeline/edges.ts
  → packages/graph/engine/src/lang-typescript/edges.ts

packages/graph/engine/src/pipeline/discover.ts
  → packages/graph/engine/src/lang-typescript/discover.ts

packages/graph/engine/src/pipeline/inventory-visitors/
  → packages/graph/engine/src/lang-typescript/inventory-visitors/
  (all 9 files including types.ts and module-init.ts)

packages/graph/engine/src/pipeline/inventory-helpers/
  → packages/graph/engine/src/lang-typescript/inventory-helpers/
  (all helper files including hash-body.ts, classify-visibility.ts, etc.)

packages/graph/engine/src/pipeline/edge-resolvers/
  → packages/graph/engine/src/lang-typescript/edge-resolvers/
  (all 7 files including types.ts and catalog-fallback.ts)

packages/graph/engine/src/pipeline/edge-helpers/
  → packages/graph/engine/src/lang-typescript/edge-helpers/

packages/graph/engine/src/pipeline/normalize-project-dir.ts
  → packages/graph/engine/src/lang-typescript/normalize-project-dir.ts
```

### Files updated (import-path edits only)

- `packages/graph/engine/src/cli/orchestrate.ts` — its `import { walkProgram } from '../pipeline/walk.js'` becomes `import { walkProgram } from '../lang-typescript/walk.js'`. Same for `discoverFiles`, `resolveEdgesFromRecords`. The orchestrator behavior is unchanged.
- `packages/graph/engine/src/__tests__/**/*.ts` — every test file that imported from `pipeline/inventory-visitors/`, `pipeline/edge-resolvers/`, etc. updates to the new paths. Roughly 30 test files; mechanical sed-style edit.
- `packages/graph/engine/src/__tests__/inventory-differential.test.ts`, `inventory-shape-coverage.test.ts`, `inventory-property-tests.test.ts` — pull in the moved modules; same import-path edit.
- `packages/graph/engine/src/cli/scope.ts` — currently has TS-aware tsconfig logic; moves to `lang-typescript/scope.ts` BUT keeps a thin wrapper at the original path that delegates. Reason: `--package` and `--packages` are in the engine's CLI surface; PR 2 doesn't change that surface. PR 3 dissolves the wrapper.

### Files NOT moved

- `pipeline/indexes.ts` — language-agnostic. Builds inverted indexes over the catalog using only `bodyHash` and structural fields. Stays in `pipeline/`.
- Everything under `cache/`, `rules/`, `render/`, `cli/` (except scope.ts) — language-agnostic.
- `tool.ts`, `index.ts`, `gate.ts`, `errors.ts`, `types.ts` — engine surface. PR 3 edits `types.ts` for catalog v3; PR 2 leaves it alone.

### New file in PR 2

```
packages/graph/engine/src/lang-typescript/index.ts
```

Acts as the public face of the lang-typescript subdirectory. Re-exports `walkProgram`, `resolveEdgesFromRecords`, `discoverFiles`, etc. so the orchestrator can import them via one symbol. **No `GraphLanguageAdapter` interface yet** — that's PR 3. PR 2 just gives the orchestrator one place to import from instead of seven.

```ts
// PR 2 shape (no contract yet):
export { walkProgram } from './walk.js';
export { discoverFiles } from './discover.js';
export {
  resolveEdgesFromRecords,
  buildAndResolveCatalog,
} from './edges.js';
// ...
```

### dep-cruiser additions

`.dependency-cruiser.cjs` gains rules:

```js
{
  name: 'no-typescript-import-outside-lang-typescript',
  severity: 'error',
  comment: 'Only the lang-typescript adapter may import the TypeScript compiler API.',
  from: { path: '^packages/graph/engine/src/(?!lang-typescript/)' },
  to:   { path: '^typescript$' },
},
```

After PR 2, attempting to add `import ts from 'typescript'` in any other file fails `pnpm lint`.

### Acceptance for PR 2

- `pnpm test` — all 36 packages pass.
- `pnpm typecheck` — clean.
- `pnpm lint` — clean (the new dep-cruiser rule passes since all `'typescript'` imports moved into `lang-typescript/`).
- **Byte-identical catalog gate:** capture the v2 catalog MD5 from `main` before merging; rebuild on the PR branch; compare. Must match.
- `node packages/cli/dist/index.js graph` against opensip-tools self-graph: 0 findings, same as today.

### Risk

Low. The diff is 95% file moves and import-path edits. The byte-identical-catalog gate is the safety net. If the gate fails, something other than a pure move happened — investigate before merging.

### Estimated review time

1 hour. The diff is large in line count but trivial per file.

---

## PR 3 — Introduce the `GraphLanguageAdapter` contract

### Intent

The contract from [`11-graph-language-adapter-contract.md`](./11-graph-language-adapter-contract.md) lands in code. The orchestrator routes through it. The TypeScript adapter is the only registered adapter; future adapters land in PRs 5+. Catalog format bumps from v2 to v3.

### New files

```
packages/graph/engine/src/lang-adapter/types.ts
```

The `GraphLanguageAdapter` interface and associated types (`DiscoverInput`, `WalkInput<P>`, `ResolveOutput`, etc.). Contract methods are purely type signatures here — no implementation.

```
packages/graph/engine/src/lang-adapter/registry.ts
```

A small registry: `Map<string, GraphLanguageAdapter>`. Functions `registerAdapter(adapter)` and `findAdapter(id)`. Initialized empty; the engine bootstrap calls `registerAdapter(typescriptGraphAdapter)`.

```
packages/graph/engine/src/lang-typescript/parse.ts
```

Hosts the `parseProject` implementation. Lifts `ts.createProgram` and the eager `getTypeChecker()` call out of `cli/orchestrate.ts:buildAndResolveCatalog` into the adapter. The orchestrator stops importing `'typescript'` after this lift.

```
packages/graph/engine/src/lang-typescript/cache-key.ts
```

`cacheKey({ projectDirAbs, configPathAbs, compilerOptions })` returns `ts-${ts.version}-${tsconfigContentHash}`. Replaces the two-field cache key (`tsCompilerVersion` + `tsConfigPath`) that lives in `cache/invalidate.ts` today.

### Files edited

```
packages/graph/engine/src/lang-typescript/index.ts
```

Now exports `typescriptGraphAdapter: GraphLanguageAdapter`. Internal wrapper functions adapt the existing exports (`walkProgram`, `resolveEdgesFromRecords`, `discoverFiles`) into the contract method signatures. `walkProgram`'s return type becomes `WalkOutput`; `resolveEdgesFromRecords`'s becomes `ResolveOutput`.

```ts
// PR 3 shape:
export const typescriptGraphAdapter: GraphLanguageAdapter<TypescriptParsedProject> = {
  id: 'typescript',
  fileExtensions: ['.ts', '.tsx'],
  displayName: 'TypeScript',
  discoverFiles,
  parseProject,
  walkProject: (input) => {
    const out = walkProgram({ /* delegate */ });
    return out;
  },
  resolveCallSites: (input) => {
    const result = resolveEdgesFromRecords({ /* delegate */ });
    return { edgesByOwner: collectByOwner(result), stats: result.resolutionStats };
  },
  cacheKey,
  ruleHints: { /* migrated from inline constants */ },
};
```

```
packages/graph/engine/src/cli/orchestrate.ts
```

The big edit. Before:
```ts
import { walkProgram } from '../lang-typescript/walk.js';
import { resolveEdgesFromRecords } from '../lang-typescript/edges.js';
// ...

function buildAndResolveCatalog(discovery) {
  const program = ts.createProgram(...);
  program.getTypeChecker();
  const walked = walkProgram({ program, files, projectDirAbs });
  const initialCatalog = { /* hand-rolled, includes tsConfigPath, tsCompilerVersion */ };
  const result = resolveEdgesFromRecords({ catalog: initialCatalog, program, ... });
  return { catalog: result.catalog, resolutionStats: result.resolutionStats };
}
```

After:
```ts
import { findAdapter } from '../lang-adapter/registry.js';

function buildAndResolveCatalog(discovery) {
  const adapter = pickAdapter(discovery);   // new helper; PR 3 returns 'typescript'
  const parsed = adapter.parseProject({ projectDirAbs, files, compilerOptions });
  const walked = adapter.walkProject({ project: parsed.project, projectDirAbs, files });
  const catalog = assembleCatalog({
    language: adapter.id,
    cacheKey: adapter.cacheKey({ projectDirAbs, configPathAbs, compilerOptions }),
    occurrences: walked.occurrences,
  });
  const resolved = adapter.resolveCallSites({
    project: parsed.project,
    catalog,
    callSites: walked.callSites,
    projectDirAbs,
  });
  return {
    catalog: stitchEdges(catalog, resolved.edgesByOwner),
    resolutionStats: resolved.stats,
  };
}
```

The orchestrator no longer imports `'typescript'` at all. The new `pickAdapter` helper is trivial in PR 3 (always returns `typescript`); a future PR teaches it to introspect file extensions.

```
packages/graph/engine/src/cache/invalidate.ts
```

`classifyCatalog` updates: instead of comparing `tsCompilerVersion` and `tsConfigPath` separately, it compares the cached `language` and `cacheKey` against the current adapter's. Mismatched language → invalid; matched language with mismatched key → invalid; matched both → check filesFingerprint as today.

```
packages/graph/engine/src/cache/normalize.ts
packages/graph/engine/src/cache/read.ts
packages/graph/engine/src/cache/write.ts
```

Update for the v3 catalog shape. Removed fields: `tsConfigPath`, `tsCompilerVersion`. Added fields: `language`, `cacheKey`. Bump `version: '3.0'`. The streamed-write logic from Phase 2 of the perf plan continues to work — it doesn't care about the catalog's specific fields, only that the metadata serializes via `JSON.stringify`.

```
packages/graph/engine/src/types.ts
```

The `Catalog` interface updates:

```ts
// before (v2):
export interface Catalog {
  readonly version: '2.0';
  readonly tool: 'graph';
  readonly language: 'typescript';
  readonly builtAt: string;
  readonly tsConfigPath: string;
  readonly tsCompilerVersion: string;
  readonly filesFingerprint?: string;
  readonly functions: Readonly<Record<string, readonly FunctionOccurrence[]>>;
}

// after (v3):
export interface Catalog {
  readonly version: '3.0';
  readonly tool: 'graph';
  readonly language: string;       // adapter id
  readonly builtAt: string;
  readonly cacheKey: string;       // adapter-supplied
  readonly filesFingerprint?: string;
  readonly functions: Readonly<Record<string, readonly FunctionOccurrence[]>>;
}
```

`FunctionOccurrence`, `CallEdge`, `Param`, etc. are unchanged.

```
packages/graph/engine/src/cli/scope.ts
```

The wrapper added in PR 2 dissolves. `--package` and `--packages` resolution moves into a generic helper that asks the adapter "where's your config file?" and uses the response. The TypeScript adapter returns `tsconfig.json`; future adapters return `pyproject.toml` / `Cargo.toml` / etc.

```
packages/graph/engine/src/tool.ts
```

The graph tool's `register()` adds one line at the top:

```ts
import { registerAdapter } from './lang-adapter/registry.js';
import { typescriptGraphAdapter } from './lang-typescript/index.js';
registerAdapter(typescriptGraphAdapter);
```

Future adapters' tools call `registerAdapter` similarly.

### dep-cruiser additions

```js
{
  name: 'pipeline-no-lang-import',
  severity: 'error',
  from: { path: '^packages/graph/engine/src/(?:pipeline|cache|rules|render)/' },
  to:   { path: '^packages/graph/engine/src/lang-' },
},
{
  name: 'orchestrate-no-direct-lang-import',
  severity: 'error',
  comment: 'Orchestrator routes through lang-adapter/registry only, not lang-typescript directly (except tool.ts for registration).',
  from: { path: '^packages/graph/engine/src/cli/orchestrate\\.ts$' },
  to:   { path: '^packages/graph/engine/src/lang-typescript/' },
},
```

### Test additions

```
packages/graph/engine/src/__tests__/lang-adapter-contract.test.ts
```

The contract test suite from [`11-graph-language-adapter-contract.md`](./11-graph-language-adapter-contract.md) §5. Validates each of I-1 through I-9 against the TypeScript adapter using a small fixture project. Future adapters' PRs add `describe` blocks against their own fixtures.

### Acceptance for PR 3

- `pnpm test` — all 36 packages pass; new contract test suite passes.
- `pnpm typecheck` — clean.
- `pnpm lint` — clean (new dep-cruiser rules pass).
- **Byte-identical catalog gate:** the v3 catalog will differ from the v2 baseline because the *fields* changed (`tsCompilerVersion` removed, `cacheKey` added). The gate becomes: regenerate the v3 baseline once on the PR branch; subsequent rebuilds on that branch must produce the same MD5. *Within the v3 era*, two rebuilds match.
- `node packages/cli/dist/index.js graph` against opensip-tools self-graph: 0 findings, same as today, with the v3 catalog format.
- A v2-format catalog on disk loaded by the new code: returns `'invalid'` from `classifyCatalog`. User sees one cold rebuild. Verified by a unit test that hand-writes a v2 catalog and confirms the rebuild path runs.

### Risk

Medium. This is the architectural diff. The contract test suite is the safety net for PR 5+ refinements; the byte-identical-catalog gate is the safety net for PR 3 itself. The bump to catalog v3 is the most-visible user-facing change; documented in CHANGELOG.

### Estimated review time

3 hours. The diff is moderate in line count but every line is a contract decision.

---

## PR ordering and timing

| PR | Lines | Review time | Risk | Rollback |
|---|---|---|---|---|
| 1 — Plan docs (this set) | ~1500 prose | 30 min | None | Delete files |
| 2 — Extract `lang-typescript/` | ~800 (mostly moves) | 1 hour | Low | `git revert` |
| 3 — Adapter contract + v3 catalog | ~600 | 3 hours | Medium | `git revert`; users get one cache invalidation |
| 4 — Contributor authoring guide | ~400 prose | 1 hour | None | Delete file |
| 5 — Python adapter | ~1200 | 2-3 hours | Low (additive) | Don't register the adapter |
| 6+ — Rust / Go / Java / C/C++ | ~1000 each | 2 hours each | Low (additive) | Same |

Total path to Python support: ~7 hours of focused review across PRs 1-5, distributed across whoever is reviewing. PRs 1-4 should land in close succession (within a week or two of starting) so the contract is fresh in reviewers' heads when PR 5 arrives. PR 5 is the contract's first real test; expect 1-2 follow-up PRs to refine. PR 6 validates that the contract held under refinement.

---

## What this plan does NOT cover

- **Per-rule fidelity tuning.** §6 of the master plan describes `minConfidence` as a config knob; the PRs above don't ship that knob. It's a Wave-2 follow-up after PR 5 ships and we have real data on Python edge confidence.
- **Auto-detection of project language.** PR 3 ships `pickAdapter()` as "always returns typescript." A future PR teaches it to look at file extensions in the project. Out of scope here.
- **CLI-level `--language` flag.** Same — defer until two adapters are registered.
- **The dashboard's per-language behavior.** The Code Paths view currently assumes TypeScript-shaped data. After PR 5 it should be visibly tested against Python-shaped catalogs. Mostly will Just Work because it consumes the same `Catalog` shape; flag any glitches in PR 5's review.

---

## References

- [`10-graph-language-pluggability.md`](./10-graph-language-pluggability.md) — master plan: motivation, sequencing, gates.
- [`11-graph-language-adapter-contract.md`](./11-graph-language-adapter-contract.md) — interface, invariants, test contract.
- [`00-graph-performance-improvements.md`](./00-graph-performance-improvements.md) — perf-plan history; Wave 4's `cache/invalidate.ts` and `walk.ts` are central here.
- [`docs/architecture/40-the-graph-loop/01-stages-and-catalog.md`](../architecture/40-the-graph-loop/01-stages-and-catalog.md) — current pipeline architecture; gets a follow-up edit after PR 3 to describe the adapter layer.
