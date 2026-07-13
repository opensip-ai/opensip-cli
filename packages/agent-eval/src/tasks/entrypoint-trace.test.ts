import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createNativeInvoker } from '../adapters/native-tools.js';
import { customerTsGroundTruth } from '../ground-truth/customer-ts.js';
import { factMatches, resolveStepArguments } from '../model/argument-resolution.js';
import {
  type FactBinding,
  type FactObservation,
  type GoldTask,
  type StrategyStep,
} from '../model/task.js';
import { executeArm } from '../runner/execute-arm.js';

import { entrypointTraceCustomerTsTask, entrypointTraceTasks } from './entrypoint-trace.js';

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../__fixtures__/customer-ts',
);

function step(task: GoldTask, arm: 'control' | 'opensip', id: string): StrategyStep {
  const found = task.strategies[arm].steps.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Missing ${arm} step ${id}`);
  return found;
}

describe('entrypoint-trace gold task', () => {
  it('pins the entry and implementation assertions to typed ground truth', () => {
    const { entrypoint } = customerTsGroundTruth;
    const assertions = entrypointTraceCustomerTsTask.assertions.mustInclude ?? [];

    expect(assertions).toContainEqual({
      filePath: entrypoint.entryFile,
      kind: 'symbol',
      name: entrypoint.entrySymbol,
    });
    expect(assertions).toContainEqual({
      filePath: entrypoint.implementationFile,
      kind: 'symbol',
      name: entrypoint.implementationSymbol,
    });
    expect(assertions).toContainEqual({
      kind: 'evidence',
      subject: `terminal:${entrypoint.implementationSymbol}`,
    });
  });

  it('runs the manual strategy through both re-export barrels to the implementation', async () => {
    const task = entrypointTraceCustomerTsTask;
    const leg = await executeArm({
      assertions: {
        leg: 'main',
        mustInclude: task.assertions.mustInclude,
      },
      invoker: createNativeInvoker(fixtureRoot),
      steps: task.strategies.control.steps,
    });
    const facts = leg.steps.flatMap(({ facts: stepFacts }) => stepFacts);

    for (const expectation of task.assertions.mustInclude ?? []) {
      expect(facts.some((fact) => factMatches(expectation, fact))).toBe(true);
    }
    expect(leg.steps.map(({ stepId }) => stepId)).toEqual([
      'control-read-entry',
      'control-read-hop-1',
      'control-read-hop-2',
      'control-read-hop-3',
      'control-read-implementation',
    ]);
    expect(leg.steps.every(({ failure }) => failure === undefined)).toBe(true);
  });

  it('resolves MCP arguments only from prior symbol-handle facts', () => {
    const resolveEntry = step(entrypointTraceCustomerTsTask, 'opensip', 'opensip-resolve-entry');
    const missing = resolveStepArguments(resolveEntry, []);
    expect(missing).toMatchObject({
      failure: { code: 'missing-binding' },
      ok: false,
    });

    const observations: readonly FactObservation[] = [
      {
        fact: {
          bodyHash: 'body:alternative',
          filePath: 'src/index.ts',
          kind: 'symbol-handle',
          line: 17,
          name: 'main',
          symbolId: 'src/index.ts:17:2',
        },
        leg: 'main',
        ordinal: 0,
        stepId: 'opensip-find-entry',
      },
    ];
    const resolved = resolveStepArguments(resolveEntry, observations);

    expect(resolved).toMatchObject({
      ok: true,
      step: { arguments: { file: 'src/index.ts', line: 17 } },
    });
  });

  it('normalizes only symbol rows passed to the MCP search extractor', () => {
    const extract = step(entrypointTraceCustomerTsTask, 'opensip', 'opensip-find-entry').extract;
    const facts = extract({
      data: {
        symbols: [
          {
            bodyHash: 'body:alternative',
            column: 4,
            filePath: 'src/alternative.ts',
            inTestFile: false,
            line: 9,
            package: '@alternative/project',
            qualifiedName: 'alternativeEntry',
            simpleName: 'alternativeEntry',
            symbolId: 'src/alternative.ts:9:4',
          },
        ],
      },
    });

    expect(facts).toContainEqual(
      expect.objectContaining({
        kind: 'symbol-handle',
        name: 'alternativeEntry',
        symbolId: 'src/alternative.ts:9:4',
      }),
    );
    expect(facts).not.toContainEqual(
      expect.objectContaining({
        name: customerTsGroundTruth.entrypoint.implementationSymbol,
      }),
    );
  });

  it('derives manual import targets from passed source bytes rather than fixture truth', () => {
    const extract = step(entrypointTraceCustomerTsTask, 'control', 'control-read-entry').extract;
    const facts = extract({
      content: [
        "import { alternateFeature } from './features/alternate/index.js';",
        'export function alternateMain(): number { return alternateFeature(); }',
      ].join('\n'),
      path: 'src/alternate-entry.ts',
      truncated: false,
    });

    expect(facts).toContainEqual({
      kind: 'file',
      path: 'src/features/alternate/index.ts',
      role: 'imports:alternateFeature',
    });
    expect(facts).toContainEqual({
      kind: 'file',
      path: 'src/features/alternate/index.ts',
      role: 'called-import',
    });
    expect(facts).toContainEqual({
      filePath: 'src/alternate-entry.ts',
      kind: 'symbol',
      name: 'alternateMain',
    });
    expect(facts).not.toContainEqual(
      expect.objectContaining({
        name: customerTsGroundTruth.entrypoint.entrySymbol,
      }),
    );
  });

  it('discloses only the public anchor and derives every intermediate selector from responses', () => {
    const task = entrypointTraceCustomerTsTask;
    const question = task.question;
    const entrypoint = customerTsGroundTruth.entrypoint;
    for (const disclosed of [entrypoint.entryFile, entrypoint.entrySymbol, 'submitInvoice']) {
      expect(question).toContain(disclosed);
    }
    expect(question).not.toContain(entrypoint.implementationFile);
    expect(question).not.toContain(entrypoint.implementationSymbol);
    expect(question).not.toContain('runInvoiceWorkflow');
    expect(question).not.toContain('priceInvoice');

    const roleSelectors = task.strategies.control.steps.flatMap(({ arguments: args }) => {
      const path = args.path;
      const binding =
        typeof path === 'object' && path !== null && '$fact' in path
          ? (path as FactBinding)
          : undefined;
      const match = binding?.$fact.match;
      const role = match?.kind === 'file' ? match.role : undefined;
      return typeof role === 'string' ? [role] : [];
    });
    expect(roleSelectors).not.toHaveLength(0);
    expect(new Set(roleSelectors)).toEqual(new Set(['called-import']));

    const trace = step(task, 'opensip', 'opensip-trace-entry-to-implementation');
    const terminal = (trace.arguments.toSymbolId as FactBinding).$fact.match;
    expect(terminal.kind).toBe('symbol-handle');
    if (terminal.kind !== 'symbol-handle') throw new Error('Expected a symbol-handle terminal.');
    expect(terminal.name).toBeUndefined();
    expect(terminal.filePath).toBeUndefined();
    expect((trace.arguments.toSymbolId as FactBinding).$fact.stepId).toBe('opensip-follow-hop-4');

    const hops = task.strategies.opensip.steps.filter(({ id }) =>
      id.startsWith('opensip-follow-hop-'),
    );
    expect(hops).toHaveLength(4);
    for (const hop of hops) {
      const binding = hop.arguments.symbolId as FactBinding;
      expect(binding.$fact.match).toEqual({ kind: 'symbol-handle' });
      expect(binding.$fact.select).toBe('only');
    }
  });

  it('freezes exported data and keeps catalog setup out of measured steps', () => {
    expect(entrypointTraceTasks).toHaveLength(1);
    expect(Object.isFrozen(entrypointTraceCustomerTsTask)).toBe(true);
    expect(Object.isFrozen(entrypointTraceCustomerTsTask.strategies)).toBe(true);
    expect(Object.isFrozen(entrypointTraceCustomerTsTask.strategies.opensip.steps)).toBe(true);
    expect(entrypointTraceCustomerTsTask.strategies.opensip.version).toContain('epoch-4');
    expect(
      Object.values(entrypointTraceCustomerTsTask.strategies).flatMap(({ steps }) =>
        steps.map(({ tool }) => tool),
      ),
    ).not.toContain('get_agent_catalog');
    expect(
      entrypointTraceCustomerTsTask.strategies.opensip.steps.every(
        ({ expectedNonEmpty }) => expectedNonEmpty === true,
      ),
    ).toBe(true);
  });
});
