/**
 * @fileoverview Execute the check end-to-end so the closures inside the
 * `defineCheck({...})` config (specifically `analyze`) are invoked.
 *
 * The pure analyzer is exercised by `no-bare-except.test.ts`. This
 * file's purpose is execution coverage for the un-called closures
 * declared inside the check definition.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LanguageRegistry, RunScope, runWithScope } from '@opensip-tools/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { noBareExcept } from '../checks/no-bare-except.js';

// applyContentFilter resolves the file's adapter via `currentScope()?.languages`
// (default registry global was removed in T1 cleanup). With no adapter
// registered for `.py`, applyContentFilter falls through to raw content.
// Wrap the call in an empty scope so dispatch reaches that no-adapter branch.
const emptyScope = new RunScope({ languages: new LanguageRegistry() });

let cwd: string;
let target: string;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'opensip-checks-python-cov-'));
  target = join(cwd, 'demo.py');
  writeFileSync(target, [
    'def main():',
    '    try:',
    '        do_work()',
    '    except:',
    '        pass',
    '',
    'def do_work():',
    '    return 1',
    '',
  ].join('\n'));
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('noBareExcept.run() execution coverage', () => {
  it('runs end-to-end against a Python fixture with a bare except', async () => {
    const result = await runWithScope(emptyScope, () =>
      noBareExcept.run(cwd, { targetFiles: [target] }),
    );

    expect(result).toBeDefined();
    expect(Array.isArray(result.signals)).toBe(true);
    expect(typeof result.errors).toBe('number');
    expect(typeof result.warnings).toBe('number');
    // The fixture contains exactly one bare `except:` — at minimum one signal.
    expect(result.signals.length).toBeGreaterThanOrEqual(1);
  });

  it('exposes a stable check config (slug/analysisMode/tags)', () => {
    expect(noBareExcept.config.slug).toBe('python-no-bare-except');
    expect(noBareExcept.config.analysisMode).toBe('analyze');
    expect(noBareExcept.config.tags).toContain('python');
  });
});
