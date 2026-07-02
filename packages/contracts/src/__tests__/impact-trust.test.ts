import { describe, expect, it } from 'vitest';

import {
  MAX_IMPACT_UNCERTAINTIES,
  buildImpactTrust,
  changedEntriesToImpactUncertainties,
  gitWarningsToImpactUncertainties,
  mergeImpactUncertainties,
  type ImpactUncertainty,
} from '../impact-trust.js';

function uncertainty(index: number): ImpactUncertainty {
  return {
    code: 'changed-file-unmatched',
    source: 'impact',
    filePath: `src/file-${String(index)}.ts`,
    message: `Changed file src/file-${String(index)}.ts is not represented in the graph catalog.`,
  };
}

describe('impact trust helpers', () => {
  it('classifies no-uncertainty trust as fully verified targeted coverage', () => {
    expect(buildImpactTrust()).toEqual({
      coverage: 'full',
      fallback: 'targeted',
      fullyVerified: true,
      uncertainties: [],
    });
  });

  it('classifies targeted uncertainty as unknown and full-run fallback as partial', () => {
    const item = uncertainty(1);
    expect(buildImpactTrust({ uncertainties: [item] })).toMatchObject({
      coverage: 'unknown',
      fallback: 'targeted',
      fullyVerified: false,
    });
    expect(buildImpactTrust({ uncertainties: [item], fallback: 'full-run' })).toMatchObject({
      coverage: 'partial',
      fallback: 'full-run',
      fullyVerified: false,
    });
  });

  it('dedupes uncertainty by code, source, and file path', () => {
    const merged = mergeImpactUncertainties(
      [
        {
          code: 'changed-file-renamed',
          source: 'git',
          filePath: 'src/a.ts',
          message: 'first',
        },
      ],
      [
        {
          code: 'changed-file-renamed',
          source: 'git',
          filePath: 'src/a.ts',
          message: 'second',
        },
      ],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      code: 'changed-file-renamed',
      filePath: 'src/a.ts',
    });
  });

  it('caps trust uncertainty output with a summary reason', () => {
    const trust = buildImpactTrust({
      uncertainties: Array.from({ length: MAX_IMPACT_UNCERTAINTIES + 3 }, (_, index) =>
        uncertainty(index),
      ),
    });

    expect(trust.uncertainties).toHaveLength(MAX_IMPACT_UNCERTAINTIES);
    expect(trust.uncertainties.at(-1)).toMatchObject({
      code: 'impact-uncertainty-truncated',
      source: 'impact',
    });
  });

  it('maps git warnings and changed entry statuses without reading file contents', () => {
    expect(
      gitWarningsToImpactUncertainties([
        { code: 'git-shallow', message: 'Repository is shallow.' },
        { code: 'ignored-warning', message: 'not forwarded' },
      ]),
    ).toEqual([
      {
        code: 'git-shallow',
        source: 'git',
        message: 'Repository is shallow.',
      },
    ]);

    const entryUncertainties = changedEntriesToImpactUncertainties([
      { path: 'src/old.ts', status: 'deleted' },
      {
        path: 'src/new.ts',
        previousPath: 'src/old-name.ts',
        status: 'renamed',
      },
      { path: 'src/modified.ts', status: 'modified' },
    ]);
    expect(entryUncertainties.map((item) => item.code)).toEqual([
      'changed-file-deleted',
      'changed-file-renamed',
    ]);
    expect(entryUncertainties.map((item) => item.message).join('\n')).not.toContain(
      'function body',
    );
  });
});
