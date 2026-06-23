/**
 * Regression tests for throws-documentation analyze heuristics.
 */

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { analyzeFile } from '../throws-documentation-analyze.js';
import { buildEffectiveSuffixes } from '../throws-documentation-constants.js';

function analyze(src: string, path = 'src/svc/sample.ts'): ReturnType<typeof analyzeFile> {
  const sourceFile = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true);
  return analyzeFile({
    sourceFile,
    content: src,
    filePath: path,
    selfDocumentingSuffixes: buildEffectiveSuffixes(),
  });
}

describe('throws-documentation — enclosing-factory @throws', () => {
  it('skips a closure returned from a documented factory', () => {
    const src = `
      /** @throws {Error} always */
      function deniedSeam(seam: string): () => never {
        return () => {
          throw new Error('seam unavailable: ' + seam);
        };
      }
    `;
    expect(analyze(src)).toHaveLength(0);
  });
});

describe('throws-documentation — property-arrow JSDoc', () => {
  it('reads @throws on object-literal property arrows', () => {
    const src = `
      export function buildSeams() {
        return {
          /** @throws {ConfigurationError} when missing */
          exportBaseline: async (tool: string) => {
            if (!tool) throw new ConfigurationError('missing');
          },
        };
      }
    `;
    expect(analyze(src)).toHaveLength(0);
  });
});

describe('throws-documentation — never-propagates', () => {
  it('skips async functions that catch every throw and convert to exit code', () => {
    const src = `
      export async function executeCheck(cli: { setExitCode(n: number): void }): Promise<void> {
        try {
          if (process.argv.length === 0) {
            throw new Error('no argv');
          }
          cli.setExitCode(0);
        } catch (error) {
          cli.setExitCode(1);
        }
      }
    `;
    expect(analyze(src)).toHaveLength(0);
  });
});

describe('throws-documentation — instanceof-guarded rethrow', () => {
  it('skips rethrowing a cached error after instanceof narrowing', () => {
    const src = `
      class MemoryPressureError extends Error {}
      function createMonitor() {
        let lastError: MemoryPressureError | null = null;
        const check = (): void => {
          const tripped = lastError;
          if (tripped instanceof MemoryPressureError) throw tripped;
        };
        return { check };
      }
    `;
    expect(analyze(src)).toHaveLength(0);
  });
});