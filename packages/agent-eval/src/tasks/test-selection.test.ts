import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createNativeInvoker } from '../adapters/native-tools.js';
import { customerPyGroundTruth } from '../ground-truth/customer-py.js';
import { customerTsGroundTruth } from '../ground-truth/customer-ts.js';
import { factMatches } from '../model/argument-resolution.js';
import { makeStepRecord } from '../model/record.js';
import { executeArm } from '../runner/execute-arm.js';
import { evaluateAssertions } from '../scorer/assertions.js';

import { testSelectionTasks } from './test-selection.js';

import type { ArmRunRecord } from '../model/record.js';
import type { FactBinding, GoldTask, StrategyStep } from '../model/task.js';

const FIXTURES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../__fixtures__');
const GRAPH_IDENTITY = `g1:${'a'.repeat(64)}`;
const INVENTORY_IDENTITY = `i1:${'b'.repeat(64)}`;
const SELECTION_IDENTITY = `ts1:${'c'.repeat(64)}`;

function task(id: string): GoldTask {
  const result = testSelectionTasks.find((candidate) => candidate.id === id);
  if (result === undefined) throw new Error(`Missing test-selection task ${id}.`);
  return result;
}

function stepByTool(taskValue: GoldTask, arm: 'control' | 'opensip', tool: string): StrategyStep {
  const result = taskValue.strategies[arm].steps.find((step) => step.tool === tool);
  if (result === undefined) throw new Error(`Missing ${tool} step on ${taskValue.id}.`);
  return result;
}

function factBinding(value: unknown): FactBinding {
  if (typeof value !== 'object' || value === null || !('$fact' in value)) {
    throw new TypeError('Expected a declarative fact binding.');
  }
  return value as FactBinding;
}

function selectionData(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    commands: [],
    files: [customerTsGroundTruth.testMappings[0].targetFile],
    graphIdentity: GRAPH_IDENTITY,
    inventoryIdentity: INVENTORY_IDENTITY,
    schemaVersion: 1,
    snapshotId: SELECTION_IDENTITY,
    tests: [
      {
        basis: 'direct-call',
        confidence: 'high',
        observed: false,
        path: customerTsGroundTruth.testMappings[0].testFiles[0],
        proof: [`${customerTsGroundTruth.testMappings[0].targetFile}:1:0`],
      },
    ],
    trust: { fallbackTier: 'full', reasonCodes: [], status: 'complete' },
    uncoveredFiles: [],
    ...overrides,
  };
}

function selectionPayload(
  overrides: Readonly<Record<string, unknown>> = {},
  graphIdentity = GRAPH_IDENTITY,
) {
  return {
    context: { catalog: { identity: graphIdentity, status: 'loaded' } },
    data: selectionData(overrides),
  };
}

describe('test-selection gold tasks', () => {
  it('freezes the TypeScript and Python epoch-7 OpenSIP strategies', () => {
    expect(testSelectionTasks.map(({ id }) => id)).toEqual([
      'test-selection.customer-ts',
      'test-selection.customer-py',
    ]);
    expect(Object.isFrozen(testSelectionTasks)).toBe(true);
    for (const taskValue of testSelectionTasks) {
      expect(Object.isFrozen(taskValue)).toBe(true);
      expect(Object.isFrozen(taskValue.assertions)).toBe(true);
      expect(Object.isFrozen(taskValue.strategies.opensip.steps)).toBe(true);
      expect(taskValue.strategies.control.version).toBe('control-native-v4-lexical-proof-closure');
      expect(taskValue.strategies.opensip.version).toContain('epoch-7');
    }
  });

  it('pins all mapped tests and the manifest-backed fallback commands', () => {
    for (const truth of [customerTsGroundTruth, customerPyGroundTruth] as const) {
      const mapping = truth.testMappings[0];
      const assertions = task(`test-selection.${truth.fixture}`).assertions.mustInclude ?? [];
      for (const path of mapping.testFiles) {
        expect(assertions).toContainEqual({ kind: 'file', path, role: 'test' });
      }
      expect(assertions).toContainEqual({
        command: mapping.fallbackCommand,
        kind: 'command',
      });
    }

    const tsAssertions = task('test-selection.customer-ts').assertions;
    expect(tsAssertions.mustExclude).toContainEqual({
      kind: 'file',
      path: 'test/health.spec.ts',
      role: 'test',
    });
    expect(tsAssertions.mustExclude).toContainEqual({
      command: 'npx mocha "test/**/*.spec.ts"',
      kind: 'command',
      purpose: 'test-script',
    });
    expect(tsAssertions.mustExclude).not.toContainEqual({
      command: 'npm test',
      kind: 'command',
    });
  });

  it('follows bounded response-derived caller frontiers before reading the manifest', () => {
    const control = task('test-selection.customer-ts').strategies.control.steps;
    const searches = control.filter(({ tool }) => tool === 'contentSearch');
    expect(searches).toHaveLength(5);
    expect(searches[0]?.arguments).toMatchObject({
      contextLines: 40,
      pattern: '\\bcalculateInvoice\\b',
    });
    for (const [index, search] of searches.slice(1).entries()) {
      expect(search.arguments.contextLines).toBe(40);
      expect(factBinding(search.arguments.pattern).$fact).toEqual({
        field: 'value',
        match: { kind: 'text', label: 'caller-frontier-pattern' },
        select: 'only',
        stepId:
          index === 0
            ? 'test-selection.customer-ts.control.target-references'
            : `test-selection.customer-ts.control.caller-frontier-${String(index)}`,
      });
    }
    expect(searches.every(({ arguments: args }) => args.glob === undefined)).toBe(true);
    expect(searches.at(-1)?.provesAbsence).toContainEqual({
      kind: 'file',
      path: 'test/health.spec.ts',
      role: 'test',
    });
    expect(control.map(({ tool }) => tool)).not.toContain('globList');
    expect(control[0]).toMatchObject({
      arguments: { path: 'package.json' },
      tool: 'readFile',
    });

    const fallback = control.find(({ tool }) => tool === 'readFile');
    const facts = fallback?.extract({
      content: JSON.stringify({
        packageManager: 'pnpm@11.10.0',
        scripts: { test: 'vitest run' },
      }),
      path: 'package.json',
      truncated: false,
    });
    expect(facts).toContainEqual({
      command: 'pnpm test',
      kind: 'command',
      purpose: 'fallback',
    });
    expect(facts).toContainEqual({
      command: 'vitest run',
      kind: 'command',
      purpose: 'test-script',
    });
    expect(facts).not.toContainEqual(
      expect.objectContaining({ command: expect.stringContaining('mocha') }),
    );
    expect(
      fallback?.assessProofClosure?.({
        content: '{invalid-json',
        path: 'package.json',
        truncated: false,
      }),
    ).toEqual({
      domainExhausted: false,
      projectionComplete: false,
      reasonCodes: ['malformed-json-manifest-projection'],
    });
    expect(
      fallback?.assessProofClosure?.({
        content: JSON.stringify({ scripts: { test: 42 } }),
        path: 'package.json',
        truncated: false,
      }),
    ).toMatchObject({ domainExhausted: false, projectionComplete: false });
  });

  it('derives the Python fallback from pyproject metadata rather than task truth', () => {
    const fallback = stepByTool(task('test-selection.customer-py'), 'control', 'readFile');
    expect(
      fallback?.extract({
        content: "[project]\nname='x'\n",
        path: 'pyproject.toml',
      }),
    ).toEqual([]);
    expect(
      fallback?.extract({
        content: "[project]\nname='x'\n\n[tool.pytest.ini_options]\ntestpaths=['tests']\n",
        path: 'pyproject.toml',
      }),
    ).toEqual([{ command: 'pytest', kind: 'command', purpose: 'fallback' }]);
  });

  it('uses one bounded explicit-file select_tests request', () => {
    for (const taskValue of testSelectionTasks) {
      const selection = stepByTool(taskValue, 'opensip', 'select_tests');
      const mapping =
        taskValue.fixture === 'customer-ts'
          ? customerTsGroundTruth.testMappings[0]
          : customerPyGroundTruth.testMappings[0];
      expect(selection.arguments).toEqual({
        commandLimit: 100,
        depth: 5,
        files: [mapping.targetFile],
        limit: 500,
        proofDetail: 'paths',
        proofLimit: 6,
        tier: 'focused',
      });
    }
  });

  it('projects labelled static tests and safe fallback commands from select_tests', () => {
    const tsTask = task('test-selection.customer-ts');
    expect(tsTask.strategies.opensip.steps.map(({ tool }) => tool)).toEqual(['select_tests']);
    expect(JSON.stringify(tsTask.strategies.opensip.steps)).not.toContain('pnpm test');
    expect(
      JSON.stringify(task('test-selection.customer-py').strategies.opensip.steps),
    ).not.toContain('pytest');

    const selection = stepByTool(tsTask, 'opensip', 'select_tests');
    const facts = selection.extract({
      data: {
        commands: [
          {
            argv: ['pnpm', 'test'],
            basis: 'package-manager-script:test',
            cwd: '.',
            tier: 'full',
          },
          {
            argv: ['vitest', 'run'],
            basis: 'manifest-script:test',
            cwd: '.',
            tier: 'full',
          },
        ],
        tests: [
          {
            basis: 'direct-call',
            confidence: 'high',
            observed: false,
            path: 'test/invoice.spec.ts',
            proof: ['src/target.ts:1:0'],
          },
        ],
      },
    });

    expect(facts).toContainEqual({
      kind: 'file',
      path: 'test/invoice.spec.ts',
      role: 'test',
    });
    expect(facts).toContainEqual({
      command: 'pnpm test',
      kind: 'command',
      purpose: 'fallback',
    });
    expect(facts).toContainEqual({
      command: 'vitest run',
      kind: 'command',
      purpose: 'test-script',
    });
    expect(facts).not.toContainEqual(expect.objectContaining({ path: 'src/caller.ts' }));
  });

  it('returns empty facts for empty or malformed selection responses', () => {
    const selection = stepByTool(task('test-selection.customer-py'), 'opensip', 'select_tests');
    expect(selection.extract({ data: { commands: [], tests: [] } })).toEqual([]);
    expect(
      selection.extract({
        data: { commands: [{ argv: 42 }], tests: [{ path: 42 }] },
      }),
    ).toEqual([]);
    expect(selection.extract(null)).toEqual([]);
  });

  it.each([
    {
      context: 'const handlers = { invoice: calculateInvoice };',
      label: 'registry',
    },
    {
      context: 'const invoke = () => calculateInvoice(input);',
      label: 'arrow',
    },
    {
      context: `${Array.from({ length: 40 }, () => '  work();').join('\n')}\n  calculateInvoice(input);`,
      label: 'long-function',
    },
  ])('marks an unresolved $label reference projection incomplete', ({ context }) => {
    const firstSearch = task('test-selection.customer-ts').strategies.control.steps.find(({ id }) =>
      id.endsWith('.target-references'),
    );
    const assessment = firstSearch?.assessProofClosure?.({
      matches: [
        {
          context,
          contextStartLine: 1,
          line: context.split('\n').length,
          path: 'src/unresolved.ts',
          text: context.split('\n').at(-1) ?? '',
        },
      ],
      pattern: '\\bcalculateInvoice\\b',
    });

    expect(assessment).toEqual({
      domainExhausted: false,
      projectionComplete: false,
      reasonCodes: ['unresolved-native-reference'],
    });
  });

  it.each([
    {
      context: [
        'def g(values):',
        '    return sum(values)',
        '',
        'def unrelated(values):',
        '    return len(values)',
        '',
        "HANDLERS = {'ledger.total': g}",
        '',
        'def actual(values):',
        "    return HANDLERS['ledger.total'](values)",
      ].join('\n'),
      fixture: 'customer-py' as const,
      matchLine: 7,
      path: 'ledger/registry.py',
      pattern: '\\bg\\b',
    },
    {
      context: [
        'function calculateInvoice(): number { return 1; }',
        'function unrelated(): number { return 2; }',
        'const handlers = { invoice: calculateInvoice };',
        'function actual(): number { return handlers.invoice(); }',
      ].join('\n'),
      fixture: 'customer-ts' as const,
      matchLine: 3,
      path: 'src/registry.ts',
      pattern: '\\bcalculateInvoice\\b',
    },
  ])(
    'does not claim a closed caller frontier from a preceding sibling in $path',
    ({ context, fixture, matchLine, path, pattern }) => {
      const firstSearch = task(`test-selection.${fixture}`).strategies.control.steps.find(
        ({ id }) => id.endsWith('.target-references'),
      );
      expect(
        firstSearch?.assessProofClosure?.({
          matches: [
            {
              context,
              contextStartLine: 1,
              line: matchLine,
              path,
              text: context.split('\n')[matchLine - 1] ?? '',
            },
          ],
          pattern,
        }),
      ).toEqual({
        domainExhausted: false,
        projectionComplete: false,
        reasonCodes: ['unresolved-native-reference'],
      });
    },
  );

  it.each([
    {
      context:
        'function unrelated(): number { return calculateInvoice(); } const alias = calculateInvoice;',
      label: 'multiple same-line occurrences',
    },
    {
      context: 'const run = function internal(): number { return calculateInvoice(); };',
      label: 'named function expression',
    },
    {
      context: 'export default function internal(): number { return calculateInvoice(); }',
      label: 'default-exported named function',
    },
  ])('fails closed for $label', ({ context }) => {
    const firstSearch = task('test-selection.customer-ts').strategies.control.steps.find(({ id }) =>
      id.endsWith('.target-references'),
    );
    expect(
      firstSearch?.assessProofClosure?.({
        matches: [
          {
            context,
            contextStartLine: 1,
            line: 1,
            path: 'src/ambiguous.ts',
            text: context,
          },
        ],
        pattern: '\\bcalculateInvoice\\b',
      }),
    ).toEqual({
      domainExhausted: false,
      projectionComplete: false,
      reasonCodes: ['unresolved-native-reference'],
    });
  });

  it.each([
    {
      context: [
        'function unrelated(): number { return 1; }',
        'function actual(): number {',
        '  return calculateInvoice();',
        '}',
      ].join('\n'),
      fixture: 'customer-ts' as const,
      matchLine: 3,
      path: 'src/caller.ts',
      pattern: '\\bcalculateInvoice\\b',
    },
    {
      context: [
        'def unrelated(values):',
        '    return len(values)',
        '',
        'def actual(values):',
        '    return g(values)',
      ].join('\n'),
      fixture: 'customer-py' as const,
      matchLine: 5,
      path: 'ledger/caller.py',
      pattern: '\\bg\\b',
    },
  ])(
    'retains a lexically proven named caller in $path',
    ({ context, fixture, matchLine, path, pattern }) => {
      const firstSearch = task(`test-selection.${fixture}`).strategies.control.steps.find(
        ({ id }) => id.endsWith('.target-references'),
      );
      const payload = {
        matches: [
          {
            context,
            contextStartLine: 1,
            line: matchLine,
            path,
            text: context.split('\n')[matchLine - 1] ?? '',
          },
        ],
        pattern,
      };

      expect(firstSearch?.extract(payload)).toContainEqual({
        kind: 'text',
        label: 'caller-frontier-pattern',
        value: '(?:actual)',
      });
      expect(firstSearch?.assessProofClosure?.(payload)).toMatchObject({
        projectionComplete: true,
        reasonCodes: ['caller-frontier-open'],
      });
    },
  );

  it('requires semantic exhaustion for native TS and Python negative test proofs', async () => {
    for (const taskValue of testSelectionTasks) {
      const leg = await executeArm({
        assertions: {
          leg: 'main',
          mustExclude: taskValue.assertions.mustExclude,
          mustInclude: taskValue.assertions.mustInclude,
        },
        invoker: createNativeInvoker(resolve(FIXTURES_ROOT, taskValue.fixture)),
        steps: taskValue.strategies.control.steps,
      });
      const proofStep = leg.steps.find((candidate) =>
        candidate.absenceProofs.some((proof) => proof.kind === 'file' && proof.role === 'test'),
      );
      expect(proofStep).toBeDefined();
      if (taskValue.fixture === 'customer-ts') {
        expect(
          leg.steps.some((candidate) => candidate.proofClosure?.projectionComplete === false),
        ).toBe(true);
      } else {
        expect(proofStep?.proofClosure).toMatchObject({
          domainExhausted: false,
          reasonCodes: expect.arrayContaining(['caller-frontier-open']),
        });
        expect(proofStep?.facts).toContainEqual(
          expect.objectContaining({
            kind: 'text',
            label: 'caller-frontier-pattern',
          }),
        );
      }
    }
  });

  it('accepts negative proof only for a complete selection with no uncovered files', () => {
    const selection = stepByTool(task('test-selection.customer-ts'), 'opensip', 'select_tests');
    const closedPayload = selectionPayload();
    expect(selection.assessProofClosure?.(closedPayload)).toMatchObject({
      domainExhausted: true,
      projectionComplete: true,
    });
    expect(
      selection.assessProofClosure?.(
        selectionPayload({
          trust: {
            fallbackTier: 'full',
            reasonCodes: ['test-selection-depth-cap'],
            status: 'partial',
          },
          uncoveredFiles: [customerTsGroundTruth.testMappings[0].targetFile],
        }),
      ),
    ).toMatchObject({
      domainExhausted: false,
      projectionComplete: true,
      reasonCodes: ['test-selection-depth-cap'],
    });
  });

  it('binds complete selection proof to the exact request, catalog, identities, and unique rows', () => {
    const selection = stepByTool(task('test-selection.customer-ts'), 'opensip', 'select_tests');
    const selected = selectionData().tests as readonly unknown[];
    const command = {
      argv: ['pnpm', 'test'],
      basis: 'package-manager-script:test',
      cwd: '.',
      tier: 'full',
    };

    expect(selection.assessProofClosure?.(selectionPayload())).toEqual({
      domainExhausted: true,
      projectionComplete: true,
      reasonCodes: [],
    });
    for (const payload of [
      selectionPayload({ files: ['src/wrong.ts'] }),
      selectionPayload({}, `g1:${'d'.repeat(64)}`),
      selectionPayload({ tests: [...selected, ...selected] }),
      selectionPayload({ commands: [command, command] }),
      selectionPayload({ snapshotId: 'ts1:fixture' }),
      selectionPayload({ inventoryIdentity: 'i1:fixture' }),
      selectionPayload({ uncoveredFiles: ['src/not-requested.ts'] }),
    ]) {
      expect(selection.assessProofClosure?.(payload)).toEqual({
        domainExhausted: false,
        projectionComplete: false,
        reasonCodes: ['malformed-test-selection'],
      });
    }
  });

  it('proves the frozen stale manifest command absent from a complete response projection', async () => {
    const taskValue = task('test-selection.customer-ts');
    const selection = stepByTool(taskValue, 'opensip', 'select_tests');
    const mapping = customerTsGroundTruth.testMappings[0];
    const payload = selectionPayload({
      commands: [
        {
          argv: ['pnpm', 'test'],
          basis: 'package-manager-script:test',
          cwd: '.',
          tier: 'full',
        },
        {
          argv: ['vitest', 'run'],
          basis: 'manifest-script:test',
          cwd: '.',
          tier: 'full',
        },
      ],
      tests: mapping.testFiles.map((path) => ({
        basis: 'direct-call',
        confidence: 'high',
        observed: false,
        path,
        proof: [`${mapping.targetFile}:1:0`],
      })),
    });
    const leg = await executeArm({
      assertions: {
        leg: 'main',
        mustExclude: taskValue.assertions.mustExclude,
        mustInclude: taskValue.assertions.mustInclude,
      },
      invoker: (resolved) =>
        Promise.resolve(
          makeStepRecord({
            catalogIdentity: GRAPH_IDENTITY,
            coverage: {
              complete: true,
              facets: [
                {
                  complete: true,
                  name: 'inventory',
                  requested: true,
                  truncated: false,
                },
                {
                  complete: true,
                  name: 'evidence',
                  requested: true,
                  truncated: false,
                },
                {
                  complete: true,
                  name: 'grouping',
                  requested: false,
                  truncated: false,
                },
                {
                  complete: true,
                  name: 'projection',
                  requested: true,
                  truncated: false,
                },
              ],
              truncated: false,
            },
            facts: resolved.extract(payload),
            freshness: { fresh: true, verification: 'complete' },
            leg: 'main',
            proofClosure: resolved.assessProofClosure?.(payload),
            renderedResponse: JSON.stringify(payload),
            step: resolved,
            wallMs: 1,
          }),
        ),
      steps: [selection],
    });
    const record: ArmRunRecord = {
      arm: 'opensip',
      legs: [leg],
      setup: { mode: 'reuse-existing', stages: [] },
      strategyVersion: taskValue.strategies.opensip.version,
      taskId: taskValue.id,
    };

    expect(leg.steps[0]).toMatchObject({
      completeness: 'complete',
      noneOutcome: 'nonempty',
      proofClosure: { domainExhausted: true, projectionComplete: true },
    });
    expect(leg.steps[0]?.facts).toContainEqual({
      command: 'vitest run',
      kind: 'command',
      purpose: 'test-script',
    });
    expect(evaluateAssertions(record, taskValue.assertions)).toMatchObject({
      incorrectNone: 0,
      passed: true,
    });
  });

  it('fails closed when selection trust metadata is malformed', () => {
    const selection = stepByTool(task('test-selection.customer-ts'), 'opensip', 'select_tests');
    for (const data of [
      {},
      { trust: {}, uncoveredFiles: 42 },
      { trust: null, uncoveredFiles: [] },
    ]) {
      expect(
        selection.assessProofClosure?.({
          context: { catalog: { identity: GRAPH_IDENTITY, status: 'loaded' } },
          data,
        }),
      ).toMatchObject({
        domainExhausted: false,
        projectionComplete: false,
        reasonCodes: ['malformed-test-selection'],
      });
    }
  });

  it('fails closed when a complete selection contains malformed evidence rows', () => {
    const selection = stepByTool(task('test-selection.customer-ts'), 'opensip', 'select_tests');
    for (const data of [
      selectionData({ tests: [{ path: 'test/a.ts' }] }),
      selectionData({ commands: [{ argv: ['pnpm', 'test'] }] }),
      selectionData({ schemaVersion: 2 }),
    ]) {
      expect(
        selection.assessProofClosure?.({
          context: { catalog: { identity: GRAPH_IDENTITY, status: 'loaded' } },
          data,
        }),
      ).toEqual({
        domainExhausted: false,
        projectionComplete: false,
        reasonCodes: ['malformed-test-selection'],
      });
    }
  });

  it.each(testSelectionTasks)(
    'keeps $id control selections relevance-backed instead of treating names as answers',
    async (taskValue) => {
      const leg = await executeArm({
        assertions: {
          leg: 'main',
          mustExclude: taskValue.assertions.mustExclude,
          mustInclude: taskValue.assertions.mustInclude,
        },
        invoker: createNativeInvoker(resolve(FIXTURES_ROOT, taskValue.fixture)),
        steps: taskValue.strategies.control.steps,
      });
      const facts = leg.steps.flatMap(({ facts: stepFacts }) => stepFacts);

      const mapping =
        taskValue.fixture === 'customer-ts'
          ? customerTsGroundTruth.testMappings[0]
          : customerPyGroundTruth.testMappings[0];
      for (const selectedTest of mapping.testFiles) {
        expect(facts).toContainEqual({
          kind: 'file',
          path: selectedTest,
          role: 'test',
        });
      }
      expect(facts).toContainEqual(
        expect.objectContaining({
          command:
            taskValue.fixture === 'customer-ts'
              ? customerTsGroundTruth.testMappings[0].fallbackCommand
              : customerPyGroundTruth.testMappings[0].fallbackCommand,
          kind: 'command',
          purpose: 'fallback',
        }),
      );
      for (const decoy of mapping.irrelevantTestFiles ?? []) {
        expect(facts).not.toContainEqual({
          kind: 'file',
          path: decoy,
          role: 'test',
        });
      }
      for (const expectation of taskValue.assertions.mustExclude ?? []) {
        expect(facts.some((fact) => factMatches(expectation, fact))).toBe(false);
      }
      expect(leg.steps.every(({ failure }) => failure === undefined)).toBe(true);
      expect(leg.steps.map(({ tool }) => tool)).not.toContain('globList');
    },
  );
});
