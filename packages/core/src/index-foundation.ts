// Languages — cross-language adapter API
export * from './languages/index.js';

// Project config resolution
export { PROJECT_CONFIG_FILENAME, resolveProjectConfigPath } from './config-resolution.js';

// Public API surface reachability (package.json exports → re-export graph)
export { _resetPublicApiGraphCache, isInPublicApiSurface } from './lib/public-api-surface.js';