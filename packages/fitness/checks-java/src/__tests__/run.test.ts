/**
 * @fileoverview Execute the check end-to-end so the closures inside the
 * `defineCheck({...})` config (specifically `analyze`) are invoked.
 *
 * The pure analyzer is exercised by no-printstacktrace.test.ts. This
 * file's purpose is execution coverage for the un-called closures
 * declared inside the check definition.
 *
 * Note: the `strip-strings-and-comments` content-filter dispatch is a
 * framework concern — its contract (per-language adapter wiring,
 * fallback when no adapter is registered) is tested in
 * `@opensip-tools/core` and `@opensip-tools/fitness`. We do not
 * re-test it here because doing so would require the check pack to
 * pull the language adapter into its devDependency graph and wire it
 * into `defaultLanguageRegistry` — duplicating CLI boot logic for no
 * additional coverage.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { noPrintStackTrace } from '../checks/no-printstacktrace.js';

let cwd: string;
let target: string;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'opensip-checks-java-cov-'));
  target = join(cwd, 'Demo.java');
  writeFileSync(target, [
    'public class Demo {',
    '  public static void main(String[] args) {',
    '    try {',
    '      doWork();',
    '    } catch (Exception e) {',
    '      e.printStackTrace();',
    '    }',
    '  }',
    '  static void doWork() {}',
    '}',
    '',
  ].join('\n'));
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('noPrintStackTrace.run() execution coverage', () => {
  it('runs end-to-end against a Java fixture with a printStackTrace call', async () => {
    const result = await noPrintStackTrace.run(cwd, { targetFiles: [target] });

    expect(result).toBeDefined();
    expect(Array.isArray(result.signals)).toBe(true);
    expect(typeof result.errors).toBe('number');
    expect(typeof result.warnings).toBe('number');
    // The fixture contains exactly one printStackTrace — at minimum one signal.
    expect(result.signals.length).toBeGreaterThanOrEqual(1);
  });

  it('exposes a stable check config (slug/analysisMode/tags)', () => {
    expect(noPrintStackTrace.config.slug).toBe('java-no-print-stack-trace');
    expect(noPrintStackTrace.config.analysisMode).toBe('analyze');
    expect(noPrintStackTrace.config.tags).toContain('java');
  });
});
