import { describe, expect, it } from 'vitest';

import { analyzeAllCheckIdUnique } from '../../../../opensip-cli/fit/checks/check-id-unique.mjs';

describe('check-id-unique dogfood check', () => {
  it('flags duplicate defineCheck UUIDs across first-party check authoring files', async () => {
    const files = new Map([
      [
        '/repo/packages/fitness/checks-typescript/src/checks/a.ts',
        [
          'export const a = defineCheck({',
          "  id: '11111111-2222-4333-8444-555555555555',",
          "  slug: 'a',",
          '});',
        ].join('\n'),
      ],
      [
        '/repo/opensip-cli/fit/checks/b.mjs',
        [
          'export const checks = [defineCheck({',
          "  id: '11111111-2222-4333-8444-555555555555',",
          "  slug: 'b',",
          '})];',
        ].join('\n'),
      ],
      [
        '/repo/packages/fitness/checks-universal/src/checks/c.ts',
        [
          'export const c = defineCheck({',
          "  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',",
          "  slug: 'c',",
          '});',
        ].join('\n'),
      ],
    ]);

    const findings = await analyzeAllCheckIdUnique({
      paths: [...files.keys()],
      readMany: async (paths: readonly string[]) =>
        new Map(paths.map((path) => [path, files.get(path) ?? ''])),
    });

    expect(findings).toHaveLength(2);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'check-id-unique',
          filePath: '/repo/packages/fitness/checks-typescript/src/checks/a.ts',
        }),
        expect.objectContaining({
          type: 'check-id-unique',
          filePath: '/repo/opensip-cli/fit/checks/b.mjs',
        }),
      ]),
    );
    expect(findings[0]?.message).toContain('11111111-2222-4333-8444-555555555555');
  });

  it('ignores repeated UUIDs outside first-party check authoring files', async () => {
    const duplicate = [
      'export const notACheck = {',
      "  id: '11111111-2222-4333-8444-555555555555',",
      '};',
    ].join('\n');
    const files = new Map([
      ['/repo/packages/fitness/checks-typescript/src/__tests__/fixture.ts', duplicate],
      ['/repo/packages/fitness/engine/src/scaffold/examples.ts', duplicate],
    ]);

    const findings = await analyzeAllCheckIdUnique({
      paths: [...files.keys()],
      readMany: async (paths: readonly string[]) =>
        new Map(paths.map((path) => [path, files.get(path) ?? ''])),
    });

    expect(findings).toEqual([]);
  });
});
