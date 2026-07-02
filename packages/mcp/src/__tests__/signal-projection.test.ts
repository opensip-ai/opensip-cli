import { describe, expect, it } from 'vitest';

import { toMcpFinding } from '../signal-projection.js';

import type { Signal } from '@opensip-cli/core';

describe('toMcpFinding', () => {
  it('preserves compact repair metadata', () => {
    const signal: Signal = {
      id: 'sig-1',
      source: 'fitness',
      provider: 'opensip',
      severity: 'medium',
      category: 'quality',
      ruleId: 'fit:typescript-directive-hygiene',
      message: 'Use @ts-expect-error instead of @ts-ignore',
      filePath: 'src/example.ts',
      line: 4,
      metadata: {},
      repair: {
        autofixable: true,
        actions: [
          {
            id: 'replace-ts-ignore',
            kind: 'text-replacement',
            title: 'Replace @ts-ignore',
            autofixable: true,
            target: { filePath: 'src/example.ts', line: 4 },
          },
        ],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    expect(toMcpFinding(signal).repair?.actions?.[0]?.id).toBe('replace-ts-ignore');
  });
});
