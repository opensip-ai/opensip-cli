import { describe, expect, it, vi } from 'vitest';

import { makeStepRecord, type ToolInvoker } from '../model/record.js';

import { executeArm } from './execute-arm.js';

import type { AnswerFact, ResolvedStrategyStep, StrategyStep } from '../model/task.js';

const extractNothing = (): readonly AnswerFact[] => [];

function strategyStep(id: string, overrides: Partial<StrategyStep> = {}): StrategyStep {
  return {
    arguments: {},
    extract: extractNothing,
    id,
    rationale: `Run ${id}.`,
    tool: 'search',
    ...overrides,
  };
}

function successfulRecord(step: ResolvedStrategyStep, facts: readonly AnswerFact[]) {
  return makeStepRecord({
    completeness: 'complete',
    facts,
    leg: step.leg ?? 'main',
    renderedResponse: JSON.stringify(facts),
    step,
    wallMs: 2,
  });
}

function factInvoker(factsByStep: Readonly<Record<string, readonly AnswerFact[]>>) {
  return vi.fn<ToolInvoker>((step) =>
    Promise.resolve(successfulRecord(step, factsByStep[step.id] ?? [])),
  );
}

describe('executeArm', () => {
  it("stops as soon as the leg's assertions can be answered", async () => {
    const invoker = factInvoker({
      discover: [{ kind: 'package', name: '@example/core' }],
    });

    const result = await executeArm({
      assertions: {
        leg: 'main',
        mustInclude: [{ kind: 'package', name: '@example/core' }],
      },
      invoker,
      steps: [strategyStep('discover'), strategyStep('unneeded')],
    });

    expect(result.steps.map((step) => step.stepId)).toEqual(['discover']);
    expect(invoker).toHaveBeenCalledTimes(1);
  });

  it('resolves response-derived arguments from prior normalized facts', async () => {
    const invokedSteps: ResolvedStrategyStep[] = [];
    const invoker: ToolInvoker = (step) => {
      invokedSteps.push(step);
      const facts: readonly AnswerFact[] =
        step.id === 'lookup'
          ? [
              {
                filePath: 'src/run.ts',
                kind: 'symbol-handle',
                name: 'run',
                symbolId: 'symbol:run',
              },
            ]
          : [{ kind: 'file', path: 'src/caller.ts', role: 'caller' }];
      return Promise.resolve(successfulRecord(step, facts));
    };
    const follow = strategyStep('callers', {
      arguments: {
        symbolId: {
          $fact: {
            field: 'symbolId',
            match: { kind: 'symbol-handle', name: 'run' },
            select: 'only',
            stepId: 'lookup',
          },
        },
      },
      tool: 'who_calls',
    });

    const result = await executeArm({
      assertions: {
        leg: 'main',
        mustInclude: [{ kind: 'file', path: 'src/caller.ts' }],
      },
      invoker,
      steps: [strategyStep('lookup'), follow],
    });

    expect(invokedSteps[1]?.arguments).toEqual({ symbolId: 'symbol:run' });
    expect(result.steps[1]?.argumentSummary).toEqual({
      symbolId: 'symbol:run',
    });
  });

  it.each([
    {
      code: 'missing-binding',
      expectedMessage: 'No observed fact matched symbol-handle.',
      facts: [] as readonly AnswerFact[],
      title: 'missing',
    },
    {
      code: 'ambiguous-binding',
      expectedMessage: '2 observed facts matched symbol-handle.',
      facts: [
        { kind: 'symbol-handle', symbolId: 'symbol:first' },
        { kind: 'symbol-handle', symbolId: 'symbol:second' },
      ] as readonly AnswerFact[],
      title: 'ambiguous',
    },
  ])(
    'records a $title binding failure without invoking its tool',
    async ({ code, expectedMessage, facts }) => {
      const invoker = factInvoker({ lookup: facts });
      const bound = strategyStep('callers', {
        arguments: {
          symbolId: {
            $fact: {
              field: 'symbolId',
              match: { kind: 'symbol-handle' },
            },
          },
        },
        tool: 'who_calls',
      });

      const result = await executeArm({
        assertions: {
          leg: 'main',
          mustInclude: [{ kind: 'file', path: 'never.ts' }],
        },
        invoker,
        steps: [strategyStep('lookup'), bound],
      });

      expect(invoker).toHaveBeenCalledTimes(1);
      expect(result.steps[1]).toMatchObject({
        argumentSummary: {},
        failure: { code, kind: 'binding', message: expectedMessage },
        noneOutcome: 'failed',
        responseBytes: 0,
        stepId: 'callers',
        tool: 'who_calls',
      });
    },
  );

  it('creates an independent answer state for every invocation', async () => {
    const produce = factInvoker({
      lookup: [{ kind: 'symbol-handle', symbolId: 'symbol:run' }],
    });
    const first = await executeArm({
      assertions: {
        leg: 'main',
        mustInclude: [{ kind: 'symbol-handle', symbolId: 'symbol:run' }],
      },
      invoker: produce,
      steps: [strategyStep('lookup')],
    });

    const consume = factInvoker({});
    const second = await executeArm({
      assertions: {
        leg: 'main',
        mustInclude: [{ kind: 'file', path: 'caller.ts' }],
      },
      invoker: consume,
      steps: [
        strategyStep('callers', {
          arguments: {
            symbolId: {
              $fact: {
                field: 'symbolId',
                match: { kind: 'symbol-handle' },
              },
            },
          },
        }),
      ],
    });

    expect(first.steps[0]?.facts).toEqual([{ kind: 'symbol-handle', symbolId: 'symbol:run' }]);
    expect(consume).not.toHaveBeenCalled();
    expect(second.steps[0]?.failure?.code).toBe('missing-binding');
  });

  it('stamps the requested leg and rejects cross-leg execution', async () => {
    const invoker = factInvoker({
      verify: [{ kind: 'freshness', fresh: true }],
    });
    const postEdit = await executeArm({
      assertions: {
        leg: 'post-edit',
        mustInclude: [{ fresh: true, kind: 'freshness' }],
      },
      invoker,
      steps: [strategyStep('verify')],
    });

    expect(postEdit.leg).toBe('post-edit');
    expect(postEdit.steps[0]?.leg).toBe('post-edit');
    expect(invoker.mock.calls[0]?.[0].leg).toBe('post-edit');

    await expect(
      executeArm({
        assertions: { leg: 'post-edit' },
        invoker,
        leg: 'post-edit',
        steps: [strategyStep('wrong-leg', { leg: 'pre-edit' })],
      }),
    ).rejects.toThrow('Cannot execute pre-edit step wrong-leg in the post-edit leg.');
  });

  it('uses facts already extracted into records and preserves provenance for bindings', async () => {
    const seen: ResolvedStrategyStep[] = [];
    function factsForStep(stepId: string): readonly AnswerFact[] {
      if (stepId === 'first') {
        return [{ kind: 'text', label: 'target', value: 'first-value' }];
      }
      if (stepId === 'second') {
        return [{ kind: 'text', label: 'target', value: 'second-value' }];
      }
      return [{ kind: 'file', path: 'done.ts' }];
    }
    const invoker: ToolInvoker = (step) => {
      seen.push(step);
      return Promise.resolve(successfulRecord(step, factsForStep(step.id)));
    };
    const binding = {
      $fact: {
        field: 'value' as const,
        match: { kind: 'text' as const, label: 'target' },
        select: 'only' as const,
        stepId: 'second',
      },
    };

    await executeArm({
      assertions: {
        leg: 'recovery',
        mustInclude: [{ kind: 'file', path: 'done.ts' }],
      },
      invoker,
      leg: 'recovery',
      steps: [
        strategyStep('first'),
        strategyStep('second'),
        strategyStep('third', { arguments: { query: binding } }),
      ],
    });

    expect(seen[2]?.arguments).toEqual({ query: 'second-value' });
    expect(seen.every((step) => step.leg === 'recovery')).toBe(true);
  });
});
