import { afterEach, describe, expect, it } from 'vitest';

import { shouldUseSuiteLiveView } from '../suite-live-view-policy.js';

const originalIsTTY = process.stdout.isTTY;

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
});

describe('shouldUseSuiteLiveView', () => {
  it('uses the live view on an interactive TTY without --json', () => {
    setTTY(true);
    expect(shouldUseSuiteLiveView({ json: false })).toBe(true);
  });

  it('never uses the live view when --json is requested, even on a TTY', () => {
    setTTY(true);
    expect(shouldUseSuiteLiveView({ json: true })).toBe(false);
  });

  it('falls through to static output when stdout is not a TTY', () => {
    setTTY(false);
    expect(shouldUseSuiteLiveView({ json: false })).toBe(false);
  });

  it('stays static for a non-TTY --json run (both gates fail)', () => {
    setTTY(false);
    expect(shouldUseSuiteLiveView({ json: true })).toBe(false);
  });
});
