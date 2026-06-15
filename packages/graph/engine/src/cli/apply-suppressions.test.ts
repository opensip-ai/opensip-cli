/**
 * Coverage for `applyGraphSuppressions` (ADR-0014) — graph's binding of the
 * shared core suppression primitive to `@graph-ignore` directives.
 *
 * Unlike the core primitive's test (which uses an in-memory readFile),
 * `applyGraphSuppressions` reads files from disk via
 * `fs.readFile(resolve(projectRoot, file))`. So these tests write real source
 * fixtures into an `os.tmpdir()`-based directory and point `projectRoot` at it.
 * Signals are built with the same `createSignal` the production rules use.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSignal } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyGraphSuppressions } from './apply-suppressions.js';

import type { Signal } from '@opensip-cli/core';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'graph-suppress-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write `content` to `file` (project-relative) under the temp root. */
async function fixture(file: string, content: string): Promise<void> {
  await writeFile(join(root, file), content, 'utf8');
}

/** Build a graph Signal anchored at `file:line`, optionally with metadata. */
function sig(
  ruleId: string,
  file: string,
  line: number,
  metadata?: Record<string, unknown>,
): Signal {
  return createSignal({
    source: 'graph',
    severity: 'medium',
    category: 'architecture',
    ruleId,
    message: `${ruleId} at ${file}:${String(line)}`,
    code: { file, line },
    metadata,
  });
}

describe('applyGraphSuppressions', () => {
  it('removes a signal waived by a matching next-line directive', async () => {
    await fixture(
      'a.ts',
      [
        '// @graph-ignore-next-line graph:large-function -- intentionally long',
        'function big() {}',
      ].join('\n'),
    );
    const res = await applyGraphSuppressions([sig('graph:large-function', 'a.ts', 2)], root);
    expect(res.kept).toHaveLength(0);
    expect(res.suppressedCount).toBe(1);
  });

  it('does not suppress when the directive names a different rule id', async () => {
    await fixture(
      'a.ts',
      ['// @graph-ignore-next-line graph:cycle -- not this rule', 'function big() {}'].join('\n'),
    );
    const res = await applyGraphSuppressions([sig('graph:large-function', 'a.ts', 2)], root);
    expect(res.kept).toHaveLength(1);
    expect(res.suppressedCount).toBe(0);
  });

  it('waives a graph:cycle signal via a directive above ANY member location', async () => {
    // The signal anchors at anchor.ts but the directive sits above a DIFFERENT
    // member (member.ts) — the any-member semantics graphLocate() implements
    // from metadata.memberLocations.
    await fixture('anchor.ts', 'function a() {}');
    await fixture(
      'member.ts',
      ['// @graph-ignore-next-line graph:cycle -- intentional recursion', 'function b() {}'].join(
        '\n',
      ),
    );
    const signal = sig('graph:cycle', 'anchor.ts', 1, {
      memberLocations: [
        { file: 'anchor.ts', line: 1 },
        { file: 'member.ts', line: 2 },
      ],
    });
    const res = await applyGraphSuppressions([signal], root);
    expect(res.kept).toHaveLength(0);
    expect(res.suppressedCount).toBe(1);
  });

  it('suppresses unconditionally — a directive with no -- reason still waives', async () => {
    await fixture(
      'a.ts',
      ['// @graph-ignore-next-line graph:cycle', 'function visit() {}'].join('\n'),
    );
    const res = await applyGraphSuppressions([sig('graph:cycle', 'a.ts', 2)], root);
    expect(res.kept).toHaveLength(0);
    expect(res.suppressedCount).toBe(1);
  });

  it('keeps a signal with no matching directive', async () => {
    await fixture('a.ts', ['function visit() {}', 'function other() {}'].join('\n'));
    const res = await applyGraphSuppressions([sig('graph:cycle', 'a.ts', 1)], root);
    expect(res.kept).toHaveLength(1);
    expect(res.suppressedCount).toBe(0);
  });
});
