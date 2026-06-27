import { describe, expect, it } from 'vitest';

import { getWorkerErrorFailureClass } from '../worker-error-failure-class.js';

describe('getWorkerErrorFailureClass', () => {
  it('returns undefined when the error has no failureClass', () => {
    expect(getWorkerErrorFailureClass(new Error('boom'))).toBeUndefined();
    expect(getWorkerErrorFailureClass('plain')).toBeUndefined();
  });

  it('returns the failureClass tag when present', () => {
    const error = Object.assign(new Error('boom'), { failureClass: 'timeout' });
    expect(getWorkerErrorFailureClass(error)).toBe('timeout');
  });
});
