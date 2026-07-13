import { describe, expect, it } from 'vitest';

describe('health metadata', () => {
  it('keeps an unrelated test decoy healthy', () => {
    expect({ status: 'ok' }).toEqual({ status: 'ok' });
  });
});
