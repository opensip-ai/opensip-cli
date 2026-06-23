import { describe, expect, it } from 'vitest';

import { analyzeFileForErrorHandlingQuality } from '../error-handling-quality.js';

const analyze = analyzeFileForErrorHandlingQuality;

describe('error-handling-quality — probe and Result.match heuristics', () => {
  it('does not flag safeIsDirectory filesystem probes', () => {
    const content = [
      'function safeIsDirectory(path: string): boolean {',
      '  try { return statSync(path).isDirectory() } catch { return false }',
      '}',
    ].join('\n');
    expect(analyze(content, 'packages/core/src/plugins/discover.ts')).toHaveLength(0);
  });

  it('does not flag module-init createRequire resolution probes', () => {
    const content = [
      'const selfCorePath = (() => {',
      '  try {',
      '    return createRequire(import.meta.url).resolve("@opensip-cli/core")',
      '  } catch {',
      '    return',
      '  }',
      '})()',
    ].join('\n');
    expect(analyze(content, 'packages/core/src/plugins/single-core-guard.ts')).toHaveLength(0);
  });

  it('does not flag String.match regex usage (single-arg, non-callback)', () => {
    const content = [
      'export function check(line: string, pattern: RegExp) {',
      '  return pattern.match(line)',
      '}',
    ].join('\n');
    expect(
      analyze(content, 'packages/fitness/checks-universal/src/checks/security/jwt-validation.ts'),
    ).toHaveLength(0);
  });

  it('still flags Result.match error handlers without logging', () => {
    const content = [
      'declare const result: {',
      '  match(ok: (v: unknown) => unknown, err: (e: unknown) => unknown): unknown',
      '}',
      'export const out = result.match((v) => v, (e) => null)',
    ].join('\n');
    expect(analyze(content, 'src/svc/result.ts').length).toBeGreaterThanOrEqual(1);
  });

  it('skips composition-root bootstrap paths', () => {
    const content = 'export function f() { try { work() } catch {} }';
    expect(analyze(content, 'packages/cli/src/bootstrap/deliver-envelope.ts')).toHaveLength(0);
  });

  it('still flags empty catch in ordinary service code', () => {
    const content = 'export function f() { try { work() } catch {} }';
    expect(analyze(content, 'src/svc/user.ts').length).toBeGreaterThanOrEqual(1);
  });
});
