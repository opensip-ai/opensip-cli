import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LanguageRegistry, runWithScope } from '@opensip-cli/core';
import { makeFitnessTestScope } from '@opensip-cli/test-support';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { analyzeFunctionTooLong, pythonFunctionTooLong } from '../checks/function-too-long.js';

/** A `def` whose body is `bodyLines` assignment statements. */
function pyFunction(name: string, bodyLines: number): string {
  const body = Array.from({ length: bodyLines }, (_, i) => `    x${i} = ${i}`).join('\n');
  return `def ${name}():\n${body}\n`;
}

describe('python-function-too-long', () => {
  it('flags a function over the line budget', () => {
    const violations = analyzeFunctionTooLong(pyFunction('big', 60), 'big.py');
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(1);
    expect(violations[0].message).toContain('big');
    expect(violations[0].severity).toBe('warning');
  });

  it('does not flag a short function', () => {
    expect(analyzeFunctionTooLong('def small():\n    return 1\n', 'small.py')).toEqual([]);
  });

  it('counts nested functions independently (only the long one fires)', () => {
    const src = `${pyFunction('outer', 60).trimEnd()}\n    def inner():\n        return 1\n`;
    const violations = analyzeFunctionTooLong(src, 'nested.py');
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('outer');
  });

  it('returns [] on malformed input without throwing', () => {
    expect(() => analyzeFunctionTooLong('def (:\n', 'bad.py')).not.toThrow();
    expect(analyzeFunctionTooLong('def (:\n', 'bad.py')).toEqual([]);
  });
});

// Exercises the `analyze` closure declared inside `defineCheck({...})` end-to-end
// (the pure analyzer above is called directly and never goes through `.run()`).
// Mirrors run.test.ts: an empty scope drives applyContentFilter's no-adapter path.
describe('pythonFunctionTooLong.run() execution coverage', () => {
  const emptyScope = makeFitnessTestScope({
    languages: new LanguageRegistry(),
  });
  let cwd: string;
  let longTarget: string;
  let shortTarget: string;

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'opensip-checks-python-ftl-cov-'));
    const longBody = Array.from({ length: 60 }, (_, i) => `    y${i} = ${i}`).join('\n');
    longTarget = join(cwd, 'long.py');
    writeFileSync(longTarget, `def oversized():\n${longBody}\n`);
    shortTarget = join(cwd, 'short.py');
    writeFileSync(shortTarget, 'def tidy():\n    return 1\n');
  });

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('emits a signal for an over-budget function via .run()', async () => {
    const result = await runWithScope(emptyScope, () =>
      pythonFunctionTooLong.run(cwd, { targetFiles: [longTarget] }),
    );
    expect(Array.isArray(result.signals)).toBe(true);
    expect(result.signals.length).toBeGreaterThanOrEqual(1);
    expect(result.signals.some((s) => JSON.stringify(s).includes('oversized'))).toBe(true);
  });

  it('emits no signal for a function under the budget via .run()', async () => {
    const result = await runWithScope(emptyScope, () =>
      pythonFunctionTooLong.run(cwd, { targetFiles: [shortTarget] }),
    );
    expect(result.signals).toHaveLength(0);
  });

  it('exposes a stable check config (slug/analysisMode/tags)', () => {
    expect(pythonFunctionTooLong.config.slug).toBe('python-function-too-long');
    expect(pythonFunctionTooLong.config.analysisMode).toBe('analyze');
    expect(pythonFunctionTooLong.config.tags).toContain('python');
  });
});
