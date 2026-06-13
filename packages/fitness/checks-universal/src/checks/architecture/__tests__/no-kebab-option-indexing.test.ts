/**
 * Unit tests for the `no-kebab-option-indexing` guardrail.
 */
import { describe, expect, it } from 'vitest';

import { analyzeNoKebabOptionIndexing as analyze } from '../no-kebab-option-indexing.js';

const SRC = 'packages/cli/src/commands/host-subcommand-groups.ts';

describe('analyzeNoKebabOptionIndexing', () => {
  it('flags opts indexed by a kebab-case key and names the camelCase fix', () => {
    const v = analyze("const x = opts['summary-only'];\n", SRC);
    expect(v).toHaveLength(1);
    expect(v[0]?.type).toBe('no-kebab-option-indexing');
    expect(v[0]?.message).toContain('summaryOnly');
  });

  it('flags rawOpts/parsedOpts kebab indexing with either quote style', () => {
    expect(analyze('const x = rawOpts["report-to"];\n', SRC)).toHaveLength(1);
    expect(analyze("const x = parsedOpts['dry-run'];\n", SRC)).toHaveLength(1);
  });

  it('does not flag camelCase property access', () => {
    expect(analyze('const x = opts.summaryOnly;\n', SRC)).toEqual([]);
  });

  it('does not flag kebab indexing of non-options objects (headers/style/env)', () => {
    expect(analyze("const x = headers['content-type'];\n", SRC)).toEqual([]);
    expect(analyze("const x = style['font-size'];\n", SRC)).toEqual([]);
  });

  it('skips comment lines', () => {
    expect(analyze("// never write opts['summary-only'] — Commander camelCases it\n", SRC)).toEqual(
      [],
    );
  });

  it('skips test files', () => {
    expect(analyze("const x = opts['summary-only'];\n", `${SRC.replace('.ts', '.test.ts')}`)).toEqual(
      [],
    );
  });
});
