import { describe, expect, it } from 'vitest';

import { projectJsonScalarMetadata } from '../json-scalars.js';

describe('projectJsonScalarMetadata', () => {
  it('returns undefined when metadata is missing or has no scalar values', () => {
    expect(projectJsonScalarMetadata(undefined)).toBeUndefined();
    expect(
      projectJsonScalarMetadata({
        nested: { value: 'x' },
        list: ['x'],
        missing: null,
        callback: () => 'x',
      }),
    ).toBeUndefined();
  });

  it('keeps only JSON scalar metadata values', () => {
    expect(
      projectJsonScalarMetadata({
        text: 'value',
        count: 3,
        enabled: false,
        nested: { value: 'x' },
        list: ['x'],
        missing: null,
      }),
    ).toEqual({
      text: 'value',
      count: 3,
      enabled: false,
    });
  });
});
