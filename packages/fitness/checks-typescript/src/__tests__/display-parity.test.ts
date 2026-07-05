import { findOrphanedDisplayKeys } from '@opensip-cli/test-support';
import { describe, expect, it } from 'vitest';

import { CHECK_DISPLAY, checks } from '../index.js';

describe('CHECK_DISPLAY parity', () => {
  it('has no display keys without a matching check slug', () => {
    expect(findOrphanedDisplayKeys(checks, CHECK_DISPLAY)).toEqual([]);
  });
});
