import { describe, expect, it } from 'vitest';

import { analyzeFileForDetachedPromises } from '../detached-promises-detection.js';

describe('analyzeFileForDetachedPromises', () => {
  it('flags a missing await on an async release() call on an arbitrary receiver (regression)', () => {
    // `release` is a common name for an ASYNC teardown method (distributed
    // locks, DB advisory locks, connection-pool clients, etc.) — it must not
    // be treated as sync just because the bare method name is "release".
    const content = [
      'class DistributedLock {',
      '  async release(): Promise<void> {}',
      '}',
      'export async function doWork(lock: DistributedLock): Promise<void> {',
      '  await doStuff();',
      '  lock.release();',
      '}',
    ].join('\n');

    const violations = analyzeFileForDetachedPromises(content, 'src/example.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0]?.match).toBe('lock.release();');
  });

  it('still allows a synchronous release() when voided (the established escape hatch)', () => {
    const content = [
      'class DistributedLock {',
      '  async release(): Promise<void> {}',
      '}',
      'export async function doWork(lock: DistributedLock): Promise<void> {',
      '  void lock.release();',
      '}',
    ].join('\n');

    const violations = analyzeFileForDetachedPromises(content, 'src/example.ts');
    expect(violations).toHaveLength(0);
  });
});
