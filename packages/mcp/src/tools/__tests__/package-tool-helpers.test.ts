import { err, ok } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { packageSourceFilter, packageToolResult } from '../package-tool-helpers.js';

describe('package-tool-helpers', () => {
  it('projects source filters without inventing fields', () => {
    expect(
      packageSourceFilter({
        packages: ['a'],
        filePath: 'src/a.ts',
        filePrefix: 'src/',
        kinds: ['function-declaration'],
        visibilities: ['exported'],
        sourceScope: 'production',
        generated: 'exclude',
      }),
    ).toEqual({
      packages: ['a'],
      filePath: 'src/a.ts',
      filePrefix: 'src/',
      kinds: ['function-declaration'],
      visibilities: ['exported'],
      sourceScope: 'production',
      generated: 'exclude',
    });
  });

  it('renders ok and error graph-port outcomes', async () => {
    const okOut = await packageToolResult(Promise.resolve(ok({ rows: [] })));
    expect(okOut.isError).not.toBe(true);
    const text = okOut.content[0]?.type === 'text' ? okOut.content[0].text : '';
    expect(JSON.parse(text)).toEqual({ rows: [] });

    const failOut = await packageToolResult(
      Promise.resolve(err({ code: 'graph-catalog-unavailable', message: 'none' })),
    );
    expect(failOut.isError).toBe(true);
  });
});
