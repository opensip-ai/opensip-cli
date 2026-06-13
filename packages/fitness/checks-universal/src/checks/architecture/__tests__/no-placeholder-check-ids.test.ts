import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { analyzeNoPlaceholderCheckIds } from '../no-placeholder-check-ids.js';

const fixtureDir = path.join(import.meta.dirname, '../__fixtures__/no-placeholder-check-ids');

function loadFixture(name: string): string {
  return readFileSync(path.join(fixtureDir, `${name}.ts`), 'utf8');
}

describe('no-placeholder-check-ids (meta)', () => {
  it('passes when the check id is a promoted real UUID with ADR reference in context', () => {
    const content = loadFixture('clean');
    // Pass a production-looking filePath (not under __fixtures__ or .test.) so skip logic does not suppress
    const filePath = 'packages/fitness/checks-universal/src/checks/foo/some-check.ts';
    const violations = analyzeNoPlaceholderCheckIds(content, filePath);
    expect(violations).toHaveLength(0);
  });

  it('flags a check definition that uses a legacy patterned placeholder ID', () => {
    const content = loadFixture('violation');
    const filePath = 'packages/fitness/checks-universal/src/checks/bar/bad-check.ts';
    const violations = analyzeNoPlaceholderCheckIds(content, filePath);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('placeholder or patterned ID');
    expect(violations[0].severity).toBe('error');
  });
});
