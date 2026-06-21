import { describe, expect, it } from 'vitest';

import {
  checkCountLabel,
  progressTotal,
  withCheckCountFromProgress,
} from '../fit-runner-progress.js';

import type { ProgressCallback, ProgressEvent } from '@opensip-cli/cli-ui';

describe('fit live progress check count', () => {
  it('formats the default header as the running count', () => {
    expect(checkCountLabel({ running: 187, available: 190, verbose: false })).toBe('187 running');
  });

  it('formats the verbose header with available and filtered counts', () => {
    expect(checkCountLabel({ running: 187, available: 190, verbose: true })).toBe(
      '187 running, 190 available, 3 filtered',
    );
  });

  it('derives the header count from stage-progress totals', () => {
    expect(
      progressTotal({ type: 'stage-start', stage: 'checks', label: 'Running checks...' }),
    ).toBe(null);
    expect(
      progressTotal({ type: 'stage-progress', stage: 'checks', completed: 1, total: 187 }),
    ).toBe(187);
  });

  it('forwards progress events while reporting authoritative totals', () => {
    let listener: ProgressCallback | undefined;
    const subscribe = (cb: ProgressCallback): void => {
      listener = cb;
    };
    const counts: number[] = [];
    const events: ProgressEvent[] = [];

    withCheckCountFromProgress(subscribe, (count) => counts.push(count))((event) =>
      events.push(event),
    );

    const start = { type: 'stage-start', stage: 'checks', label: 'Running checks...' } as const;
    const progress = { type: 'stage-progress', stage: 'checks', completed: 4, total: 187 } as const;

    listener?.(start);
    listener?.(progress);

    expect(counts).toEqual([187]);
    expect(events).toEqual([start, progress]);
  });
});
