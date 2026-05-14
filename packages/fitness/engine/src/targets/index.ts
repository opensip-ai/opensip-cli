/**
 * @fileoverview Target system barrel export
 *
 * Public API for config-driven targets:
 * - loadTargets() — Load from opensip-tools.config.yml
 * - resolveTargetFiles() — Expand globs, deduplicate
 * - TargetRegistry — Lookup by name/tag
 * - Target, TargetConfig — Types
 */

// Types
export type { Target, TargetConfig, CheckTargetMap, TargetsConfig, TargetEntry, TargetConfigInput } from './types.js'

// Config API
export { defineTargetConfig } from './define-target-config.js'

// Loader
export { loadTargets, loadTargetsConfig } from './loader.js'

// Resolver
export { resolveTargetFiles } from './resolver.js'

// Registry
export { TargetRegistry, defaultTargetRegistry } from './target-registry.js'
