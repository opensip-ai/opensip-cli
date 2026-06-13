import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { analyzeToolContractVersionPolicy } from '../tool-contract-version-policy.js';

const fixtureDir = path.join(import.meta.dirname, '../__fixtures__/tool-contract-version-policy');

function loadFixture(name: string): string {
  return readFileSync(path.join(fixtureDir, `${name}.ts`), 'utf8');
}

describe('tool-contract-version-policy (ADR-0046)', () => {
  it('passes when the definition is accompanied by an ADR-0046 reference', () => {
    const content = loadFixture('clean');
    const filePath = 'packages/core/src/tools/types.ts';
    const violations = analyzeToolContractVersionPolicy(content, filePath);
    expect(violations).toHaveLength(0);
  });

  it('flags a definition that lacks any reference to ADR-0046/0047 or the policy', () => {
    const content = loadFixture('violation');
    const filePath = 'packages/core/src/tools/types.ts';
    const violations = analyzeToolContractVersionPolicy(content, filePath);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('ADR-0046');
    expect(violations[0].severity).toBe('error');
  });

  it('passes for per-tool contract version constants with proper ADR-0047 reference', () => {
    const content = loadFixture('per-tool-clean');
    const filePath = 'packages/fitness/engine/src/some-version.ts';
    const violations = analyzeToolContractVersionPolicy(content, filePath);
    expect(violations).toHaveLength(0);
  });

  it('flags per-tool version constants missing the ADR reference', () => {
    const content = loadFixture('per-tool-violation');
    const filePath = 'packages/fitness/engine/src/some-version.ts';
    const violations = analyzeToolContractVersionPolicy(content, filePath);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toMatch(/ADR-0046|ADR-0047/);
  });
});
