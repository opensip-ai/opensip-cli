/**
 * @fileoverview Target system barrel export (fitness-internal)
 *
 * - loadTargetsConfig() — Load checkOverrides/plugins/globalExcludes from
 *   opensip-tools.config.yml and mirror the host-built `scope.targets` set into
 *   a fitness registry (ADR-0037).
 * - TargetRegistry — the fitness subclass (substrate registry + check-domain
 *   `findByScope`). NOT a public engine export (`public-api.test.ts` asserts it
 *   stays internal).
 * - resolveTargets / preResolveAllTargets / applyGlobalExcludes — re-exported
 *   from `@opensip-tools/targeting` so fitness-internal consumers (scope-resolver,
 *   execution-context) have a single import surface for the generic glob
 *   mechanics that now live once in the substrate.
 */

// Loader
export { loadTargetsConfig } from './loader.js';

// Fitness registry subclass (internal — adds findByScope over the substrate base)
export { TargetRegistry } from './target-registry.js';

// Generic glob mechanics — single-sourced in the host substrate (ADR-0037)
export { resolveTargets, preResolveAllTargets, applyGlobalExcludes } from '@opensip-tools/targeting';
