# Phase 0: Generic marker walker

**Goal:** Hoist the marker-based discovery walker out of `tool-package-discovery.ts` into a generic `discoverPackagesByMarker(projectDir, kind)` in core. Refactor `tool-package-discovery.ts` to be a thin wrapper. This is the substrate Phases 3 and 4 build on.

**Depends on:** —

---

## Task 0.1: Add the generic walker module

**Files:** [size: M]
- Create: `packages/core/src/plugins/marker-discovery.ts`
- Create: `packages/core/src/plugins/__tests__/marker-discovery.test.ts` (scaffold only — Phase 7 fills in)

**Context:** Today `packages/core/src/plugins/tool-package-discovery.ts:57-105` implements the canonical marker walker for `kind: "tool"`. The body (`discoverToolPackages`, `collectFromNodeModules`, `isToolPackage`) is parameterised on a single constant `TOOL_KIND = 'tool'`. Fitness and simulation need the same walker with different kinds (`fit-pack`, `sim-pack`). Per CLAUDE.md's layering rules ("If you need to violate a rule, the right move is usually to refactor the shared piece into core"), the walker becomes a core primitive parameterised by `kind`.

The marker kind union is intentionally closed today (`'tool' | 'fit-pack' | 'sim-pack'`) — future kinds get added to the union explicitly rather than accepting arbitrary strings. This keeps the type signal informative for consumers and lets the type system catch typos at call sites.

**Steps:**

1. Create `packages/core/src/plugins/marker-discovery.ts` with the following exports:

   ```typescript
   export type MarkerKind = 'tool' | 'fit-pack' | 'sim-pack';

   export interface MarkerDiscoveryOptions {
     readonly projectDir: string;
     readonly kind: MarkerKind;
   }

   export interface DiscoveredMarkerPackage {
     readonly name: string;
     readonly packageDir: string;
     readonly kind: MarkerKind;  // echoed back so callers can multiplex
   }

   export function discoverPackagesByMarker(options: MarkerDiscoveryOptions): DiscoveredMarkerPackage[];
   ```

2. The walker body mirrors `tool-package-discovery.ts:57-104` exactly — same ancestor-walk shape, same flat + `@scope/` handling, same `seen` dedupe, same `safeReaddir` swallow. The only differences:
   - `TOOL_KIND` is replaced with `options.kind`.
   - `isToolPackage` becomes `readMarkerKind(packageDir): MarkerKind | undefined` that returns the package's declared `opensipTools.kind` if it matches the expected union (else undefined). The caller filters on equality.
   - The package-json read uses the same try/catch + debug-log pattern from `tool-package-discovery.ts:107-124`.

3. The new module exports a small typed-kind narrow: `isMarkerKind(value: unknown): value is MarkerKind` — useful in `readMarkerKind` and at any future call site that needs to validate dynamic input.

4. Add a scaffold test file `__tests__/marker-discovery.test.ts` with a single `describe` block and a `it('exists')` placeholder. Phase 7 fills in real test cases.

**Wiring:** Called by `tool-package-discovery.ts` (Task 0.2), and later by `fit.ts` (Phase 3) and `sim.ts` (Phase 4) via the core barrel re-export (Task 0.3). The walker has no upstream callers in core itself — it's a primitive consumers compose.

**Verification:**
```bash
pnpm --filter=@opensip-tools/core build
pnpm --filter=@opensip-tools/core typecheck
pnpm --filter=@opensip-tools/core test
```

**Commit:** `feat(core): generic marker-based plugin discovery walker`

---

## Task 0.2: Refactor `tool-package-discovery.ts` to delegate

**Files:** [size: S]
- Modify: `packages/core/src/plugins/tool-package-discovery.ts`

**Context:** Today this file owns the canonical walker. After Task 0.1, the walker lives in `marker-discovery.ts`. This file becomes a thin domain-typed wrapper that calls the generic walker with `kind: 'tool'` and returns the result with the existing `DiscoveredToolPackage` type. Existing call sites of `discoverToolPackages` continue working unchanged — the public API is unchanged.

**Steps:**

1. Replace the body of `discoverToolPackages` (lines 57-74) with a single call:
   ```typescript
   export function discoverToolPackages(options: ToolPackageDiscoveryOptions): DiscoveredToolPackage[] {
     return discoverPackagesByMarker({ projectDir: options.projectDir, kind: 'tool' })
       .map((pkg) => ({ name: pkg.name, packageDir: pkg.packageDir }));
   }
   ```

2. Delete `collectFromNodeModules`, `isToolPackage`, `safeReaddir`, and the `TOOL_KIND` constant — all now live in `marker-discovery.ts`.

3. Keep `readToolPackageMetadata` and the `ToolPackageMetadata` interface — those are orthogonal to discovery.

4. Update the file's `@fileoverview` to reflect the new shape (one paragraph: "thin wrapper around the generic marker walker for `kind: 'tool'`").

**Wiring:** No external API change. Consumers (`packages/cli/src/bootstrap/register-tools.ts`) call `discoverToolPackages` exactly as today.

**Verification:**
```bash
pnpm --filter=@opensip-tools/core build
pnpm --filter=@opensip-tools/core test
pnpm build
```

**Commit:** `refactor(core): tool-package-discovery delegates to generic marker walker`

---

## Task 0.3: Export from core barrel

**Files:** [size: XS]
- Modify: `packages/core/src/plugins/index.ts`
- Modify: `packages/core/src/index.ts`

**Context:** Fit and sim need to import `discoverPackagesByMarker`. Core's barrel needs the new export.

**Steps:**

1. In `packages/core/src/plugins/index.ts`, add:
   ```typescript
   export {
     discoverPackagesByMarker,
     isMarkerKind,
   } from './marker-discovery.js';
   export type {
     MarkerKind,
     MarkerDiscoveryOptions,
     DiscoveredMarkerPackage,
   } from './marker-discovery.js';
   ```

2. In `packages/core/src/index.ts`, re-export the same symbols.

**Wiring:** Once exported, fit and sim can `import { discoverPackagesByMarker } from '@opensip-tools/core'` in Phases 3 and 4.

**Verification:**
```bash
pnpm --filter=@opensip-tools/core build
pnpm typecheck
```

**Commit:** `feat(core): export discoverPackagesByMarker from plugins barrel`

---

## Phase 0 End-to-End Verification

- `pnpm --filter=@opensip-tools/core test` — all existing core tests pass; the `marker-discovery.test.ts` scaffold runs without errors (placeholder only).
- `pnpm --filter=@opensip-tools/cli typecheck` — `register-tools.ts` still resolves `discoverToolPackages` correctly.
- `pnpm lint` — 0 errors. Dependency-cruiser shows no new violations.

> **Deferred:** Observability event-name policy — `core.tool_discovery.read_failed` is generalised to `core.marker_discovery.read_failed`. Broader event-name catalog needs human review.
