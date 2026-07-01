import { describe, expect, it } from 'vitest';

import { analyzeLanguageSpecificCheckScope } from '../../../../opensip-cli/fit/checks/language-specific-check-scope.mjs';
import { analyzeRegisteredLocalAllowlists } from '../../../../opensip-cli/fit/checks/registered-local-allowlists.mjs';

describe('check-authoring dogfood guards', () => {
  it('requires scope on language-specific first-party checks', () => {
    const content = [
      'export const missingScope = defineCheck({',
      "  id: '11111111-2222-4333-8444-555555555555',",
      "  slug: 'missing-scope',",
      '  analyze: () => [],',
      '});',
    ].join('\n');

    const findings = analyzeLanguageSpecificCheckScope(
      content,
      '/repo/packages/fitness/checks-typescript/src/checks/missing-scope.ts',
    );

    expect(findings).toEqual([
      expect.objectContaining({
        type: 'language-specific-check-scope',
        line: 1,
      }),
    ]);
  });

  it('allows scoped language-specific checks and ignores universal checks', () => {
    const content = [
      'export const scoped = defineCheck({',
      "  id: '11111111-2222-4333-8444-555555555555',",
      "  slug: 'scoped',",
      "  scope: { languages: ['typescript'], concerns: [] },",
      '  analyze: () => [],',
      '});',
    ].join('\n');

    expect(
      analyzeLanguageSpecificCheckScope(
        content,
        '/repo/packages/fitness/checks-typescript/src/checks/scoped.ts',
      ),
    ).toEqual([]);
    expect(
      analyzeLanguageSpecificCheckScope(
        content.replace('scope:', 'notScope:'),
        '/repo/packages/fitness/checks-universal/src/checks/universal.ts',
      ),
    ).toEqual([]);
  });

  it('requires project-local allowlists to be registered in seam-exemptions.json', () => {
    const content = [
      'const ALLOWLIST = [',
      '  /packages\\/graph\\/engine\\/src\\/cli\\/worker\\.ts$/,',
      '];',
    ].join('\n');

    const findings = analyzeRegisteredLocalAllowlists(
      content,
      '/repo/opensip-cli/fit/checks/example.mjs',
      { localAllowlists: [] },
    );

    expect(findings).toEqual([
      expect.objectContaining({
        type: 'registered-local-allowlists',
        line: 1,
      }),
    ]);
  });

  it('accepts registered project-local allowlists with reasons', () => {
    const content = [
      'const ALLOWLIST = [',
      '  /packages\\/graph\\/engine\\/src\\/cli\\/worker\\.ts$/,',
      '];',
    ].join('\n');

    const findings = analyzeRegisteredLocalAllowlists(
      content,
      '/repo/opensip-cli/fit/checks/example.mjs',
      {
        localAllowlists: [
          {
            file: 'opensip-cli/fit/checks/example.mjs',
            name: 'ALLOWLIST',
            reason: 'documented worker transport exception',
          },
        ],
      },
    );

    expect(findings).toEqual([]);
  });
});
