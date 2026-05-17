/**
 * @fileoverview Execute the check end-to-end so the closures inside the
 * `defineCheck({...})` config (specifically `analyze`) are invoked.
 *
 * The pure analyzer is exercised by analyze.test.ts and
 * no-printstacktrace.test.ts. This file's purpose is execution coverage
 * for the un-called closures declared inside the check definition.
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
