import { describe, expect, it } from 'vitest';

import {
  analyzeFileLength,
  analyzeFileLengthForPath,
} from '../checks/file-length-limit.js';

function buildLines(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`line ${i + 1}`);
  return out.join('\n');
}

describe('analyzeFileLength', () => {
  it('passes for small files', () => {
    expect(analyzeFileLength(buildLines(50))).toHaveLength(0);
  });

  it('warns at the soft limit boundary', () => {
    const violations = analyzeFileLength(buildLines(401));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe('warning');
  });

  it('errors past the hard limit', () => {
    const violations = analyzeFileLength(buildLines(900));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe('error');
  });

  it('counts only non-empty lines', () => {
    // 200 real lines, 200 blank — should fall under soft limit
    const padded = buildLines(200) + '\n' + '\n'.repeat(200);
    expect(analyzeFileLength(padded)).toHaveLength(0);
  });
});

describe('analyzeFileLengthForPath', () => {
  it('skips test files regardless of line count', () => {
    expect(analyzeFileLengthForPath(buildLines(900), 'src/__tests__/big.test.ts')).toHaveLength(
      0,
    );
  });

  it('skips fixture paths', () => {
    expect(
      analyzeFileLengthForPath(buildLines(900), 'src/checks/__fixtures__/huge/violation.ts'),
    ).toHaveLength(0);
  });

  it('still flags oversized production files', () => {
    expect(analyzeFileLengthForPath(buildLines(900), 'src/checks/my-check.ts')).toHaveLength(1);
  });
});