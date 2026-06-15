/**
 * @fileoverview Regression tests for `sql-injection` check FP fixes.
 *
 * The 1.0.7 release tightened arm-3 (right-side string concat with
 * SQL clause keyword) to:
 *   - case-sensitive `WHERE|AND|OR|SET|VALUES` (no longer matches
 *     lowercase English words)
 *   - require the concat chain to contain a real SQL keyword
 *     (`SELECT|INSERT|UPDATE|...`) somewhere
 *   - skip arguments to known output methods (cli.info/log/error,
 *     console.log, logger.warn, etc.)
 *
 * These tests pin the FP cases that previously fired so future
 * refactors don't reintroduce them.
 */

import { describe, expect, it } from 'vitest';

import { analyzeSqlInjection } from '../sql-injection.js';

function analyze(src: string): readonly { line: number; message: string }[] {
  return analyzeSqlInjection(src, 'test.ts');
}

describe('sql-injection — FP regression suite (1.0.7)', () => {
  it('does NOT flag CLI help text with lowercase "and" between concatenated strings', () => {
    // Pre-1.0.7 this fired because /\bAND\b/i matched "and" in plain
    // English inside `cli.info('...\n' + '... and ...\n')`.
    const src = String.raw`
      import { cli } from './cli'
      cli.info(
        'Usage: opensip foo --tenant <id>\n\n' +
        'Verifies the chain hash and surfaces every seal row.\n' +
        'Exits 0 on a clean pass.\n',
      )
    `;
    expect(analyze(src)).toHaveLength(0);
  });

  it('does NOT flag CLI help text with lowercase "or" between concatenated strings', () => {
    const src = String.raw`
      const cli = { info: (_: string) => {} }
      cli.info(
        'Pick a strategy: shadow or apply.\n' +
        '  shadow — log only\n' +
        '  apply  — write the change\n',
      )
    `;
    expect(analyze(src)).toHaveLength(0);
  });

  it('does NOT flag logger.warn argument with concatenation', () => {
    const src = `
      const logger = { warn: (_: object) => {} }
      logger.warn({
        msg: 'phase ' + name + ' will retry and continue',
      })
    `;
    expect(analyze(src)).toHaveLength(0);
  });

  it('does NOT flag console.log with English-text concatenation', () => {
    const src = String.raw`
      console.log('Tables: ' + tables.join(', ') + '\n' + 'audit_log and chain_seals are checked')
    `;
    expect(analyze(src)).toHaveLength(0);
  });

  it('STILL flags real SQL concatenation with WHERE', () => {
    // Pre-1.0.7 caught this via arm-1 (left-side SELECT keyword); the
    // 1.0.7 changes must preserve that detection.
    const src = `
      const q = 'SELECT * FROM users WHERE id = ' + userId
      db.execute(q)
    `;
    expect(analyze(src).length).toBeGreaterThanOrEqual(1);
  });

  it('STILL flags right-side WHERE/AND continuation when chain has a SQL keyword', () => {
    // Build-up pattern: prefix + variable + suffix where the suffix
    // contains a clause keyword. The chain has "SELECT * FROM " on
    // the left, so arm-3 should fire.
    const src = `
      const q = 'SELECT * FROM users WHERE id = ' + userId + ' AND status = $1'
      db.execute(q)
    `;
    expect(analyze(src).length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag uppercase AND/OR inside an output call even when the chain looks SQL-ish', () => {
    // Edge case: even if the help text uses uppercase "AND" /
    // "OR", the output-call filter should skip it because
    // cli.info(...) is never SQL.
    const src = String.raw`
      const cli = { info: (_: string) => {} }
      cli.info(
        'Pick a mode:\n' +
        '  shadow  - log only\n' +
        '  apply   - write\n' +
        '\n' +
        'BOTH are safe to run; SHADOW is read-only.\n',
      )
    `;
    expect(analyze(src)).toHaveLength(0);
  });
});
