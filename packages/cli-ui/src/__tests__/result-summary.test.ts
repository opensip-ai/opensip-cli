import { describe, expect, it } from 'vitest';

import { renderToText } from '../render-to-text.js';
import { viewResultSummary } from '../result-summary.js';

describe('viewResultSummary', () => {
  it('renders the N/M fraction count line with a runtime-error note when faulted > 0', () => {
    const out = renderToText(
      viewResultSummary({
        counts: { passed: 3, failed: 1, faulted: 1 },
        items: [
          { label: 'fit run', outcome: 'passed' },
          { label: 'graph', outcome: 'failed', detail: 'src/a.ts:12' },
          { label: 'sim x', outcome: 'faulted', detail: 'threw TypeError' },
          { label: 'fit b', outcome: 'passed' },
          { label: 'fit c', outcome: 'passed' },
        ],
      }),
    );
    const [countLine] = out.split('\n');
    expect(countLine).toBe('3/5 passed · 1/5 failed · 1/5 faulted (runtime error)');
  });

  it('omits the runtime-error note when nothing faulted', () => {
    const out = renderToText(
      viewResultSummary({
        counts: { passed: 1, failed: 1, faulted: 0 },
        items: [
          { label: 'a', outcome: 'passed' },
          { label: 'b', outcome: 'failed' },
        ],
      }),
    );
    expect(out.split('\n')[0]).toBe('1/2 passed · 1/2 failed · 0/2 faulted');
  });

  it('by default lists only failed + faulted items (attention-only, Option C)', () => {
    const out = renderToText(
      viewResultSummary({
        counts: { passed: 3, failed: 1, faulted: 1 },
        items: [
          { label: 'ok-1', outcome: 'passed' },
          { label: 'bad', outcome: 'failed', detail: 'src/a.ts:12' },
          { label: 'ok-2', outcome: 'passed' },
          { label: 'crash', outcome: 'faulted', detail: 'threw TypeError' },
          { label: 'ok-3', outcome: 'passed' },
        ],
      }),
    );
    expect(out).toContain('✗ bad  fail  src/a.ts:12');
    expect(out).toContain('⚠ crash  fault  threw TypeError');
    // Passing items are not listed in the default (attention-only) view.
    expect(out).not.toContain('ok-1');
    expect(out).not.toContain('ok-2');
  });

  it('lists every item (including passes) when showAll is set — the suite all-steps view', () => {
    const out = renderToText(
      viewResultSummary({
        counts: { passed: 2, failed: 1, faulted: 0 },
        items: [
          { label: 'fit pass', outcome: 'passed' },
          { label: 'graph fail', outcome: 'failed' },
          { label: 'sim pass', outcome: 'passed' },
        ],
        showAll: true,
      }),
    );
    expect(out).toContain('✓ fit pass  pass');
    expect(out).toContain('✗ graph fail  fail');
    expect(out).toContain('✓ sim pass  pass');
  });

  it('says nothing needs attention when the attention-only view is empty', () => {
    const out = renderToText(
      viewResultSummary({
        counts: { passed: 2, failed: 0, faulted: 0 },
        items: [
          { label: 'a', outcome: 'passed' },
          { label: 'b', outcome: 'passed' },
        ],
      }),
    );
    expect(out).toContain('2/2 passed');
    expect(out).toContain('All passed — nothing to flag.');
    expect(out).not.toContain('✓ a');
  });
});
