import { describe, expect, it } from 'vitest';

import { renderToText } from '../render-to-text.js';
import {
  VERBOSE_DETAIL_HINT,
  viewFindingsGroups,
  viewVerboseHint,
  viewVerboseLines,
  type FindingGroupView,
} from '../verbose-detail.js';

describe('viewVerboseLines', () => {
  it('renders each line verbatim through the text interpreter', () => {
    const out = renderToText(viewVerboseLines(['== Catalog ==', '5 functions across 2 files']));
    expect(out).toContain('== Catalog ==');
    expect(out).toContain('5 functions across 2 files');
  });
});

describe('viewVerboseHint', () => {
  it('renders the single canonical hint', () => {
    expect(VERBOSE_DETAIL_HINT.text).toBe('Use --verbose for detailed results');
    expect(renderToText(viewVerboseHint())).toContain('Use --verbose for detailed results');
  });
});

describe('viewFindingsGroups', () => {
  const groups: readonly FindingGroupView[] = [
    {
      title: 'no-todos',
      errorCount: 1,
      warningCount: 1,
      findings: [
        { severity: 'error', message: 'left a TODO', location: 'a.ts:3', suggestion: 'remove it' },
        { severity: 'warning', message: 'minor nit', location: 'b.ts:9' },
      ],
    },
  ];

  it('renders a header, the group title, severities, messages, and locations', () => {
    const out = renderToText(viewFindingsGroups(groups));
    expect(out).toContain('Findings');
    expect(out).toContain('no-todos');
    expect(out).toContain('error');
    expect(out).toContain('warn');
    expect(out).toContain('left a TODO');
    expect(out).toContain('a.ts:3');
    expect(out).toContain('remove it');
  });

  it('caps at 25 findings per group with a "+N more hidden" line', () => {
    const many: FindingGroupView = {
      title: 'big',
      errorCount: 30,
      warningCount: 0,
      findings: Array.from({ length: 30 }, (_v, i) => ({
        severity: 'error' as const,
        message: `m${String(i)}`,
      })),
    };
    const out = renderToText(viewFindingsGroups([many]));
    expect(out).toContain('m0');
    expect(out).toContain('m24');
    expect(out).not.toContain('m25');
    expect(out).toContain('5 more hidden');
  });

  it('renders a unit error line when the group itself errored', () => {
    const out = renderToText(
      viewFindingsGroups([
        { title: 'broken', error: 'timed out', errorCount: 0, warningCount: 0, findings: [] },
      ]),
    );
    expect(out).toContain('broken');
    expect(out).toContain('timed out');
  });
});
