import { describe, expect, it } from 'vitest';

import { normalizeAccount } from '../src/index.js';

function normalizeFixtureAccount() {
  return normalizeAccount({ displayName: ' Ada ', id: 'USER-7' });
}

describe('normalizeAccount', () => {
  it('normalizes account identity fields', () => {
    expect(normalizeFixtureAccount()).toEqual({ displayName: 'Ada', id: 'user-7' });
  });
});
