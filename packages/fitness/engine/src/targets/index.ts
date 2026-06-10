/**
 * @fileoverview Target system barrel export
 *
 * Public API for config-driven targets:
 * - loadTargetsConfig() — Load from opensip-tools.config.yml
 * - resolveTargetFiles() — Expand globs, deduplicate
 */

// Loader
export { loadTargetsConfig } from './loader.js';

// Resolver
export { resolveTargetFiles } from './resolver.js';
