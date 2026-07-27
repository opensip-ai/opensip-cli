import { afterEach, describe, expect, it } from 'vitest';

import {
  registerInterruptCleanup,
  resetInterruptCleanupsForTests,
  runInterruptCleanups,
} from './interrupt-cleanup.js';

afterEach(() => resetInterruptCleanupsForTests());

describe('interrupt cleanup registry', () => {
  it('runs active resources once in LIFO order and isolates cleanup faults', () => {
    const events: string[] = [];
    registerInterruptCleanup(() => events.push('first'));
    registerInterruptCleanup(() => {
      events.push('second');
      throw new Error('simulated cleanup fault');
    });
    registerInterruptCleanup(() => events.push('third'));

    runInterruptCleanups();
    runInterruptCleanups();

    expect(events).toEqual(['third', 'second', 'first']);
  });

  it('does not invoke a resource released by normal teardown', () => {
    const events: string[] = [];
    const release = registerInterruptCleanup(() => events.push('cleanup'));

    release();
    release();
    runInterruptCleanups();

    expect(events).toEqual([]);
  });
});
