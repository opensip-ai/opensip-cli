import { describe, it, expect } from 'vitest';

import { createSignal } from '../types/signal.js';

import { filterSignalsBySuppressions, type SuppressionKeywords } from './suppress.js';

import type { Signal } from '../types/signal.js';

const GRAPH_KEYWORDS: SuppressionKeywords = {
  file: '@graph-ignore-file',
  nextLine: '@graph-ignore-next-line',
};
const FITNESS_KEYWORDS: SuppressionKeywords = {
  file: '@fitness-ignore-file',
  nextLine: '@fitness-ignore-next-line',
};

function sig(ruleId: string, file: string, line: number): Signal {
  return createSignal({
    source: 'test',
    severity: 'medium',
    category: 'quality',
    ruleId,
    message: `${ruleId} at ${file}:${String(line)}`,
    code: { file, line },
  });
}

/** An `ENOENT` rejection shaped like Node's `fs` errors. */
function enoent(p: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, open '${p}'`);
  error.code = 'ENOENT';
  return error;
}

/**
 * A reader backed by an in-memory file map. Unknown files reject with an
 * `ENOENT` (the genuinely-removed-file case) so the happy-path tests exercise
 * the conservative degrade path rather than the fail-loud one.
 */
function readerFor(files: Record<string, string>): (p: string) => Promise<string> {
  return (p) => (p in files ? Promise.resolve(files[p]) : Promise.reject(enoent(p)));
}

describe('filterSignalsBySuppressions', () => {
  it('suppresses via a next-line directive on the preceding line', async () => {
    const content = ['// @graph-ignore-next-line graph:cycle -- intentional recursion', 'function visit() {}'].join('\n');
    const res = await filterSignalsBySuppressions({
      signals: [sig('graph:cycle', 'a.ts', 2)],
      keywords: GRAPH_KEYWORDS,
      readFile: readerFor({ 'a.ts': content }),
    });
    expect(res.kept).toHaveLength(0);
    expect(res.suppressed).toHaveLength(1);
    expect(res.suppressed[0].line).toBe(2);
  });

  it('suppresses every matching signal via a file-level directive', async () => {
    const content = ['// @graph-ignore-file graph:wide-function -- generated', 'code', 'more'].join('\n');
    const res = await filterSignalsBySuppressions({
      signals: [sig('graph:wide-function', 'a.ts', 2), sig('graph:wide-function', 'a.ts', 3)],
      keywords: GRAPH_KEYWORDS,
      readFile: readerFor({ 'a.ts': content }),
    });
    expect(res.kept).toHaveLength(0);
    expect(res.suppressed.every((s) => s.line === 'file')).toBe(true);
  });

  it('matches per ruleId — a directive for one rule does not suppress another', async () => {
    const content = ['// @graph-ignore-next-line graph:cycle -- ok', 'function visit() {}'].join('\n');
    const res = await filterSignalsBySuppressions({
      signals: [sig('graph:large-function', 'a.ts', 2)],
      keywords: GRAPH_KEYWORDS,
      readFile: readerFor({ 'a.ts': content }),
    });
    expect(res.kept).toHaveLength(1);
    expect(res.suppressed).toHaveLength(0);
  });

  it('suppresses unconditionally — a directive with no reason still suppresses', async () => {
    const content = ['// @graph-ignore-next-line graph:cycle', 'function visit() {}'].join('\n');
    const res = await filterSignalsBySuppressions({
      signals: [sig('graph:cycle', 'a.ts', 2)],
      keywords: GRAPH_KEYWORDS,
      readFile: readerFor({ 'a.ts': content }),
    });
    expect(res.suppressed).toHaveLength(1);
  });

  it('skips stacked directive lines to find the real target', async () => {
    const content = [
      '// @graph-ignore-next-line graph:cycle -- ok',
      '// eslint-disable-next-line no-shadow',
      'function visit() {}',
    ].join('\n');
    const res = await filterSignalsBySuppressions({
      signals: [sig('graph:cycle', 'a.ts', 3)],
      keywords: GRAPH_KEYWORDS,
      readFile: readerFor({ 'a.ts': content }),
    });
    expect(res.suppressed).toHaveLength(1);
  });

  it('honors a directive above ANY candidate location (cycle any-member)', async () => {
    // The signal anchors at member.ts:9 but a directive sits above a DIFFERENT member.
    const anchor = sig('graph:cycle', 'anchor.ts', 9);
    const res = await filterSignalsBySuppressions({
      signals: [anchor],
      keywords: GRAPH_KEYWORDS,
      readFile: readerFor({
        'anchor.ts': 'function a() {}',
        'member.ts': ['// @graph-ignore-next-line graph:cycle -- intentional', 'function b() {}'].join('\n'),
      }),
      locate: () => [
        { file: 'anchor.ts', line: 9 },
        { file: 'member.ts', line: 2 },
      ],
    });
    expect(res.suppressed).toHaveLength(1);
  });

  it('never suppresses a signal pointing AT a directive line (anti-recursion)', async () => {
    // A directive-audit-style finding lands on the directive comment itself.
    const content = ['// @graph-ignore-next-line graph:cycle -- ok', 'function visit() {}'].join('\n');
    const res = await filterSignalsBySuppressions({
      signals: [sig('graph:cycle', 'a.ts', 1)],
      keywords: GRAPH_KEYWORDS,
      readFile: readerFor({ 'a.ts': content }),
    });
    expect(res.kept).toHaveLength(1);
  });

  it('throws (fails loud) when readFile rejects with a non-ENOENT error', async () => {
    // An unexpected read failure (EACCES, EMFILE, decode, …) must abort the run
    // rather than silently drop the file's waivers and leak the signal.
    const eacces: NodeJS.ErrnoException = new Error('EACCES: permission denied');
    eacces.code = 'EACCES';
    await expect(
      filterSignalsBySuppressions({
        signals: [sig('graph:cycle', 'locked.ts', 2)],
        keywords: GRAPH_KEYWORDS,
        readFile: () => Promise.reject(eacces),
      }),
    ).rejects.toThrow(/EACCES/);
  });

  it('also throws on a generic (non-ErrnoException) read rejection', async () => {
    await expect(
      filterSignalsBySuppressions({
        signals: [sig('graph:cycle', 'weird.ts', 2)],
        keywords: GRAPH_KEYWORDS,
        readFile: () => Promise.reject(new Error('decode boom')),
      }),
    ).rejects.toThrow(/decode boom/);
  });

  it('on ENOENT: conservatively keeps the signal (non-fatal, not suppressed)', async () => {
    // A genuinely-removed file is non-fatal — but the waiver cannot be
    // evaluated, so the signal is kept (never silently treated as suppressed).
    const res = await filterSignalsBySuppressions({
      signals: [sig('graph:cycle', 'missing.ts', 2)],
      keywords: GRAPH_KEYWORDS,
      readFile: readerFor({}), // unknown file → ENOENT
    });
    expect(res.kept).toHaveLength(1);
    expect(res.suppressed).toHaveLength(0);
  });

  it('is keyword-agnostic — same logic under fitness keywords', async () => {
    const content = ['// @fitness-ignore-next-line no-generic-error -- boundary', 'throw new Error()'].join('\n');
    const res = await filterSignalsBySuppressions({
      signals: [sig('no-generic-error', 'a.ts', 2)],
      keywords: FITNESS_KEYWORDS,
      readFile: readerFor({ 'a.ts': content }),
    });
    expect(res.suppressed).toHaveLength(1);
  });

  it('respects ruleIdOf override (fitness per-check slug semantics)', async () => {
    // Signal carries a different ruleId, but fitness matches by the check slug.
    const content = ['// @fitness-ignore-next-line my-check -- ok', 'code'].join('\n');
    const res = await filterSignalsBySuppressions({
      signals: [sig('some-other-rule-id', 'a.ts', 2)],
      keywords: FITNESS_KEYWORDS,
      readFile: readerFor({ 'a.ts': content }),
      ruleIdOf: () => 'my-check',
    });
    expect(res.suppressed).toHaveLength(1);
  });
});
