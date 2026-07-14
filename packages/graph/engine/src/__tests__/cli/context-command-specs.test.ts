import { describe, expect, it } from 'vitest';

import {
  graphContextCommandSpecs,
  graphContextSelectTestsCommandSpec,
} from '../../cli/context/context-command-specs.js';

import type { ToolCliContext, ToolRunCompletion } from '@opensip-cli/core';

describe('graph context producer CommandSpecs', () => {
  it('mounts three hidden evidence-only commands with the host-owned raw reason', () => {
    expect(graphContextCommandSpecs.map((spec) => spec.name)).toEqual([
      'graph-context-inventory',
      'graph-context-ensure',
      'graph-context-select-tests',
    ]);
    for (const spec of graphContextCommandSpecs) {
      expect(spec).toMatchObject({
        visibility: 'internal',
        output: 'raw-stream',
        rawStreamReason: 'host-orchestrated-evidence',
        producesEvidenceSnapshot: true,
      });
      expect(spec.producesVerdict).not.toBe(true);
    }
  });

  it('returns explicit optional unsupported evidence when no files are supplied', async () => {
    const result = (await graphContextSelectTestsCommandSpec.handler(
      { cwd: '/repo', files: [] },
      {} as ToolCliContext,
    )) as ToolRunCompletion;
    expect(result.evidenceSnapshots).toEqual([
      expect.objectContaining({
        kind: 'test-selection',
        status: 'unsupported',
        coverage: expect.objectContaining({ status: 'unavailable' }),
      }),
    ]);
  });

  it('accumulates --files through the option parse helper', () => {
    const filesOption = graphContextSelectTestsCommandSpec.options?.[0];
    expect(filesOption?.flag).toBe('--files');
    const parse = filesOption?.parse;
    expect(parse).toBeTypeOf('function');
    if (parse === undefined) return;
    expect(parse('src/a.ts', undefined)).toEqual(['src/a.ts']);
    expect(parse('src/b.ts', ['src/a.ts'])).toEqual(['src/a.ts', 'src/b.ts']);
    expect(parse('src/c.ts', 'not-an-array')).toEqual(['src/c.ts']);
  });
});
