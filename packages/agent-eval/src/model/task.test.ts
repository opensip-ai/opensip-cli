import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  factMatches,
  MAX_ARGUMENT_OBSERVATIONS,
  resolveStepArguments,
} from './argument-resolution.js';
import { makeStepRecord, type SetupRecord, type ToolInvoker } from './record.js';
import {
  type AnswerFact,
  type AnswerFactPattern,
  type EditOperation,
  type FactObservation,
  type GoldTask,
  type StrategyStep,
} from './task.js';

const extractNothing = (): readonly AnswerFact[] => [];

function baseStep(arguments_: StrategyStep['arguments']): StrategyStep {
  return {
    arguments: arguments_,
    extract: extractNothing,
    id: 'lookup-callers',
    rationale: 'Follow the observed declaration handle.',
    tool: 'references_to',
  };
}

const observations: readonly FactObservation[] = [
  {
    fact: {
      bodyHash: 'body:1',
      filePath: 'src/runner.ts',
      kind: 'symbol-handle',
      name: 'run',
      symbolId: 'symbol:run',
    },
    leg: 'main',
    ordinal: 0,
    stepId: 'find-run',
  },
];

describe('task model', () => {
  it('represents paired strategies and a bounded mutation loop', () => {
    const opensip = baseStep({ query: 'run' });
    const control = baseStep({ pattern: 'function run' });
    const task: GoldTask = {
      assertions: {
        scoped: [
          {
            leg: 'post-edit',
            mustExclude: [{ kind: 'symbol', name: 'removed' }],
          },
          {
            leg: 'recovery',
            mustExclude: [{ kind: 'symbol', name: 'removed' }],
          },
        ],
        staleness: { postEditLeg: 'post-edit', recoveryLeg: 'recovery' },
      },
      fixture: 'typescript/stale-delete',
      id: 'stale-delete',
      question: 'Does the deleted symbol still exist?',
      staleness: {
        edit: { operations: [{ kind: 'delete', path: 'src/removed.ts' }] },
        postEditSteps: { control: [control], opensip: [opensip] },
        recoverySteps: { control: [], opensip: [opensip] },
      },
      strategies: {
        control: { arm: 'control', steps: [control], version: 'v1' },
        opensip: { arm: 'opensip', steps: [opensip], version: 'v1' },
      },
    };

    expect(task.strategies.opensip.steps).toHaveLength(1);
    expect(task.staleness?.edit.operations[0]?.kind).toBe('delete');
    expectTypeOf<ToolInvoker>().toBeFunction();
  });

  it.each<readonly [EditOperation, string]>([
    [{ content: 'next', kind: 'append', path: 'a.ts' }, 'append:a.ts:next'],
    [{ kind: 'delete', path: 'b.ts' }, 'delete:b.ts'],
    [{ content: 'replacement', kind: 'write', path: 'c.ts' }, 'write:c.ts:replacement'],
  ])('keeps edit operations discriminated', (operation, expected) => {
    const describeEdit = (edit: EditOperation): string => {
      switch (edit.kind) {
        case 'append': {
          return `${edit.kind}:${edit.path}:${edit.content}`;
        }
        case 'delete': {
          return `${edit.kind}:${edit.path}`;
        }
        case 'write': {
          return `${edit.kind}:${edit.path}:${edit.content}`;
        }
      }
    };

    expect(describeEdit(operation)).toBe(expected);
  });
});

describe('fact matching', () => {
  it.each<readonly [AnswerFactPattern, AnswerFact]>([
    [
      { command: 'pnpm test', kind: 'command', purpose: 'test' },
      { command: 'pnpm test', kind: 'command', purpose: 'test' },
    ],
    [
      { kind: 'count', label: 'packages', maximum: 6, minimum: 4, value: 5 },
      { kind: 'count', label: 'packages', value: 5 },
    ],
    [
      {
        confidence: 'high',
        evidenceKind: 'call',
        filePath: 'a.ts',
        kind: 'evidence',
        resolution: 'exact',
        subject: 'run',
      },
      {
        confidence: 'high',
        evidenceKind: 'call',
        filePath: 'a.ts',
        kind: 'evidence',
        resolution: 'exact',
        subject: 'run',
      },
    ],
    [
      {
        column: 1,
        declarationId: 'declaration:RunScope',
        declarationKind: 'class',
        filePath: 'scope.ts',
        kind: 'declaration-handle',
        line: 2,
        name: 'RunScope',
        package: '@example/core',
      },
      {
        column: 1,
        declarationId: 'declaration:RunScope',
        declarationKind: 'class',
        filePath: 'scope.ts',
        kind: 'declaration-handle',
        line: 2,
        name: 'RunScope',
        package: '@example/core',
      },
    ],
    [
      { kind: 'file', path: 'a.ts', role: 'source' },
      { kind: 'file', path: 'a.ts', role: 'source' },
    ],
    [
      {
        catalogIdentity: 'g1:one',
        fresh: true,
        kind: 'freshness',
        reasonCode: 'loaded',
        verification: 'complete',
      },
      {
        catalogIdentity: 'g1:one',
        fresh: true,
        kind: 'freshness',
        reasonCode: 'loaded',
        verification: 'complete',
      },
    ],
    [
      { kind: 'package', name: '@example/a' },
      { kind: 'package', name: '@example/a' },
    ],
    [
      {
        filePath: 'a.ts',
        kind: 'symbol',
        line: 3,
        name: 'run',
        package: '@example/a',
      },
      {
        filePath: 'a.ts',
        kind: 'symbol',
        line: 3,
        name: 'run',
        package: '@example/a',
      },
    ],
    [
      {
        bodyHash: 'body:1',
        column: 2,
        filePath: 'a.ts',
        inTestFile: false,
        kind: 'symbol-handle',
        line: 3,
        name: 'run',
        package: '@example/a',
        qualifiedName: 'example.run',
        symbolId: 'symbol:run',
      },
      {
        bodyHash: 'body:1',
        column: 2,
        filePath: 'a.ts',
        inTestFile: false,
        kind: 'symbol-handle',
        line: 3,
        name: 'run',
        package: '@example/a',
        qualifiedName: 'example.run',
        symbolId: 'symbol:run',
      },
    ],
    [
      { kind: 'text', label: 'package-manager', value: 'pnpm' },
      { kind: 'text', label: 'package-manager', value: 'pnpm' },
    ],
  ])('matches stable fields for %s', (pattern, fact) => {
    expect(factMatches(pattern, fact)).toBe(true);
  });

  it('rejects wrong kinds, values, and count ranges', () => {
    expect(factMatches({ kind: 'file', path: 'a.ts' }, { kind: 'package', name: 'a.ts' })).toBe(
      false,
    );
    expect(factMatches({ kind: 'package', name: 'a' }, { kind: 'package', name: 'b' })).toBe(false);
    expect(
      factMatches({ kind: 'count', minimum: 6 }, { kind: 'count', label: 'p', value: 5 }),
    ).toBe(false);
    expect(
      factMatches({ kind: 'count', maximum: 4 }, { kind: 'count', label: 'p', value: 5 }),
    ).toBe(false);
    expect(factMatches({ kind: 'symbol' }, { kind: 'symbol', name: 'anything' })).toBe(true);
  });
});

describe('response-dependent argument resolution', () => {
  it('resolves nested arguments only from prior normalized facts', () => {
    const result = resolveStepArguments(
      baseStep({
        options: {
          ids: [
            {
              $fact: {
                field: 'symbolId',
                match: { kind: 'symbol-handle', name: 'run' },
                stepId: 'find-run',
              },
            },
          ],
        },
      }),
      observations,
    );

    expect(result).toMatchObject({
      ok: true,
      step: { arguments: { options: { ids: ['symbol:run'] } } },
    });
  });

  it('binds declaration ids without treating them as callable symbol ids', () => {
    const declarationObservations: readonly FactObservation[] = [
      {
        fact: {
          declarationId: 'declaration:RunScope',
          kind: 'declaration-handle',
          name: 'RunScope',
        },
        leg: 'main',
        ordinal: 0,
        stepId: 'find-declaration',
      },
    ];
    const result = resolveStepArguments(
      baseStep({
        declarationId: {
          $fact: {
            field: 'declarationId',
            match: { kind: 'declaration-handle', name: 'RunScope' },
            stepId: 'find-declaration',
          },
        },
      }),
      declarationObservations,
    );

    expect(result).toMatchObject({
      ok: true,
      step: { arguments: { declarationId: 'declaration:RunScope' } },
    });
  });

  it('supports deterministic first and last selection', () => {
    const repeated: readonly FactObservation[] = [
      ...observations,
      {
        ...observations[0],
        fact: {
          kind: 'symbol-handle',
          name: 'run',
          symbolId: 'symbol:new-run',
        },
        ordinal: 1,
      },
    ];
    const result = resolveStepArguments(
      baseStep({
        first: {
          $fact: {
            field: 'symbolId',
            match: { kind: 'symbol-handle', name: 'run' },
            select: 'first',
          },
        },
        last: {
          $fact: {
            field: 'symbolId',
            match: { kind: 'symbol-handle', name: 'run' },
            select: 'last',
          },
        },
      }),
      repeated,
    );

    expect(result).toMatchObject({
      ok: true,
      step: { arguments: { first: 'symbol:run', last: 'symbol:new-run' } },
    });
  });

  it('reports missing, ambiguous, invalid, and over-limit bindings', () => {
    const binding = (field: 'path' | 'symbolId', name = 'run') => ({
      $fact: { field, match: { kind: 'symbol-handle' as const, name } },
    });
    expect(
      resolveStepArguments(baseStep({ id: binding('symbolId', 'missing') }), observations),
    ).toMatchObject({
      failure: { code: 'missing-binding', path: 'arguments.id' },
      ok: false,
    });
    expect(
      resolveStepArguments(baseStep({ id: binding('symbolId') }), [
        ...observations,
        { ...observations[0], ordinal: 1 },
      ]),
    ).toMatchObject({ failure: { code: 'ambiguous-binding' }, ok: false });
    expect(resolveStepArguments(baseStep({ id: binding('path') }), observations)).toMatchObject({
      failure: { code: 'invalid-field' },
      ok: false,
    });
    expect(
      resolveStepArguments(
        baseStep({ first: binding('symbolId'), second: binding('symbolId') }),
        observations,
        1,
      ),
    ).toMatchObject({
      failure: { code: 'binding-limit', path: 'arguments.second' },
      ok: false,
    });
    expect(
      resolveStepArguments(
        baseStep({
          many: Array.from({ length: 33 }, () => binding('symbolId')),
        }),
        observations,
        100,
      ),
    ).toMatchObject({
      failure: { code: 'binding-limit', path: 'arguments.many[32]' },
      ok: false,
    });
    expect(
      resolveStepArguments(
        baseStep({ id: binding('symbolId') }),
        Array.from({ length: MAX_ARGUMENT_OBSERVATIONS + 1 }, (_, ordinal) => ({
          ...observations[0],
          ordinal,
        })),
      ),
    ).toMatchObject({
      failure: { code: 'observation-limit', path: 'arguments.id' },
      ok: false,
    });
  });

  it('passes literal arguments through without observations', () => {
    expect(resolveStepArguments(baseStep({ limit: 20, query: 'run' }), [])).toMatchObject({
      ok: true,
      step: { arguments: { limit: 20, query: 'run' } },
    });
  });
});

describe('step records', () => {
  const common = {
    leg: 'main' as const,
    step: {
      arguments: { query: 'run' },
      expectedNonEmpty: true,
      extract: extractNothing,
      id: 'find-run',
      rationale: 'Find the declaration.',
      tool: 'search_symbols',
    },
    wallMs: 8,
  };

  it('counts UTF-8 bytes once and never retains the rendered response', () => {
    const record = makeStepRecord({
      ...common,
      completeness: 'complete',
      facts: [{ kind: 'symbol', name: 'run' }],
      renderedResponse: 'λ',
    });

    expect(record).toMatchObject({
      argumentSummary: { query: 'run' },
      completeness: 'complete',
      facts: [{ kind: 'symbol', name: 'run' }],
      noneOutcome: 'nonempty',
      responseBytes: 2,
    });
    expect(record).not.toHaveProperty('renderedResponse');
  });

  it('keeps bounded MCP handshake evidence in setup provenance', () => {
    const setup: SetupRecord = {
      mcp: {
        handshakeDurationMs: 24,
        mutationPosture: 'read-only',
        projectRootVerified: true,
        projectScope: 'project',
        stderr: { bytes: 128, truncated: true },
        surfaceEpoch: 4,
        surfaceVerified: true,
        toolCount: 3,
        toolNames: ['get_agent_catalog', 'search_symbols', 'who_calls'],
        version: '0.6.0',
      },
      mode: 'fixture',
      stages: [{ durationMs: 100, exitCode: 0, name: 'mcp-handshake' }],
    };

    expect(setup.mcp).toMatchObject({
      stderr: { bytes: 128, truncated: true },
      surfaceVerified: true,
      toolCount: 3,
    });
    expect(setup.mcp?.stderr).not.toHaveProperty('text');
  });

  it('distinguishes trustworthy none, incomplete none, and failure', () => {
    expect(
      makeStepRecord({
        ...common,
        completeness: 'complete',
        renderedResponse: '',
      }).noneOutcome,
    ).toBe('empty-complete');
    expect(
      makeStepRecord({
        ...common,
        completeness: 'unknown',
        renderedResponse: '',
      }).noneOutcome,
    ).toBe('empty-incomplete');
    expect(
      makeStepRecord({
        ...common,
        failure: {
          code: 'mcp-request-timeout',
          kind: 'infrastructure',
          message: 'timed out',
        },
        renderedResponse: '',
      }).noneOutcome,
    ).toBe('failed');
  });

  it('derives completeness and truncation from coverage', () => {
    const complete = makeStepRecord({
      ...common,
      coverage: { complete: true, truncated: false },
      renderedResponse: '[]',
    });
    const truncated = makeStepRecord({
      ...common,
      completeness: 'complete',
      coverage: {
        complete: false,
        hardCapReasons: ['sample-cap'],
        truncated: true,
      },
      renderedResponse: '[]',
    });
    const incompleteCoverage = makeStepRecord({
      ...common,
      completeness: 'complete',
      coverage: { complete: false, truncated: false },
      renderedResponse: '[]',
    });

    expect(complete.completeness).toBe('complete');
    expect(truncated).toMatchObject({
      completeness: 'incomplete',
      noneOutcome: 'empty-incomplete',
      truncated: true,
    });
    expect(incompleteCoverage).toMatchObject({
      completeness: 'incomplete',
      noneOutcome: 'empty-incomplete',
    });
  });
});
