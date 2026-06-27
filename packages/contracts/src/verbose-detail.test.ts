import { createSignal, type Signal } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { buildFindingGroups, type FindingGroupUnit } from './verbose-detail.js';

function sig(
  source: string,
  severity: Signal['severity'],
  message: string,
  file = 'a.ts',
  line?: number,
): Signal {
  return createSignal({
    source,
    severity,
    ruleId: `${source}-rule`,
    message,
    code: { file, line },
  });
}

describe('buildFindingGroups', () => {
  it('groups signals by source, collapses 4→2 severity, and counts each rung', () => {
    const units: FindingGroupUnit[] = [{ slug: 'check-a' }, { slug: 'check-b' }];
    const signals = [
      sig('check-a', 'critical', 'boom', 'x.ts', 10),
      sig('check-a', 'low', 'meh', 'y.ts'),
      sig('check-b', 'high', 'bad', 'z.ts', 3),
    ];
    const groups = buildFindingGroups(units, signals);
    expect(groups).toHaveLength(2);

    const a = groups[0];
    expect(a.title).toBe('check-a'); // identity display name
    expect(a.errorCount).toBe(1); // critical → error rung
    expect(a.warningCount).toBe(1); // low → warning rung
    expect(a.findings[0]).toEqual({
      severity: 'error',
      message: 'boom',
      location: 'x.ts:10',
    });
    expect(a.findings[1]).toEqual({
      severity: 'warning',
      message: 'meh',
      location: 'y.ts',
    });

    const b = groups[1];
    expect(b.findings[0]).toEqual({
      severity: 'error',
      message: 'bad',
      location: 'z.ts:3',
    });
  });

  it('applies the displayName resolver to the group title', () => {
    const groups = buildFindingGroups(
      [{ slug: 'no-todos' }],
      [sig('no-todos', 'high', 'x')],
      (s) => `Pretty ${s}`,
    );
    expect(groups[0].title).toBe('Pretty no-todos');
  });

  it('includes a unit that errored even with no signals; skips clean units', () => {
    const units: FindingGroupUnit[] = [{ slug: 'errored', error: 'timed out' }, { slug: 'clean' }];
    const groups = buildFindingGroups(units, []);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      title: 'errored',
      error: 'timed out',
      errorCount: 0,
      warningCount: 0,
    });
  });

  it('omits location when the signal has no file path', () => {
    const s = createSignal({
      source: 'u',
      severity: 'high',
      ruleId: 'r',
      message: 'no loc',
    });
    const groups = buildFindingGroups([{ slug: 'u' }], [s]);
    expect(groups[0].findings[0].location).toBeUndefined();
  });
});
