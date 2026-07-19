/**
 * Shared scanner exclude-builder: flag shaping + the execFile-array security
 * contract (paths land as single, un-escaped argv elements — never a shell
 * string).
 */

import { describe, expect, it } from 'vitest';

import { buildScannerExclude } from '../scanner-exclude.js';

describe('buildScannerExclude', () => {
  it('emits [flag, segment] for a plain flag (cppcheck/ruff shape)', () => {
    expect(
      buildScannerExclude({ excludePath: '/proj/opensip-cli/.runtime' }, { flag: '-i' }).args,
    ).toEqual(['-i', 'opensip-cli/.runtime']);
    expect(
      buildScannerExclude(
        { excludePath: '/proj/opensip-cli/.runtime/' },
        { flag: '--extend-exclude' },
      ).args,
    ).toEqual(['--extend-exclude', 'opensip-cli/.runtime']);
  });

  it('maps the derived segment through the pattern callback (ast-grep glob shape)', () => {
    expect(
      buildScannerExclude(
        { excludePath: 'C:\\proj\\opensip-cli\\.runtime' },
        {
          flag: '--globs',
          pattern: (segment) => (segment.endsWith('/**') ? `!${segment}` : `!${segment}/**`),
        },
      ).args,
    ).toEqual(['--globs', '!opensip-cli/.runtime/**']);
  });

  it('falls back to the last two path segments for non-runtime paths', () => {
    expect(
      buildScannerExclude({ excludePath: '/var/cache/scans/output' }, { flag: '-i' }).args,
    ).toEqual(['-i', 'scans/output']);
  });

  it('keeps hostile paths as a single un-escaped argv element (execFile array contract)', () => {
    const hostile = '/proj/evil dir; rm -rf here/sub';
    const { args } = buildScannerExclude({ excludePath: hostile }, { flag: '-i' });
    // Exactly two distinct elements: the flag, then the raw pattern value.
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('-i');
    // The space and `;` shell metacharacters survive verbatim in ONE element —
    // no quoting, no escaping, no concatenation into a shell string.
    expect(args[1]).toBe('evil dir; rm -rf here/sub');
  });
});
