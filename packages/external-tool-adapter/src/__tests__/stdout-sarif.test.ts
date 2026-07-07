import { ToolError } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { parseStdoutSarif } from '../stdout-sarif.js';

describe('parseStdoutSarif', () => {
  it('normalizes valid SARIF emitted on stdout', () => {
    const signals = parseStdoutSarif(
      JSON.stringify({
        runs: [
          {
            tool: { driver: { name: 'ast-grep', rules: [{ id: 'no-debugger' }] } },
            results: [
              {
                ruleId: 'no-debugger',
                level: 'warning',
                message: { text: 'debugger statement' },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: 'src/app.ts' },
                      region: { startLine: 3 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
      { source: 'ast-grep' },
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      source: 'ast-grep',
      ruleId: 'no-debugger',
      filePath: 'src/app.ts',
      line: 3,
    });
  });

  it('fails malformed stdout instead of treating it as a clean scan', () => {
    expect(() => parseStdoutSarif('not sarif', { source: 'ast-grep' })).toThrow(ToolError);
    expect(() => parseStdoutSarif('not sarif', { source: 'ast-grep' })).toThrow(/invalid SARIF/);
  });
});
