/**
 * Resolver entry-point.
 *
 * The resolver itself lives inside `builder.ts` because it has to share the
 * ts.Program / TypeChecker that's already constructed there. This file is
 * a thin re-export so callers (analysis, tests) reach the resolver-mode
 * type from a stable location.
 */

export type { ResolverMode } from './builder.js';
