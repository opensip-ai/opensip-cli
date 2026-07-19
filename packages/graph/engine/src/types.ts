/**
 * @fileoverview Compatibility re-export barrel for the graph engine's shared
 * type layer. The declarations live in cohesive per-domain modules under
 * `./types/`; this barrel keeps every historical `./types.js` import path
 * (engine internals, graph-* adapters, tests) resolving unchanged.
 */

export * from './types/call-graph.js';
export * from './types/config.js';
export * from './types/dependency.js';
export * from './types/features.js';
export * from './types/rules.js';
export * from './types/semantic-facts.js';
