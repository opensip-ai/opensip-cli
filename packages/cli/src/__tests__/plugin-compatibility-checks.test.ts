import { describe, expect, it } from 'vitest';

import { analyzeNoFirstPartyContractVersionFields } from '../../../../opensip-cli/fit/checks/no-first-party-contract-version-fields.mjs';
import { analyzeToolContractVersionPolicy } from '../../../../opensip-cli/fit/checks/tool-contract-version-policy.mjs';

describe('analyzeNoFirstPartyContractVersionFields', () => {
  const prodPath = 'packages/fitness/engine/src/tool.ts';

  it('accepts contractVersions map declarations', () => {
    const content = `
      extensionPoints: {
        contractVersions: {
          fitness: FITNESS_CONTRACT_VERSION,
        },
      },
    `;
    expect(analyzeNoFirstPartyContractVersionFields(content, prodPath)).toEqual([]);
  });

  it('flags closed first-party contract version fields', () => {
    const content = `
      extensionPoints: {
        fitnessContractVersion: FITNESS_CONTRACT_VERSION,
      },
    `;
    const violations = analyzeNoFirstPartyContractVersionFields(content, prodPath);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('fitnessContractVersion');
    expect(violations[0]?.suggestion).toContain('contractVersions');
  });

  it('ignores test files', () => {
    const content = 'fitnessContractVersion: FITNESS_CONTRACT_VERSION,';
    expect(
      analyzeNoFirstPartyContractVersionFields(
        content,
        '/repo/packages/fitness/engine/src/__tests__/tool.test.ts',
      ),
    ).toEqual([]);
  });
});

describe('analyzeToolContractVersionPolicy', () => {
  it('accepts ADR-0074 references for per-tool constants', () => {
    const content = `
      /**
       * Per-tool contract version (ADR-0074).
       */
      export const FITNESS_CONTRACT_VERSION = '1.0.0';
    `;
    expect(analyzeToolContractVersionPolicy(content, 'tool.ts')).toEqual([]);
  });
});
