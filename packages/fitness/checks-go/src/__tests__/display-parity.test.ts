import { findOrphanedDisplayKeys } from '@opensip-cli/test-support';
import { describe, expect, it } from 'vitest';

import { checkDisplay } from '../display/index.js';
import { checks } from '../index.js';

describe('checkDisplay parity', () => {
  it('has no display keys without a matching check slug', () => {
    expect(findOrphanedDisplayKeys(checks, checkDisplay)).toEqual([]);
  });
});
