import { describe, expect, it } from 'vitest';

import { parseFirstSemver } from '../version.js';

describe('parseFirstSemver', () => {
  it('extracts a bare semver', () => {
    expect(parseFirstSemver('1.2.3')).toBe('1.2.3');
  });

  it('strips a leading v', () => {
    expect(parseFirstSemver('v8.18.4')).toBe('8.18.4');
    expect(parseFirstSemver('gitleaks version v8.19.0\n')).toBe('8.19.0');
  });

  it('finds the version embedded in a longer banner', () => {
    expect(parseFirstSemver('semgrep 1.70.0 on python 3.12')).toBe('1.70.0');
  });

  it('keeps prerelease / build metadata', () => {
    expect(parseFirstSemver('cargo-deny 0.14.3-beta.1')).toBe('0.14.3-beta.1');
  });

  it('returns undefined when there is no semver', () => {
    expect(parseFirstSemver('unknown build')).toBeUndefined();
    expect(parseFirstSemver('')).toBeUndefined();
  });
});
