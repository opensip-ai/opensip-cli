/**
 * Regression tests for performance-anti-patterns FP fixes.
 */

import { describe, expect, it } from 'vitest';

import { analyzeFileForPerformancePatterns } from '../performance-anti-patterns.js';

function analyze(
  src: string,
  path = 'src/svc/sample.ts',
): ReturnType<typeof analyzeFileForPerformancePatterns> {
  return analyzeFileForPerformancePatterns(src, path);
}

describe('performance-anti-patterns — intentional sequential await', () => {
  it('does not flag retry backoff with await new Promise(setTimeout)', () => {
    const src = `
      export async function withRetry(fn: () => Promise<void>) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            return await fn();
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      }
    `;
    expect(analyze(src, 'packages/core/src/lib/retry.ts')).toHaveLength(0);
  });

  it('does not flag Promise.race back-pressure in a while loop', () => {
    const src = `
      async function gate(inFlight: Set<Promise<void>>) {
        while (inFlight.size >= 2) {
          await Promise.race(inFlight);
        }
      }
    `;
    expect(analyze(src)).toHaveLength(0);
  });

  it('does not flag Promise.all batching inside a for loop', () => {
    const src = `
      export async function load(packages: string[]) {
        for (let i = 0; i < packages.length; i += 2) {
          const batch = packages.slice(i, i + 2);
          await Promise.all(batch.map((p) => import(p)));
        }
      }
    `;
    expect(analyze(src, 'packages/core/src/plugins/capability-discovery.ts')).toHaveLength(0);
  });

  it('does not flag sequential plugin admission over packages', () => {
    const src = `
      export async function register(packages: string[]) {
        for (const packageName of packages) {
          await admit(packageName);
        }
      }
    `;
    expect(analyze(src, 'packages/cli/src/bootstrap/register-tools.ts')).toHaveLength(0);
  });

  it('STILL flags unbounded sequential await in a data loop', () => {
    const src = `
      export async function load(ids: string[]) {
        for (const id of ids) {
          await fetchRow(id);
        }
      }
    `;
    expect(analyze(src).length).toBeGreaterThan(0);
  });
});
