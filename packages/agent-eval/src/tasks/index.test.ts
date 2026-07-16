// @fitness-ignore-file module-coupling-fan-out -- Registry contract test intentionally composes every task family and ground-truth module to audit the closed catalog.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { customerPyGroundTruth } from '../ground-truth/customer-py.js';
import { customerStalenessGroundTruth } from '../ground-truth/customer-staleness.js';
import { customerTsGroundTruth } from '../ground-truth/customer-ts.js';
import { customerWorkspaceGroundTruth } from '../ground-truth/customer-workspace.js';
import { dogfoodGroundTruth } from '../ground-truth/dogfood.js';
import { factMatches } from '../model/argument-resolution.js';
import { isUnknownRecord as isRecord } from '../model/value-helpers.js';
import { resolveFixtureReference } from '../runner/run-task.js';

import { dogfoodTasks } from './dogfood.js';
import { entrypointTraceTasks } from './entrypoint-trace.js';
import { impactTasks } from './impact.js';
import { orientTasks } from './orient.js';
import { stalenessTasks } from './staleness.js';
import { testSelectionTasks } from './test-selection.js';

import { taskRegistry } from './index.js';

import type { FixtureGroundTruth } from '../ground-truth/types.js';
import type {
  AnswerFact,
  AnswerFactPattern,
  Arm,
  FactBinding,
  GoldTask,
  StrategyStep,
} from '../model/task.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesRoot = resolve(packageRoot, '__fixtures__');
const repositoryRoot = resolve(packageRoot, '../..');

const sourceTasks: readonly GoldTask[] = [
  ...orientTasks,
  ...entrypointTraceTasks,
  ...impactTasks,
  ...testSelectionTasks,
  ...stalenessTasks,
  ...dogfoodTasks,
];

const EXPECTED_TASKS = [
  {
    family: 'entrypoint-trace',
    fixture: 'customer-ts',
    id: 'entrypoint-trace.customer-ts',
  },
  {
    family: 'entrypoint-trace',
    fixture: 'dogfood',
    id: 'entrypoint-trace.dogfood',
  },
  {
    family: 'impact-estimate',
    fixture: 'customer-py',
    id: 'impact-estimate.customer-py',
  },
  {
    family: 'impact-estimate',
    fixture: 'customer-ts',
    id: 'impact-estimate.customer-ts',
  },
  {
    family: 'impact-estimate',
    fixture: 'customer-workspace',
    id: 'impact-estimate.customer-workspace',
  },
  { family: 'orient', fixture: 'customer-ts', id: 'orient.customer-ts' },
  {
    family: 'orient',
    fixture: 'customer-workspace',
    id: 'orient.customer-workspace',
  },
  { family: 'orient', fixture: 'dogfood', id: 'orient.dogfood' },
  {
    family: 'staleness',
    fixture: 'customer-staleness',
    id: 'staleness-add-caller.customer-staleness',
  },
  {
    family: 'staleness',
    fixture: 'customer-staleness',
    id: 'staleness-delete-symbol.customer-staleness',
  },
  {
    family: 'test-selection',
    fixture: 'customer-py',
    id: 'test-selection.customer-py',
  },
  {
    family: 'test-selection',
    fixture: 'customer-ts',
    id: 'test-selection.customer-ts',
  },
] as const;

const CONTROL_TOOLS = new Set(['contentSearch', 'globList', 'readFile']);
const MCP_SURFACE_TOOLS = new Set([
  'blast_radius',
  'callees_of',
  'compare_to_baseline',
  'find_dead_code',
  'get_agent_catalog',
  'get_architecture',
  'get_context_status',
  'get_file_context',
  'get_latest_findings',
  'get_runtime_wiring',
  'get_symbol',
  'impact_files',
  'list_runs',
  'package_cycles',
  'package_dependencies',
  'references_to',
  'refresh_graph',
  'review_change',
  'search_declarations',
  'search_symbols',
  'select_tests',
  'show_run',
  'trace_path',
  'who_calls',
  'why_depends',
]);
const RESPONSE_ID_ARGUMENTS = new Set(['declarationId', 'fromSymbolId', 'symbolId', 'toSymbolId']);

interface StepGroup {
  readonly arm: Arm;
  readonly label: 'main' | 'post-edit' | 'recovery';
  readonly steps: readonly StrategyStep[];
}

interface LocatedBinding {
  readonly binding: FactBinding;
  readonly path: string;
}

interface LocatedArgument {
  readonly name: string;
  readonly path: string;
  readonly value: unknown;
}

function taskFamily(task: GoldTask): string {
  const prefix = task.id.split('.')[0] ?? task.id;
  return prefix.startsWith('staleness-') ? 'staleness' : prefix;
}

function stepGroups(task: GoldTask): readonly StepGroup[] {
  return [
    { arm: 'control', label: 'main', steps: task.strategies.control.steps },
    { arm: 'opensip', label: 'main', steps: task.strategies.opensip.steps },
    {
      arm: 'control',
      label: 'post-edit',
      steps: task.staleness?.postEditSteps.control ?? [],
    },
    {
      arm: 'opensip',
      label: 'post-edit',
      steps: task.staleness?.postEditSteps.opensip ?? [],
    },
    {
      arm: 'control',
      label: 'recovery',
      steps: task.staleness?.recoverySteps?.control ?? [],
    },
    {
      arm: 'opensip',
      label: 'recovery',
      steps: task.staleness?.recoverySteps?.opensip ?? [],
    },
  ];
}

function allSteps(task: GoldTask): readonly StrategyStep[] {
  return stepGroups(task).flatMap(({ steps }) => steps);
}

function expectDeepFrozen(value: unknown, path: string): void {
  if (typeof value !== 'object' || value === null) return;
  expect(Object.isFrozen(value), path).toBe(true);
  for (const [key, child] of Object.entries(value)) {
    expectDeepFrozen(child, `${path}.${key}`);
  }
}

function isStructuredFactBinding(value: unknown): value is FactBinding {
  return isRecord(value) && isRecord(value.$fact) && isRecord(value.$fact.match);
}

function collectBindings(value: unknown, path = 'arguments'): readonly LocatedBinding[] {
  if (isStructuredFactBinding(value)) return [{ binding: value, path }];
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => collectBindings(child, `${path}[${String(index)}]`));
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => collectBindings(child, `${path}.${key}`));
}

function collectArguments(value: unknown, path = 'arguments'): readonly LocatedArgument[] {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => collectArguments(child, `${path}[${String(index)}]`));
  }
  if (!isRecord(value) || isStructuredFactBinding(value)) return [];
  return Object.entries(value).flatMap(([name, child]) => [
    { name, path: `${path}.${name}`, value: child },
    ...collectArguments(child, `${path}.${name}`),
  ]);
}

function validatePriorBindings(task: GoldTask, group: StepGroup): void {
  const priorStepIds = new Set<string>();
  for (const step of group.steps) {
    for (const { binding, path } of collectBindings(step.arguments)) {
      expect(binding.$fact.stepId, `${task.id}:${step.id}:${path}`).toBeTypeOf('string');
      expect(
        priorStepIds.has(binding.$fact.stepId ?? ''),
        `${task.id}:${step.id}:${path} must bind an earlier ${group.label} step`,
      ).toBe(true);
    }
    priorStepIds.add(step.id);
  }
}

function validateIdentityBinding(task: GoldTask, step: StrategyStep, argument: LocatedArgument) {
  expect(isStructuredFactBinding(argument.value), `${task.id}:${step.id}:${argument.path}`).toBe(
    true,
  );
  if (!isStructuredFactBinding(argument.value)) return;
  const declaration = argument.name === 'declarationId';
  expect(argument.value.$fact.field).toBe(declaration ? 'declarationId' : 'symbolId');
  expect(argument.value.$fact.match.kind).toBe(
    declaration ? 'declaration-handle' : 'symbol-handle',
  );
}

function fixtureSemanticFacts(truth: FixtureGroundTruth): readonly AnswerFact[] {
  const orientation = truth.orientation;
  const facts: AnswerFact[] = [
    {
      kind: 'text',
      label: 'package-manager',
      value: orientation.packageManager,
    },
    {
      kind: 'text',
      label: 'package-manager-declaration',
      value: orientation.packageManagerDeclaration,
    },
    { kind: 'file', path: orientation.lockfile },
    { kind: 'count', label: 'packages', value: orientation.packageCount },
    { command: orientation.buildCommand, kind: 'command', purpose: 'build' },
    { command: orientation.testCommand, kind: 'command', purpose: 'test' },
    {
      filePath: truth.entrypoint.entryFile,
      kind: 'symbol',
      name: truth.entrypoint.entrySymbol,
    },
    {
      filePath: truth.entrypoint.implementationFile,
      kind: 'symbol',
      name: truth.entrypoint.implementationSymbol,
    },
    {
      kind: 'evidence',
      subject: `terminal:${truth.entrypoint.implementationSymbol}`,
    },
    ...orientation.packageNames.map((name): AnswerFact => ({
      kind: 'package',
      name,
    })),
    ...(orientation.workspaceFile === undefined
      ? []
      : [{ kind: 'file' as const, path: orientation.workspaceFile }]),
    { kind: 'file', path: truth.entrypoint.entryFile },
    { kind: 'file', path: truth.entrypoint.implementationFile },
    ...truth.entrypoint.barrelFiles.map((path): AnswerFact => ({
      kind: 'file',
      path,
    })),
  ];
  appendImpactFacts(facts, truth);
  appendTestSelectionFacts(facts, truth);
  appendStalenessFacts(facts, truth);
  return facts;
}

function appendImpactFacts(facts: AnswerFact[], truth: FixtureGroundTruth): void {
  for (const target of truth.impactTargets) {
    facts.push(
      { kind: 'file', path: target.targetFile },
      ...target.impactedPackages.map((name): AnswerFact => ({
        kind: 'package',
        name,
      })),
    );
    for (const caller of target.callers) {
      facts.push(
        { kind: 'file', path: caller.filePath },
        { filePath: caller.filePath, kind: 'symbol', name: caller.symbol },
      );
      if (caller.expectedConfidence === 'unresolved') {
        facts.push({
          confidence: 'low',
          evidenceKind: 'target-linked-unresolved-call-site',
          filePath: caller.filePath,
          kind: 'evidence',
          subject: caller.filePath,
        });
      } else {
        facts.push({
          confidence: caller.expectedConfidence,
          evidenceKind: 'call',
          filePath: caller.filePath,
          kind: 'evidence',
          subject: `${caller.filePath}#${caller.symbol}`,
        });
      }
    }
  }
}

function appendTestSelectionFacts(facts: AnswerFact[], truth: FixtureGroundTruth): void {
  for (const mapping of truth.testMappings) {
    facts.push(
      ...mapping.testFiles.map((path): AnswerFact => ({
        kind: 'file',
        path,
        role: 'test',
      })),
      {
        command: mapping.fallbackCommand,
        kind: 'command',
        purpose: 'fallback',
      },
    );
  }
}

function appendStalenessFacts(facts: AnswerFact[], truth: FixtureGroundTruth): void {
  if (truth.staleness === undefined) return;
  facts.push(
    { kind: 'file', path: truth.staleness.targetFile },
    { kind: 'file', path: truth.staleness.addCaller.filePath },
  );
}

function dogfoodSemanticFacts(): readonly AnswerFact[] {
  const facts: AnswerFact[] = [
    {
      kind: 'text',
      label: 'package-manager',
      value: dogfoodGroundTruth.packageManager,
    },
    { kind: 'file', path: dogfoodGroundTruth.lockfile },
    { kind: 'file', path: 'turbo.json' },
    { command: dogfoodGroundTruth.buildCommand, kind: 'command' },
    { command: dogfoodGroundTruth.testCommand, kind: 'command' },
  ];
  for (const anchor of dogfoodGroundTruth.anchors) {
    facts.push(
      { kind: 'file', path: anchor.definingFile },
      ...anchor.referenceFiles.map((path): AnswerFact => ({
        kind: 'file',
        path,
      })),
    );
    if ('publicExportFile' in anchor && anchor.publicExportFile !== undefined) {
      facts.push({ kind: 'file', path: anchor.publicExportFile });
    }
  }
  return facts;
}

const semanticFacts: Readonly<Record<string, readonly AnswerFact[]>> = Object.freeze({
  'customer-py': fixtureSemanticFacts(customerPyGroundTruth),
  'customer-staleness': [
    { kind: 'file', path: customerStalenessGroundTruth.targetFile },
    { kind: 'file', path: customerStalenessGroundTruth.addCaller.filePath },
    ...customerStalenessGroundTruth.preEditCallers.map((caller): AnswerFact => ({
      kind: 'file',
      path: caller.filePath,
    })),
  ],
  'customer-ts': fixtureSemanticFacts(customerTsGroundTruth),
  'customer-workspace': fixtureSemanticFacts(customerWorkspaceGroundTruth),
  dogfood: dogfoodSemanticFacts(),
});

const knownNegativeFacts: Readonly<Record<string, readonly AnswerFact[]>> = Object.freeze({
  'customer-py': [{ kind: 'file', path: 'tests/test_receipt.py', role: 'test' }],
  'customer-staleness': [],
  'customer-ts': [
    { kind: 'file', path: 'test/health.spec.ts', role: 'test' },
    {
      command: 'npx mocha "test/**/*.spec.ts"',
      kind: 'command',
      purpose: 'test',
    },
    {
      command: 'npx mocha "test/**/*.spec.ts"',
      kind: 'command',
      purpose: 'test-script',
    },
  ],
  'customer-workspace': [{ kind: 'package', name: '@fixture/ws-tools' }],
  dogfood: [],
});

function assertionPatterns(task: GoldTask, field: 'mustExclude' | 'mustInclude') {
  return [
    ...(task.assertions[field] ?? []),
    ...(task.assertions.scoped ?? []).flatMap((assertions) => assertions[field] ?? []),
  ];
}

function expectBackedPattern(
  task: GoldTask,
  pattern: AnswerFactPattern,
  candidates: readonly AnswerFact[],
): void {
  expect(
    candidates.some((fact) => factMatches(pattern, fact)),
    `${task.id} assertion is not backed by ${task.fixture} truth: ${JSON.stringify(pattern)}`,
  ).toBe(true);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedStrings(values: readonly string[]): readonly string[] {
  return [...values].sort(compareStrings);
}

describe('gold task registry', () => {
  it('is a frozen plain id-to-task record with the exact family/fixture catalog', () => {
    const ids = sourceTasks.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.isFrozen(taskRegistry)).toBe(true);
    expect(Object.getPrototypeOf(taskRegistry)).toBe(Object.prototype);
    expect(sortedStrings(Object.keys(taskRegistry))).toEqual(sortedStrings(ids));
    for (const [id, task] of Object.entries(taskRegistry)) expect(task.id).toBe(id);

    const actual = Object.values(taskRegistry).map((task) => ({
      family: taskFamily(task),
      fixture: task.fixture,
      id: task.id,
    }));
    actual.sort((left, right) => compareStrings(left.id, right.id));
    const expected = [...EXPECTED_TASKS];
    expected.sort((left, right) => compareStrings(left.id, right.id));
    expect(actual).toEqual(expected);
  });

  it('resolves every fixture through the runner-owned closed resolver', () => {
    for (const task of Object.values(taskRegistry)) {
      const resolution = resolveFixtureReference(task.fixture, {
        fixturesRoot,
        repositoryRoot,
      });
      expect(resolution.mode).toBe(task.fixture === 'dogfood' ? 'reuse-existing' : 'fixture');
    }
  });

  it('deep-freezes every task, strategy, and declared step array', () => {
    for (const task of Object.values(taskRegistry)) expectDeepFrozen(task, task.id);
    for (const tasks of [
      orientTasks,
      entrypointTraceTasks,
      impactTasks,
      testSelectionTasks,
      stalenessTasks,
      dogfoodTasks,
    ]) {
      expect(Object.isFrozen(tasks)).toBe(true);
    }
  });

  it('declares both versioned arms and an explicit none contract on every step', () => {
    for (const task of Object.values(taskRegistry)) {
      expect(sortedStrings(Object.keys(task.strategies))).toEqual(['control', 'opensip']);
      for (const arm of ['control', 'opensip'] as const) {
        const strategy = task.strategies[arm];
        expect(strategy.arm).toBe(arm);
        expect(strategy.version.trim().length).toBeGreaterThan(0);
        expect(strategy.steps.length).toBeGreaterThan(0);
      }
      for (const step of allSteps(task)) expect(step.expectedNonEmpty).toBeTypeOf('boolean');
    }
  });

  it('keeps control and OpenSIP strategies inside their closed tool vocabularies', () => {
    const usedControlTools = new Set<string>();
    for (const task of Object.values(taskRegistry)) {
      for (const group of stepGroups(task)) {
        for (const step of group.steps) {
          const vocabulary = group.arm === 'control' ? CONTROL_TOOLS : MCP_SURFACE_TOOLS;
          expect(vocabulary.has(step.tool), `${task.id}:${step.id}:${step.tool}`).toBe(true);
          if (group.arm === 'control') usedControlTools.add(step.tool);
          expect(step.tool).not.toBe('get_agent_catalog');
          expect(step.tool).not.toBe('repair_apply_verify');
        }
      }
    }
    expect(sortedStrings([...usedControlTools])).toEqual(sortedStrings([...CONTROL_TOOLS]));
  });

  it('uses prior response FactBindings for every symbol and declaration identity', () => {
    let declarationReferenceChains = 0;
    for (const task of Object.values(taskRegistry)) {
      for (const group of stepGroups(task)) {
        validatePriorBindings(task, group);
        for (const step of group.steps) {
          const argumentsWithIdentity = collectArguments(step.arguments).filter(({ name }) =>
            RESPONSE_ID_ARGUMENTS.has(name),
          );
          for (const argument of argumentsWithIdentity) {
            validateIdentityBinding(task, step, argument);
          }
          if (step.tool === 'references_to') {
            declarationReferenceChains += 1;
            expect(argumentsWithIdentity.map(({ name }) => name)).toEqual(['declarationId']);
            const declarationBinding = argumentsWithIdentity[0]?.value;
            expect(isStructuredFactBinding(declarationBinding)).toBe(true);
            if (isStructuredFactBinding(declarationBinding)) {
              const producer = group.steps.find(
                (candidate) => candidate.id === declarationBinding.$fact.stepId,
              );
              expect(producer?.tool).toBe('search_declarations');
            }
          }
        }
      }
    }
    expect(declarationReferenceChains).toBeGreaterThan(0);
  });

  it('keeps mutation exclusively in disposable-fixture staleness recovery', () => {
    for (const task of Object.values(taskRegistry)) {
      if (task.staleness === undefined) {
        expect(allSteps(task).map(({ tool }) => tool)).not.toContain('refresh_graph');
        continue;
      }
      expect(task.fixture).not.toBe('dogfood');
      expect(task.assertions.staleness).toEqual({
        postEditLeg: 'post-edit',
        recoveryLeg: 'recovery',
      });
      expect(task.staleness.edit.operations.length).toBeGreaterThan(0);
      expect(task.strategies.control.steps.every(({ leg }) => leg === 'pre-edit')).toBe(true);
      expect(task.strategies.opensip.steps.every(({ leg }) => leg === 'pre-edit')).toBe(true);
      expect(task.staleness.postEditSteps.control.every(({ leg }) => leg === 'post-edit')).toBe(
        true,
      );
      expect(task.staleness.postEditSteps.opensip.every(({ leg }) => leg === 'post-edit')).toBe(
        true,
      );
      expect(task.staleness.recoverySteps?.control).toEqual([]);
      const measuredOpenSipSteps = [
        ...task.strategies.opensip.steps,
        ...task.staleness.postEditSteps.opensip,
      ];
      expect(measuredOpenSipSteps.map(({ tool }) => tool)).not.toContain('refresh_graph');
      const recovery = task.staleness.recoverySteps?.opensip ?? [];
      expect(recovery[0]?.tool).toBe('refresh_graph');
      expect(recovery.filter(({ tool }) => tool === 'refresh_graph')).toHaveLength(1);
      expect(recovery.every(({ leg }) => leg === 'recovery')).toBe(true);
    }
    for (const task of dogfoodTasks) {
      expect(task.staleness).toBeUndefined();
      expect(allSteps(task).map(({ tool }) => tool)).not.toContain('refresh_graph');
    }
  });

  it('backs every assertion with fixture or dogfood ground truth semantics', () => {
    for (const task of Object.values(taskRegistry)) {
      const includedTruth = semanticFacts[task.fixture];
      const excludedTruth = knownNegativeFacts[task.fixture];
      expect(includedTruth, `missing truth catalog for ${task.fixture}`).toBeDefined();
      expect(excludedTruth, `missing negative catalog for ${task.fixture}`).toBeDefined();
      for (const pattern of assertionPatterns(task, 'mustInclude')) {
        expectBackedPattern(task, pattern, includedTruth ?? []);
      }
      for (const pattern of assertionPatterns(task, 'mustExclude')) {
        expectBackedPattern(task, pattern, [...(includedTruth ?? []), ...(excludedTruth ?? [])]);
      }
    }
  });
});
