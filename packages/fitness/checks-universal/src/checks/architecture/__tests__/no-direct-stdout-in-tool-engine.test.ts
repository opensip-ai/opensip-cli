/**
 * Unit tests for the pure `analyzeDirectStdout` detector behind the
 * `no-direct-stdout-in-tool-engine` check (ADR-0011, Phase 8). The detector
 * operates on `strip-strings`-filtered content (the framework applies the
 * `contentFilter` before calling `analyze`), so these tests feed it the
 * already-filtered shape: real call sites survive; string/comment text does
 * not (the filter blanks it before this function ever sees it).
 *
 * Modelled on `no-todo-comments.test.ts` — a pure `(content) => violations[]`
 * detector exercised with no framework, no IO, no mocks.
 */
import { describe, expect, it } from 'vitest';

import { analyzeDirectStdout } from '../no-direct-stdout-in-tool-engine.js';

describe('analyzeDirectStdout', () => {
  it('flags process.stdout.write', () => {
    const violations = analyzeDirectStdout('process.stdout.write(JSON.stringify(x))');
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(1);
    expect(violations[0]?.severity).toBe('error');
    expect(violations[0]?.message).toContain('SignalEnvelope');
  });

  it('flags console.log / console.info / console.debug (stdout rungs)', () => {
    for (const call of ['console.log("x")', 'console.info("x")', 'console.debug("x")']) {
      expect(analyzeDirectStdout(call)).toHaveLength(1);
    }
  });

  it('does NOT flag console.error / console.warn (stderr is the diagnostics channel)', () => {
    expect(analyzeDirectStdout('console.error("boom")')).toHaveLength(0);
    expect(analyzeDirectStdout('console.warn("careful")')).toHaveLength(0);
  });

  it('does NOT flag process.stderr.write (stderr channel)', () => {
    expect(analyzeDirectStdout('process.stderr.write("diag")')).toHaveLength(0);
  });

  it('does NOT flag string/comment text — strip-strings blanks it before analyze', () => {
    // The framework's `strip-strings` contentFilter blanks string + comment
    // bodies; what reaches `analyze` no longer contains the literal call text.
    // Simulate the filtered line: the offending text is gone.
    const filteredComment = '//'; // the stdout-write text is blanked by the filter
    const filteredString = 'const msg = ""'; // the console-call text is blanked by the filter
    expect(analyzeDirectStdout(filteredComment)).toHaveLength(0);
    expect(analyzeDirectStdout(filteredString)).toHaveLength(0);
  });

  it('flags one violation per offending line and reports correct line numbers', () => {
    const content = [
      'const a = 1;',
      'process.stdout.write(a);',
      'const b = 2;',
      'console.log(b);',
    ].join('\n');
    const violations = analyzeDirectStdout(content);
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.line)).toEqual([2, 4]);
  });

  it('flags at most one violation per line even when multiple patterns match', () => {
    const violations = analyzeDirectStdout('process.stdout.write(x); console.log(y);');
    expect(violations).toHaveLength(1);
  });

  it('returns no violations for clean content', () => {
    expect(analyzeDirectStdout('export function f() { return 1 }')).toEqual([]);
  });

  it('carries a remediation suggestion pointing at the ignore directive', () => {
    const violations = analyzeDirectStdout('process.stdout.write(x)');
    expect(violations[0]?.suggestion).toContain('no-direct-stdout-in-tool-engine');
  });
});
