/**
 * @fileoverview Branch coverage tests for parallel/sequential execution
 * engines and the check-result-processor.
 *
 * Targets the conditional branches that the headline integration tests
 * skip — fileFilter, memory warnings, includeViolations, retry exhaustion,
 * stopOnFirstFailure mid-run, target file overrides, and global excludes.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defineCheck } from '../../framework/define-check.js'
import { CheckRegistry } from '../../framework/registry.js'
import { FitnessRecipeRegistry } from '../registry.js'
import { FitnessRecipeService } from '../service.js'

import type { FitnessRecipeServiceCallbacks } from '../service-types.js'
import type { FitnessRecipe } from '../types.js'

let testDir: string
let nextId = 0

function uid(): string {
  nextId++
  return `00000000-0000-4000-8000-${nextId.toString(16).padStart(12, '0')}`
}

function writeFixture(rel: string, content: string): string {
  const abs = join(testDir, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

function makeRecipe(overrides: Partial<FitnessRecipe> = {}): FitnessRecipe {
  return {
    id: 'URCP_test',
    name: 'test',
    displayName: 'Test',
    description: 'integration test recipe',
    checks: { type: 'all', exclude: [] },
    execution: { mode: 'parallel', stopOnFirstFailure: false, timeout: 30_000, maxParallel: 4 },
    reporting: { format: 'table', verbose: false },
    ...overrides,
  }
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-exec-branches-'))
})

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

// =============================================================================
// PARALLEL EXECUTION BRANCHES
// =============================================================================

describe('parallel execution — stopOnFirstFailure', () => {
  it('halts the parallel run after a failing check and skips queued checks', async () => {
    const ranOrder: string[] = []
    const checkRegistry = new CheckRegistry()
    // Register many checks; the first one fails → execution should stop the queue.
    checkRegistry.register(defineCheck({
      id: uid(), slug: 'fails-first', description: 'fail', tags: ['quality'],
      analyze: (_, filePath) => {
        ranOrder.push('fails-first')
        return [{ line: 1, message: 'no', severity: 'error' as const, filePath }]
      },
    }))
    for (let i = 0; i < 5; i++) {
      const slug = `extra-${i}`
      checkRegistry.register(defineCheck({
        id: uid(), slug, description: 'd', tags: ['quality'],
        analyze: () => { ranOrder.push(slug); return [] },
      }))
    }
    writeFixture('a.ts', 'x')

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry({ loadUserRecipes: false, logWarnings: false }),
      prewarmCache: true,
    })

    const result = await svc.start(makeRecipe({
      // maxParallel=1 forces serialized completion so stopOnFirstFailure
      // reliably gates the remaining checks.
      execution: { mode: 'parallel', stopOnFirstFailure: true, timeout: 30_000, maxParallel: 1 },
    }))

    // First check failed — stop should have engaged.
    expect(result.summary.failedChecks).toBeGreaterThanOrEqual(1)
    // Stopped the run early (some extras did not run).
    expect(ranOrder.length).toBeLessThan(6)
  })
})

describe('parallel execution — retryOnFailure recipe option', () => {
  it('passes the retry option through to executeWithRetry without changing behavior on a happy run', async () => {
    const checkRegistry = new CheckRegistry()
    checkRegistry.register(defineCheck({
      id: uid(), slug: 'happy', description: 'always passes', tags: ['quality'],
      analyze: () => [],
    }))
    writeFixture('a.ts', 'x')

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry({ loadUserRecipes: false, logWarnings: false }),
      prewarmCache: true,
    })

    // Engages the retryOnFailure ?? false branch in parallel-execution.ts
    const result = await svc.start(makeRecipe({
      execution: {
        mode: 'parallel',
        stopOnFirstFailure: false,
        timeout: 60_000,
        maxParallel: 2,
        retryOnFailure: true,
        maxRetries: 3,
      },
    }))

    expect(result.checkResults[0]?.passed).toBe(true)
  })
})

describe('parallel execution — globalExcludes propagation', () => {
  it('passes globalExcludes through to checks when configured at the service level', async () => {
    let receivedPaths: readonly string[] | undefined
    const checkRegistry = new CheckRegistry()
    checkRegistry.register(defineCheck({
      id: uid(), slug: 'inspector', description: 'inspect run options', tags: ['quality'],
      // eslint-disable-next-line @typescript-eslint/require-await
      analyzeAll: async (accessor) => {
        receivedPaths = accessor.paths
        return []
      },
    }))
    writeFixture('src/a.ts', 'x')
    writeFixture('docs/b.md', 'y')

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry({ loadUserRecipes: false, logWarnings: false }),
      prewarmCache: true,
      prewarmPatterns: ['**/*.ts', '**/*.md'],
      globalExcludes: ['docs/**'],
    })

    await svc.start(makeRecipe())
    expect(receivedPaths).toBeDefined()
    // docs/b.md should be excluded by globalExcludes propagating through
    // matchFiles into the file accessor.
    expect(receivedPaths?.some((f) => f.includes('docs/b.md'))).toBe(false)
  })
})

describe('parallel execution — checkTargetFiles', () => {
  it('routes pre-resolved target files into the check context', async () => {
    let receivedPaths: readonly string[] | undefined
    const checkRegistry = new CheckRegistry()
    const slug = 'target-aware'
    checkRegistry.register(defineCheck({
      id: uid(), slug, description: 'd', tags: ['quality'],
      // eslint-disable-next-line @typescript-eslint/require-await
      analyzeAll: async (accessor) => {
        receivedPaths = accessor.paths
        return []
      },
    }))
    const a = writeFixture('src/a.ts', 'x')
    writeFixture('src/b.ts', 'y')

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry({ loadUserRecipes: false, logWarnings: false }),
      prewarmCache: false,
      checkTargetFiles: new Map([[slug, [a]]]),
    })

    await svc.start(makeRecipe())
    expect(receivedPaths).toEqual([a])
  })
})

// =============================================================================
// SEQUENTIAL EXECUTION BRANCHES
// =============================================================================

describe('sequential execution — analyzeAll throw is captured by framework', () => {
  it('reports a check as failed when analyzeAll throws', async () => {
    const checkRegistry = new CheckRegistry()
    checkRegistry.register(defineCheck({
      id: uid(), slug: 'always-throws', description: 't', tags: ['quality'],
      // eslint-disable-next-line @typescript-eslint/require-await
      analyzeAll: async () => { throw new Error('persistent') },
    }))
    writeFixture('a.ts', 'x')

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry({ loadUserRecipes: false, logWarnings: false }),
      prewarmCache: false,
    })

    const result = await svc.start(makeRecipe({
      execution: {
        mode: 'sequential',
        stopOnFirstFailure: false,
        timeout: 60_000,
        retryOnFailure: false,
        maxRetries: 0,
      },
    }))

    // The framework captures the throw in check.run() and turns it into
    // a non-passing CheckResult — the orchestrator does not treat it as
    // a thrown exception bubbling up.
    expect(result.checkResults[0]?.passed).toBe(false)
  }, 10_000)
})

describe('sequential execution — stopOnFirstFailure with non-passing result', () => {
  it('stops sequential run when a check fails with stopOnFirstFailure=true', async () => {
    let secondRan = false
    const checkRegistry = new CheckRegistry()
    checkRegistry.register(defineCheck({
      id: uid(), slug: 'errors-out', description: 'd', tags: ['quality'],
      // eslint-disable-next-line @typescript-eslint/require-await
      analyzeAll: async () => { throw new Error('boom') },
    }))
    checkRegistry.register(defineCheck({
      id: uid(), slug: 'never-runs', description: 'd', tags: ['quality'],
      analyze: () => { secondRan = true; return [] },
    }))
    writeFixture('a.ts', 'x')

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry({ loadUserRecipes: false, logWarnings: false }),
      prewarmCache: false,
    })

    await svc.start(makeRecipe({
      execution: { mode: 'sequential', stopOnFirstFailure: true, timeout: 30_000 },
    }))

    expect(secondRan).toBe(false)
  })
})

// =============================================================================
// CHECK RESULT PROCESSOR — FILE FILTER + INCLUDE VIOLATIONS
// =============================================================================

describe('check-result-processor — fileFilter', () => {
  it('limits violation counts and pass status to the matching file', async () => {
    const checkRegistry = new CheckRegistry()
    checkRegistry.register(defineCheck({
      id: uid(), slug: 'multi-file', description: 'd', tags: ['quality'],
      analyze: (content, filePath) => {
        if (content.includes('FAIL')) {
          return [{ line: 1, message: 'fail', severity: 'error' as const, filePath }]
        }
        return []
      },
    }))
    const a = writeFixture('src/a.ts', 'const x = "FAIL";')
    writeFixture('src/b.ts', 'const y = "OK";')

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry({ loadUserRecipes: false, logWarnings: false }),
      prewarmCache: true,
      includeViolations: true,
    })

    // First: without fileFilter — should fail because a.ts fails.
    const noFilter = await svc.start(makeRecipe())
    expect(noFilter.checkResults[0]?.passed).toBe(false)
    expect(noFilter.checkResults[0]?.errorCount).toBeGreaterThan(0)

    // Second: with fileFilter pointing to b.ts — should pass since
    // the matching file has no violations.
    const filtered = await svc.start(makeRecipe({ fileFilter: a.replace('a.ts', 'b.ts') }))
    expect(filtered.checkResults[0]?.passed).toBe(true)
    expect(filtered.checkResults[0]?.errorCount).toBe(0)
  })
})

describe('check-result-processor — includeViolations carries detail', () => {
  it('exposes violations with file/line/severity when enabled', async () => {
    const checkRegistry = new CheckRegistry()
    checkRegistry.register(defineCheck({
      id: uid(), slug: 'detail', description: 'd', tags: ['quality'],
      analyze: (content, filePath) => {
        const lines: { line: number; message: string; severity: 'error' | 'warning'; filePath: string; column?: number; suggestion?: string }[] = []
        for (const [i, line] of content.split('\n').entries()) {
          if (line.includes('X')) {
            lines.push({
              line: i + 1, message: 'has X', severity: 'warning' as const,
              filePath, column: 5, suggestion: 'remove X',
            })
          }
        }
        return lines
      },
    }))
    writeFixture('a.ts', 'const X = 1\nconst Y = 2')

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry({ loadUserRecipes: false, logWarnings: false }),
      prewarmCache: true,
      includeViolations: true,
    })

    const result = await svc.start(makeRecipe())
    const v = result.checkResults[0]?.violations?.[0]
    expect(v?.file).toBeDefined()
    expect(v?.line).toBe(1)
    expect(v?.severity).toBe('warning')
    expect(v?.suggestion).toBe('remove X')
  })
})

// =============================================================================
// onMemoryWarning callback path
// =============================================================================

describe('check-result-processor — memory warning callback', () => {
  it('does not invoke onMemoryWarning when memory usage is normal', async () => {
    let warnings = 0
    const callbacks: FitnessRecipeServiceCallbacks = {
      onMemoryWarning: () => { warnings++ },
    }
    const checkRegistry = new CheckRegistry()
    checkRegistry.register(defineCheck({
      id: uid(), slug: 'noop', description: 'd', tags: ['quality'],
      analyze: () => [],
    }))
    writeFixture('a.ts', 'x')

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry({ loadUserRecipes: false, logWarnings: false }),
      prewarmCache: false,
      callbacks,
    })

    await svc.start(makeRecipe())
    // Memory threshold is high — a no-op check should not exceed it.
    expect(warnings).toBe(0)
  })
})

// =============================================================================
// onError callback path
// =============================================================================

describe('check-result-processor — onError callback', () => {
  it('invokes onError when a check times out (CheckAbortedError surfaces)', async () => {
    const errors: { slug: string; err: Error }[] = []
    const callbacks: FitnessRecipeServiceCallbacks = {
      onError: (slug, err) => { errors.push({ slug, err }) },
    }
    const checkRegistry = new CheckRegistry()
    checkRegistry.register(defineCheck({
      id: uid(), slug: 'will-timeout', description: 'd', tags: ['quality'],
      // eslint-disable-next-line @typescript-eslint/require-await
      analyzeAll: async () => {
        await new Promise((r) => setTimeout(r, 500))
        return []
      },
    }))
    writeFixture('a.ts', 'x')

    const svc = new FitnessRecipeService({
      cwd: testDir,
      checkRegistry,
      recipeRegistry: new FitnessRecipeRegistry({ loadUserRecipes: false, logWarnings: false }),
      prewarmCache: false,
      callbacks,
    })

    await svc.start(makeRecipe({
      execution: { mode: 'sequential', stopOnFirstFailure: false, timeout: 50 },
    }))

    expect(errors.length).toBeGreaterThan(0)
  }, 10_000)
})
