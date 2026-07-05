import { describe, expect, it } from 'vitest';

import { isSessionCwdWithin } from '../session-cwd-scope.js';

describe('isSessionCwdWithin', () => {
  it('accepts the exact root and nested children', () => {
    expect(isSessionCwdWithin('/repo', '/repo')).toBe(true);
    expect(isSessionCwdWithin('/repo/packages/app', '/repo')).toBe(true);
  });

  it('rejects sibling-prefix paths', () => {
    expect(isSessionCwdWithin('/repo-other', '/repo')).toBe(false);
  });

  it('rejects empty and relative stored cwd values', () => {
    expect(isSessionCwdWithin('', '/repo')).toBe(false);
    expect(isSessionCwdWithin('repo/packages/app', '/repo')).toBe(false);
  });

  it('normalizes traversal before comparing', () => {
    expect(isSessionCwdWithin('/repo/../other', '/repo')).toBe(false);
  });

  it('is case-sensitive and fails closed for case variants', () => {
    expect(isSessionCwdWithin('/Users/SB/repo', '/Users/sb/repo')).toBe(false);
  });
});
