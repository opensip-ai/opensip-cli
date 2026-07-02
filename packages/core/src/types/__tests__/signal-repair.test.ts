import { describe, expect, it } from 'vitest';

import { createSignal } from '../signal.js';

describe('Signal.repair', () => {
  it('round-trips through createSignal and JSON', () => {
    const signal = createSignal({
      source: 'graph',
      ruleId: 'graph:large-function',
      severity: 'high',
      message: 'big',
      repair: {
        repairKind: 'split-function',
        autofixable: false,
        confidence: 0.7,
      },
    });
    expect(signal.repair?.repairKind).toBe('split-function');
    const parsed = structuredClone(signal);
    expect(parsed.repair?.repairKind).toBe('split-function');
  });

  it('round-trips structured repair actions through JSON', () => {
    const signal = createSignal({
      source: 'fit',
      ruleId: 'fit:typescript-directive-hygiene',
      severity: 'high',
      message: '@ts-ignore missing justification',
      repair: {
        repairKind: 'manual',
        autofixable: true,
        actions: [
          {
            id: 'replace-ts-ignore-with-ts-expect-error',
            kind: 'replace-ts-ignore',
            title: 'Replace @ts-ignore with @ts-expect-error',
            autofixable: true,
            confidence: 0.9,
            patchHint: {
              kind: 'structured',
              summary: 'Replace the TypeScript suppression directive.',
              target: 'src/example.ts',
            },
            verification: {
              commands: ['opensip fit --check typescript-directive-hygiene'],
              notes: ['Rerun the directive hygiene check after applying.'],
            },
            target: {
              filePath: 'src/example.ts',
              line: 3,
              expectedText: '@ts-ignore',
              replacementText: '@ts-expect-error',
            },
          },
        ],
      },
    });

    const parsed = structuredClone(signal);
    expect(parsed.repair?.actions).toEqual([
      {
        id: 'replace-ts-ignore-with-ts-expect-error',
        kind: 'replace-ts-ignore',
        title: 'Replace @ts-ignore with @ts-expect-error',
        autofixable: true,
        confidence: 0.9,
        patchHint: {
          kind: 'structured',
          summary: 'Replace the TypeScript suppression directive.',
          target: 'src/example.ts',
        },
        verification: {
          commands: ['opensip fit --check typescript-directive-hygiene'],
          notes: ['Rerun the directive hygiene check after applying.'],
        },
        target: {
          filePath: 'src/example.ts',
          line: 3,
          expectedText: '@ts-ignore',
          replacementText: '@ts-expect-error',
        },
      },
    ]);
  });

  it('omits repair when absent (forward-compat)', () => {
    const signal = createSignal({
      source: 'fit',
      ruleId: 'x',
      severity: 'low',
      message: 'ok',
    });
    expect(signal.repair).toBeUndefined();
    const parsed = structuredClone(signal);
    expect(parsed.repair).toBeUndefined();
  });

  it('bridges legacy fix hints into structured repair', () => {
    const signal = createSignal({
      source: 'fit',
      ruleId: 'fit:example',
      severity: 'medium',
      message: 'legacy fix',
      fix: { action: 'refactor', confidence: 0.6, description: 'Extract the helper' },
    });
    expect(signal.fixAction).toBe('refactor');
    expect(signal.repair).toEqual({
      repairKind: 'manual',
      autofixable: false,
      confidence: 0.6,
      patchHint: { kind: 'text', summary: 'Extract the helper' },
    });
  });

  it.each([
    ['add-test', 'add-test'],
    ['fix-import', 'fix-import'],
    ['split-function', 'split-function'],
    ['extract-module', 'extract-module'],
  ] as const)('maps fix action %s to repairKind %s', (action, repairKind) => {
    const signal = createSignal({
      source: 'fit',
      ruleId: 'fit:example',
      severity: 'medium',
      message: 'fix',
      fix: { action },
    });
    expect(signal.repair?.repairKind).toBe(repairKind);
  });

  it('synthesizes patch summary from fix action when description is absent', () => {
    const signal = createSignal({
      source: 'fit',
      ruleId: 'fit:example',
      severity: 'medium',
      message: 'fix',
      fix: { action: 'add-test' },
    });
    expect(signal.repair?.patchHint).toEqual({
      kind: 'text',
      summary: 'Apply add-test remediation',
    });
  });
});
