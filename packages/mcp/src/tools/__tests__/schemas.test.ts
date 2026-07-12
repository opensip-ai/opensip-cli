/**
 * Per-tool Zod boundary schemas (Task 6.1 §Hardening + Phase 0 query contracts).
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DEPTH,
  DEFAULT_IDENTITY_SEARCH_LIMIT,
  DEFAULT_LIMIT,
  MAX_CURSOR_LEN,
  MAX_DEPTH,
  MAX_LIMIT,
  MAX_PACKAGE_ARRAY,
  MAX_QUERY_LEN,
  architectureSections,
  architectureTopN,
  boundedName,
  boundedText,
  compactDetail,
  cursor,
  depth,
  filePath,
  filePrefix,
  groupBy,
  identitySearchLimit,
  kinds,
  limit,
  packageArray,
  packageEvidenceLimit,
  packageProofLimit,
  packageSampleLimit,
  pageLimit,
  query,
  sourceScope,
  strictInput,
  symbolId,
  traversalIdentity,
} from '../schemas.js';

describe('symbolId schema', () => {
  it('accepts the canonical "<filePath>:<line>:<column>" shape', () => {
    expect(symbolId().safeParse('packages/core/src/a.ts:12:4').success).toBe(true);
  });

  it('rejects a bare name (no line:col)', () => {
    expect(symbolId().safeParse('saveBaseline').success).toBe(false);
  });

  it('rejects a malformed id whose trailing groups are not integers', () => {
    expect(symbolId().safeParse('a.ts:12:x').success).toBe(false);
    expect(symbolId().safeParse('a.ts:line:col').success).toBe(false);
    expect(symbolId().safeParse('a.ts:0:0').success).toBe(false);
  });

  it('rejects absolute, UNC, and traversal-bearing symbol paths', () => {
    expect(symbolId().safeParse('/etc/passwd:1:0').success).toBe(false);
    expect(symbolId().safeParse('C:\\windows\\system32:1:0').success).toBe(false);
    expect(symbolId().safeParse('\\\\server\\share\\a.ts:1:0').success).toBe(false);
    expect(symbolId().safeParse('../secret.ts:1:0').success).toBe(false);
  });

  it('normalizes accepted backslash paths to the canonical POSIX id', () => {
    const parsed = symbolId().safeParse('src\\api\\x.ts:12:4');
    expect(parsed.success && parsed.data).toBe('src/api/x.ts:12:4');
  });
});

describe('filePath schema', () => {
  it('accepts a project-relative path', () => {
    const parsed = filePath().safeParse('packages/core/src/a.ts');
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toBe('packages/core/src/a.ts');
  });

  it('normalizes backslashes to POSIX', () => {
    const parsed = filePath().safeParse('src\\api\\x.ts');
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toBe('src/api/x.ts');
  });

  it('rejects an absolute POSIX path', () => {
    expect(filePath().safeParse('/etc/passwd').success).toBe(false);
  });

  it('rejects a Windows drive-absolute path', () => {
    expect(filePath().safeParse('C:\\windows\\system32').success).toBe(false);
    expect(filePath().safeParse('C:relative\\path.ts').success).toBe(false);
  });

  it('rejects UNC-style absolute paths', () => {
    expect(filePath().safeParse('//server/share').success).toBe(false);
    expect(filePath().safeParse('\\\\server\\share').success).toBe(false);
  });

  it('rejects a ".." traversal escaping the project root', () => {
    expect(filePath().safeParse('../../etc/passwd').success).toBe(false);
    expect(filePath().safeParse('src/../../secret').success).toBe(false);
  });

  it('rejects empty segments and single-dot segments', () => {
    expect(filePath().safeParse('src//a.ts').success).toBe(false);
    expect(filePath().safeParse('src/./a.ts').success).toBe(false);
  });

  it('rejects control characters', () => {
    expect(filePath().safeParse('src/a\u0000.ts').success).toBe(false);
    expect(filePath().safeParse('src/a\u0085.ts').success).toBe(false);
    expect(filePath().safeParse('src/a\u009F.ts').success).toBe(false);
    expect(query().safeParse('find\u0085symbol').success).toBe(false);
  });
});

describe('filePrefix schema', () => {
  it('reuses the same path trust boundary', () => {
    expect(filePrefix().safeParse('src/api').success).toBe(true);
    expect(filePrefix().safeParse('../src').success).toBe(false);
  });
});

describe('query schema', () => {
  it('accepts a normal search term', () => {
    expect(query().safeParse('saveBaseline').success).toBe(true);
  });

  it('rejects an over-long (potential ReDoS-payload) query', () => {
    expect(query().safeParse('x'.repeat(MAX_QUERY_LEN + 1)).success).toBe(false);
  });

  it('rejects an empty query', () => {
    expect(query().safeParse('').success).toBe(false);
  });
});

describe('depth schema', () => {
  it('defaults to DEFAULT_DEPTH when omitted', () => {
    const parsed = depth().safeParse(undefined);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toBe(DEFAULT_DEPTH);
  });

  it('rejects a depth above the maximum (not silently clamped through here)', () => {
    expect(depth().safeParse(MAX_DEPTH + 1).success).toBe(false);
  });

  it('rejects a zero / negative depth', () => {
    expect(depth().safeParse(0).success).toBe(false);
  });
});

describe('limit schema', () => {
  it('rejects a limit above MAX_LIMIT', () => {
    expect(limit().safeParse(MAX_LIMIT + 1).success).toBe(false);
  });

  it('accepts the maximum limit', () => {
    expect(limit().safeParse(MAX_LIMIT).success).toBe(true);
  });

  it('is optional', () => {
    expect(limit().safeParse(undefined).success).toBe(true);
  });
});

describe('pageLimit schema', () => {
  it('defaults to 100', () => {
    const parsed = pageLimit().safeParse(undefined);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toBe(DEFAULT_LIMIT);
  });

  it('rejects above max 500', () => {
    expect(pageLimit().safeParse(501).success).toBe(false);
  });
});

describe('package detail limits (P2 Phase 2.4)', () => {
  it('defaults sample/evidence/proof limits to 0 (compact opt-in)', () => {
    expect(packageSampleLimit().safeParse(undefined)).toMatchObject({ success: true, data: 0 });
    expect(packageEvidenceLimit().safeParse(undefined)).toMatchObject({ success: true, data: 0 });
    expect(packageProofLimit().safeParse(undefined)).toMatchObject({ success: true, data: 0 });
  });

  it('accepts the inclusive max bounds', () => {
    expect(packageSampleLimit().safeParse(5).success).toBe(true);
    expect(packageEvidenceLimit().safeParse(100).success).toBe(true);
    expect(packageProofLimit().safeParse(50).success).toBe(true);
  });

  it('rejects negative, fractional, and oversized values', () => {
    for (const schema of [packageSampleLimit(), packageEvidenceLimit(), packageProofLimit()]) {
      expect(schema.safeParse(-1).success).toBe(false);
      expect(schema.safeParse(1.5).success).toBe(false);
    }
    expect(packageSampleLimit().safeParse(6).success).toBe(false);
    expect(packageEvidenceLimit().safeParse(101).success).toBe(false);
    expect(packageProofLimit().safeParse(51).success).toBe(false);
  });
});

describe('identitySearchLimit and compactDetail (P2 Phase 2/3)', () => {
  it('defaults identity search to 20 and accepts 1–500 inclusive', () => {
    expect(DEFAULT_IDENTITY_SEARCH_LIMIT).toBe(20);
    expect(identitySearchLimit().safeParse(undefined)).toMatchObject({
      success: true,
      data: 20,
    });
    expect(identitySearchLimit().safeParse(1).success).toBe(true);
    expect(identitySearchLimit().safeParse(19).success).toBe(true);
    expect(identitySearchLimit().safeParse(20).success).toBe(true);
    expect(identitySearchLimit().safeParse(21).success).toBe(true);
    expect(identitySearchLimit().safeParse(500).success).toBe(true);
    expect(identitySearchLimit().safeParse(0).success).toBe(false);
    expect(identitySearchLimit().safeParse(501).success).toBe(false);
  });

  it('defaults compactDetail and rejects unknown modes', () => {
    expect(compactDetail('nodes').safeParse(undefined)).toMatchObject({
      success: true,
      data: 'nodes',
    });
    expect(compactDetail('summary').safeParse(undefined)).toMatchObject({
      success: true,
      data: 'summary',
    });
    expect(compactDetail().safeParse('groups').success).toBe(true);
    expect(compactDetail().safeParse('verbose').success).toBe(false);
  });

  it('bounds architecture sections and top-N (1–100, default 20)', () => {
    expect(architectureSections().safeParse(undefined)).toMatchObject({
      success: true,
      data: ['metrics'],
    });
    expect(architectureSections().safeParse(['metrics', 'metrics']).success).toBe(false);
    expect(architectureSections().safeParse([]).success).toBe(false);
    expect(architectureTopN().safeParse(undefined)).toMatchObject({ success: true, data: 20 });
    expect(architectureTopN().safeParse(1).success).toBe(true);
    expect(architectureTopN().safeParse(100).success).toBe(true);
    expect(architectureTopN().safeParse(0).success).toBe(false);
    expect(architectureTopN().safeParse(101).success).toBe(false);
  });
});

describe('cursor schema', () => {
  it('accepts base64url', () => {
    expect(cursor().safeParse('abcABC123_-').success).toBe(true);
  });

  it('rejects non-base64url characters', () => {
    expect(cursor().safeParse('abc+/=').success).toBe(false);
  });

  it('rejects oversized cursors', () => {
    expect(cursor().safeParse('a'.repeat(MAX_CURSOR_LEN + 1)).success).toBe(false);
  });
});

describe('packageArray / kinds enums', () => {
  it('rejects duplicate packages and oversized arrays', () => {
    expect(packageArray().safeParse(['a', 'a']).success).toBe(false);
    expect(
      packageArray().safeParse(
        Array.from({ length: MAX_PACKAGE_ARRAY + 1 }, (_, i) => `p${String(i)}`),
      ).success,
    ).toBe(false);
  });

  it('rejects unknown kind enums', () => {
    expect(kinds().safeParse(['not-a-kind']).success).toBe(false);
    expect(kinds().safeParse(['method']).success).toBe(true);
  });
});

describe('boundedName', () => {
  it('shares the 256-character control-free boundary for package/tool/command names', () => {
    expect(boundedName('command').safeParse('inspect').success).toBe(true);
    expect(boundedName('command').safeParse('x'.repeat(257)).success).toBe(false);
    expect(boundedName('command').safeParse('bad\u0000name').success).toBe(false);
  });
});

describe('boundedText', () => {
  it('rejects controls for legacy refs, filters, selectors, and action ids', () => {
    expect(boundedText(512, 'value').safeParse('id:safe').success).toBe(true);
    expect(boundedText(512, 'value').safeParse('id:bad\u0085value').success).toBe(false);
  });
});

describe('shared enums', () => {
  it('defaults sourceScope and groupBy and traversalIdentity', () => {
    expect(
      sourceScope().safeParse(undefined).success && sourceScope().safeParse(undefined).data,
    ).toBe('all');
    expect(groupBy().safeParse(undefined).success && groupBy().safeParse(undefined).data).toBe(
      'none',
    );
    expect(
      traversalIdentity().safeParse(undefined).success &&
        traversalIdentity().safeParse(undefined).data,
    ).toBe('occurrence');
  });

  it('rejects unknown enum values', () => {
    expect(sourceScope().safeParse('prod').success).toBe(false);
    expect(groupBy().safeParse('module').success).toBe(false);
  });
});

describe('strictInput', () => {
  it('rejects unknown SDK arguments instead of stripping them', () => {
    const schema = strictInput({ limit: pageLimit() });
    expect(schema.safeParse({ limit: 10 }).success).toBe(true);
    expect(schema.safeParse({ limit: 10, unexpected: true }).success).toBe(false);
  });
});
