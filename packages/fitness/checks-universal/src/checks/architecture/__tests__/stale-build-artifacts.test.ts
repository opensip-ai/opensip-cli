/**
 * Unit tests for the `stale-build-artifacts` check.
 *
 * Two layers:
 *  1. A config-shape assertion proving the fix for the "dead check for
 *     .js/.js.map" bug: the check's `scope` no longer restricts file
 *     discovery to typescript-language TARGETS, which glob source by
 *     `**\/*.ts(x)` extension and so never resolve a `.js`/`.js.map` path
 *     at all (see `resolveFilesForCheck` in fitness/engine's
 *     scope-resolver.ts). This can't be proven via the generic
 *     fixture-coverage harness (`fixture-coverage.test.ts`): that harness
 *     calls `check.run(root, { targetFiles })` with an EXPLICIT file
 *     list, bypassing scope-based target resolution entirely — it would
 *     pass even with the old typescript-only scope. Asserting the
 *     check's declared config directly is the only way, from this
 *     package, to pin the production-path fix (scope-based resolution
 *     itself is fitness-engine-internal and not exported for testing
 *     here).
 *  2. The `__fixtures__/stale-build-artifacts/{clean,violation}` trees
 *     (exercised by `fixture-coverage.test.ts`) prove the check's OWN
 *     detection logic correctly flags `.js`, `.d.ts`, and `.js.map`
 *     artifacts sitting next to their `.ts` source.
 */
import { describe, expect, it } from 'vitest';

import { staleBuildArtifacts } from '../stale-build-artifacts.js';

describe('stale-build-artifacts — scope no longer typescript-target-restricted', () => {
  it('declares a universal scope (file-cache fallback, not typescript-only targets)', () => {
    // Both empty is the load-bearing invariant: `resolveFilesForCheck`
    // only takes the scope-based target-matching path when EITHER array
    // is non-empty. A non-empty `languages: ['typescript']` (the pre-fix
    // declaration) resolves ONLY files matched by typescript-language
    // targets — which glob `**/*.ts(x)` and so never include a
    // `.js`/`.js.map` path in the first place, regardless of any
    // `fileTypes` filter applied downstream.
    expect(staleBuildArtifacts.config.checkScope?.languages ?? []).toHaveLength(0);
    expect(staleBuildArtifacts.config.checkScope?.concerns ?? []).toHaveLength(0);
  });

  it('declares fileTypes covering every ARTIFACT_EXTENSIONS suffix', () => {
    const fileTypes = new Set(staleBuildArtifacts.config.fileTypes);
    // '.js'     -> path.extname() === '.js'  -> fileTypes must have 'js'
    // '.d.ts'   -> path.extname() === '.ts'  -> fileTypes must have 'ts'
    // '.js.map' -> path.extname() === '.map' -> fileTypes must have 'map'
    expect(fileTypes.has('js')).toBe(true);
    expect(fileTypes.has('ts')).toBe(true);
    expect(fileTypes.has('map')).toBe(true);
  });
});
