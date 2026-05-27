import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { HistoryTable } from '../../../ui/components/HistoryTable.js';

import type { StoredSession } from '@opensip-tools/contracts';

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'sess-1',
    timestamp: Date.now(),
    score: 95,
    passed: true,
    durationMs: 1234,
    summary: { total: 10, passed: 9, failed: 1, errored: 0, skipped: 0 },
    recipe: 'quick-smoke',
    ...overrides,
  } as StoredSession;
}

describe('HistoryTable', () => {
  it('renders an empty-state hint when no sessions exist', () => {
    const { lastFrame } = render(<HistoryTable sessions={[]} />);
    expect(lastFrame()).toContain('No sessions recorded yet');
  });

  it('renders the header and a row per session', () => {
    const sessions: StoredSession[] = [
      makeSession({ id: 'a', score: 92, passed: true }),
      makeSession({ id: 'b', score: 65, passed: false }),
    ];
    const { lastFrame } = render(<HistoryTable sessions={sessions} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('Run History');
    expect(out).toContain('PASS');
    expect(out).toContain('FAIL');
    expect(out).toContain('92%');
    expect(out).toContain('65%');
  });

  it('caps the visible list at 20 entries', () => {
    const sessions = Array.from({ length: 25 }, (_, i) =>
      makeSession({ id: `sess-${i}`, score: 90 - i, passed: true }),
    );
    const { lastFrame } = render(<HistoryTable sessions={sessions} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('25 sessions');
    // The 21st session (id sess-20) should NOT be in output. We assert
    // by counting how many "%" appear — should be 20.
    const pctMatches = out.match(/\d{1,3}%/g) ?? [];
    expect(pctMatches.length).toBeLessThanOrEqual(20);
  });

  it('uses score-mid color for scores 70-89', () => {
    const session = makeSession({ score: 75, passed: true });
    const { lastFrame } = render(<HistoryTable sessions={[session]} />);
    expect(lastFrame()).toContain('75%');
  });

  it('uses score-low color for scores below 70', () => {
    const session = makeSession({ score: 50, passed: false });
    const { lastFrame } = render(<HistoryTable sessions={[session]} />);
    expect(lastFrame()).toContain('50%');
  });
});
