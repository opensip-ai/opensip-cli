/**
 * @fileoverview Built-in fitness recipe definitions
 *
 * Defines the standard set of recipes (default, quick-smoke, backend, etc.)
 * that ship with the fitness framework.
 */

import { DEFAULT_MAX_PARALLEL, defineRecipe, type FitnessRecipe } from './types.js';

// =============================================================================
// DEFAULT RECIPE
// =============================================================================

/** Default recipe: runs all enabled checks in parallel */
const defaultRecipe: FitnessRecipe = defineRecipe({
  name: 'default',
  displayName: 'Default',
  description: 'Run all enabled checks in parallel',
  checks: { type: 'all' },
  execution: { mode: 'parallel', stopOnFirstFailure: false, timeout: 30_000 },
  reporting: { format: 'table', verbose: false },
  tags: ['comprehensive', 'default'],
});

// =============================================================================
// QUICK SMOKE RECIPE
// =============================================================================

/** Quick smoke recipe: fast critical checks for rapid validation */
const quickSmokeRecipe: FitnessRecipe = defineRecipe({
  name: 'quick-smoke',
  displayName: 'Quick Smoke',
  description: 'Fast critical checks for rapid validation',
  checks: {
    type: 'explicit',
    checkIds: [
      'no-console-log',
      'no-any-types',
      'null-safety',
      'detached-promises',
      'catch-clause-safety',
      'error-handling-quality',
      'no-hardcoded-secrets',
      'no-eval',
      'sql-injection',
      'env-secret-exposure',
      'input-sanitization',
      'no-skipped-tests',
    ],
  },
  execution: { mode: 'parallel', stopOnFirstFailure: false, timeout: 15_000 },
  reporting: { format: 'table', verbose: false },
  tags: ['fast', 'smoke', 'critical'],
});

// =============================================================================
// BACKEND RECIPE
// =============================================================================

/** Backend recipe: architecture, resilience, and quality checks for server code */
const backendRecipe: FitnessRecipe = defineRecipe({
  name: 'backend',
  displayName: 'Backend',
  description: 'Backend-focused checks (architecture, resilience, quality)',
  checks: {
    type: 'pattern',
    include: [
      'architecture/*',
      'resilience/*',
      'quality/*-backend',
      'quality/fastify-*',
      'quality/database-*',
      'quality/pino-*',
      'quality/logging-*',
      'quality/correlation-*',
      'quality/no-console-log',
      'quality/result-pattern-*',
      'quality/api-*',
      'quality/null-safety',
      'quality/no-any-types',
      'quality/file-headers',
      'quality/error-swallowing-*',
      'security/*',
      'testing/*',
    ],
    exclude: ['quality/*-frontend', 'testing/*-frontend'],
  },
  execution: { mode: 'parallel', stopOnFirstFailure: false, timeout: 30_000 },
  reporting: { format: 'table', verbose: false },
  tags: ['backend', 'server', 'api'],
});

// =============================================================================
// FRONTEND RECIPE
// =============================================================================

/** Frontend recipe: React and accessibility checks for UI code */
const frontendRecipe: FitnessRecipe = defineRecipe({
  name: 'frontend',
  displayName: 'Frontend',
  description: 'Frontend-focused checks (React, accessibility)',
  checks: {
    type: 'pattern',
    include: [
      'quality/*-frontend',
      'quality/navigation-*',
      'quality/theme-*',
      'quality/image-*',
      'quality/async-state-*',
      'quality/no-any-types',
      'quality/null-safety',
      'architecture/heavy-import-detection',
      'testing/no-skipped-tests',
      'testing/*-frontend',
    ],
    exclude: ['quality/*-backend', 'testing/*-backend'],
  },
  execution: { mode: 'parallel', stopOnFirstFailure: false, timeout: 30_000 },
  reporting: { format: 'table', verbose: false },
  tags: ['frontend', 'react', 'ui'],
});

// =============================================================================
// SECURITY RECIPE
// =============================================================================

/** Security recipe: comprehensive security audit checks */
const securityRecipe: FitnessRecipe = defineRecipe({
  name: 'security',
  displayName: 'Security Audit',
  description: 'Comprehensive security analysis',
  checks: {
    type: 'pattern',
    include: [
      'security/*',
      'quality/pii-*',
      'quality/dependency-security-*',
      'quality/centralized-input-*',
      'quality/security-*',
      'quality/no-console-log',
      'resilience/no-custom-cache',
      'resilience/no-custom-rate-limiter',
      'resilience/context-leakage',
    ],
  },
  execution: { mode: 'sequential', stopOnFirstFailure: false, timeout: 60_000 },
  reporting: { format: 'table', verbose: true },
  tags: ['security', 'audit', 'comprehensive'],
});

// =============================================================================
// PRE-COMMIT RECIPE
// =============================================================================

/** Pre-commit recipe: fast checks suitable for git pre-commit hooks */
const preCommitRecipe: FitnessRecipe = defineRecipe({
  name: 'pre-commit',
  displayName: 'Pre-Commit',
  description: 'Fast checks for git pre-commit hooks',
  checks: {
    type: 'explicit',
    checkIds: [
      'no-console-log',
      'no-any-types',
      'no-hardcoded-secrets',
      'detached-promises',
      'no-skipped-tests',
    ],
  },
  execution: { mode: 'parallel', stopOnFirstFailure: true, timeout: 10_000 },
  reporting: { format: 'table', verbose: false },
  tags: ['fast', 'hook', 'pre-commit'],
});

// =============================================================================
// PRE-RELEASE RECIPE
// =============================================================================

/** Pre-release recipe: comprehensive checks run before a release */
const preReleaseRecipe: FitnessRecipe = defineRecipe({
  name: 'pre-release',
  displayName: 'Pre-Release',
  description: 'Comprehensive checks before release',
  checks: { type: 'all' },
  execution: { mode: 'sequential', stopOnFirstFailure: false, timeout: 120_000 },
  reporting: { format: 'unified', verbose: true },
  tags: ['comprehensive', 'release', 'thorough'],
});

// =============================================================================
// NIGHTLY FULL RECIPE
// =============================================================================

/** Nightly full recipe: complete check suite for scheduled nightly runs */
const nightlyFullRecipe: FitnessRecipe = defineRecipe({
  name: 'nightly-full',
  displayName: 'Nightly Full',
  description: 'Complete suite for nightly scheduled runs',
  checks: { type: 'all' },
  execution: {
    mode: 'parallel',
    stopOnFirstFailure: false,
    timeout: 300_000,
    maxParallel: DEFAULT_MAX_PARALLEL,
  },
  reporting: { format: 'unified', verbose: true, outputPath: 'fitness-nightly-report.json' },
  tags: ['nightly', 'comprehensive', 'scheduled'],
});

// =============================================================================
// CI RECIPE
// =============================================================================

/** CI recipe: optimized for CI pipelines with JSON output */
const ciRecipe: FitnessRecipe = defineRecipe({
  name: 'ci',
  displayName: 'CI',
  description: 'Optimized for CI pipelines with JSON output',
  checks: { type: 'all', exclude: ['testing/flaky-*', 'performance/*'] },
  execution: { mode: 'parallel', stopOnFirstFailure: false, timeout: 60_000 },
  reporting: { format: 'json', verbose: false },
  tags: ['ci', 'pipeline', 'automated'],
});

// =============================================================================
// ARCHITECTURE RECIPE
// =============================================================================

/** Architecture recipe: architecture validation and compliance checks */
const architectureRecipe: FitnessRecipe = defineRecipe({
  name: 'architecture',
  displayName: 'Architecture Review',
  description: 'Architecture validation and compliance',
  checks: { type: 'tags', include: ['architecture'] },
  execution: { mode: 'parallel', stopOnFirstFailure: false, timeout: 30_000 },
  reporting: { format: 'table', verbose: true },
  tags: ['architecture', 'structure'],
});

// =============================================================================
// EXPORTS
// =============================================================================

/** All built-in fitness recipes */
export const builtInRecipes: readonly FitnessRecipe[] = Object.freeze([
  defaultRecipe,
  quickSmokeRecipe,
  backendRecipe,
  frontendRecipe,
  securityRecipe,
  preCommitRecipe,
  preReleaseRecipe,
  nightlyFullRecipe,
  ciRecipe,
  architectureRecipe,
]);

/** Map of built-in recipe name to recipe definition */
export const builtInRecipesByName: ReadonlyMap<string, FitnessRecipe> = new Map(
  builtInRecipes.map((recipe) => [recipe.name, recipe]),
);

/** Check whether a recipe name corresponds to a built-in recipe */
export function isBuiltInRecipe(name: string): boolean {
  return builtInRecipesByName.has(name);
}
