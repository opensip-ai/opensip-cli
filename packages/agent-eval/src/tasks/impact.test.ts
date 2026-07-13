import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createNativeInvoker } from '../adapters/native-tools.js';
import { customerPyGroundTruth } from '../ground-truth/customer-py.js';
import { customerTsGroundTruth } from '../ground-truth/customer-ts.js';
import { customerWorkspaceGroundTruth } from '../ground-truth/customer-workspace.js';
import { executeArm } from '../runner/execute-arm.js';

import { impactTasks } from './impact.js';

import type { FactBinding, GoldTask, StrategyStep } from '../model/task.js';

const FIXTURES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../__fixtures__');

function task(id: string): GoldTask {
  const result = impactTasks.find((candidate) => candidate.id === id);
  if (result === undefined) throw new Error(`Missing impact task ${id}.`);
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

describe('impact-estimate gold tasks', () => {
  it('freezes the three customer instances at the epoch-4 before-baseline', () => {
    expect(impactTasks.map(({ id }) => id)).toEqual([
      'impact-estimate.customer-ts',
      'impact-estimate.customer-py',
      'impact-estimate.customer-workspace',
    ]);
    expect(Object.isFrozen(impactTasks)).toBe(true);
    for (const taskValue of impactTasks) {
      expect(Object.isFrozen(taskValue)).toBe(true);
      expect(Object.isFrozen(taskValue.strategies)).toBe(true);
      expect(Object.isFrozen(taskValue.strategies.control.steps)).toBe(true);
      expect(taskValue.strategies.control.version).toBe('control-native-v1');
      expect(taskValue.strategies.opensip.version).toContain('epoch-4');
    }
  });

  it('pins complete caller files, confidence-bearing evidence, and impacted packages', () => {
    const truths = [
      customerTsGroundTruth,
      customerPyGroundTruth,
      customerWorkspaceGroundTruth,
    ] as const;
    for (const truth of truths) {
      const target = truth.impactTargets[0];
      const assertions = task(`impact-estimate.${truth.fixture}`).assertions.mustInclude ?? [];
      for (const caller of target.callers) {
        expect(assertions).toContainEqual({
          kind: 'file',
          path: caller.filePath,
        });
        const structural =
          caller.evidenceKind === 'barrel-reexport' || caller.evidenceKind === 'dynamic-dispatch';
        if (structural) {
          expect(assertions).toContainEqual({
            filePath: caller.filePath,
            kind: 'symbol',
            name: caller.symbol,
          });
        }
        if (caller.expectedConfidence === 'unresolved') {
          expect(assertions).toContainEqual({
            evidenceKind: 'target-linked-unresolved-call-site',
            filePath: caller.filePath,
            kind: 'evidence',
            minimumConfidence: 'low',
          });
        } else {
          expect(assertions).toContainEqual({
            evidenceKind: 'call',
            filePath: caller.filePath,
            kind: 'evidence',
            minimumConfidence: caller.expectedConfidence,
            subject: `${caller.filePath}#${caller.symbol}`,
          });
        }
      }
      for (const name of target.impactedPackages) {
        expect(assertions).toContainEqual({ kind: 'package', name });
      }
    }
  });

  it('binds every symbol-dependent read to the prior normalized search handle', () => {
    for (const taskValue of impactTasks) {
      const search = stepByTool(taskValue, 'opensip', 'search_symbols');
      const whoCalls = stepByTool(taskValue, 'opensip', 'who_calls');
      const blast = stepByTool(taskValue, 'opensip', 'blast_radius');
      for (const dependent of [whoCalls, blast]) {
        const binding = factBinding(dependent.arguments.symbolId);
        expect(binding.$fact).toEqual({
          field: 'symbolId',
          match: {
            kind: 'symbol-handle',
            name: search.arguments.query,
          },
          select: 'only',
          stepId: search.id,
        });
        expect(dependent.arguments.limit).toBe(500);
      }
      expect(search.arguments).toMatchObject({
        detail: 'nodes',
        limit: 20,
        match: 'exact',
        sourceScope: 'all',
      });
      expect(JSON.stringify(whoCalls.arguments)).not.toContain(':1:0');
    }
    const workspace = task('impact-estimate.customer-workspace');
    const search = stepByTool(workspace, 'opensip', 'search_symbols');
    const packages = stepByTool(workspace, 'opensip', 'package_dependencies');
    expect(factBinding(packages.arguments.package).$fact).toEqual({
      field: 'package',
      match: { kind: 'symbol-handle', name: 'normalizeAccount' },
      select: 'only',
      stepId: search.id,
    });
    expect(packages.arguments).toMatchObject({ limit: 500, sampleLimit: 0 });
  });

  it('does not turn incident package edges into a transitive non-impact proof', () => {
    const workspace = task('impact-estimate.customer-workspace');
    const packages = stepByTool(workspace, 'opensip', 'package_dependencies');

    expect(workspace.assertions.mustExclude).toBeUndefined();
    expect(packages.provesAbsence).toBeUndefined();
    expect(workspace.strategies.opensip.version).toBe(
      'opensip-mcp-epoch-4-v2-no-transitive-negative',
    );
  });

  it('discovers workspace manifests without injecting exact package topology', () => {
    const control = task('impact-estimate.customer-workspace').strategies.control.steps;
    const renderedArguments = JSON.stringify(control.map(({ arguments: args }) => args));
    expect(renderedArguments).not.toContain('packages/ws-core/package.json');
    expect(renderedArguments).not.toContain('packages/ws-api/package.json');
    expect(renderedArguments).not.toContain('packages/ws-web/package.json');
    expect(control).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          arguments: expect.objectContaining({
            pattern: 'packages/*/package.json',
          }),
          tool: 'globList',
        }),
        expect.objectContaining({
          arguments: expect.objectContaining({
            glob: 'packages/*/package.json',
          }),
          tool: 'contentSearch',
        }),
      ]),
    );
  });

  it('extracts workspace package impact from the bounded manifest inventory', async () => {
    const taskValue = task('impact-estimate.customer-workspace');
    const leg = await executeArm({
      assertions: {
        leg: 'main',
        mustInclude: taskValue.assertions.mustInclude,
      },
      invoker: createNativeInvoker(resolve(FIXTURES_ROOT, taskValue.fixture)),
      steps: taskValue.strategies.control.steps,
    });
    const facts = leg.steps.flatMap(({ facts: stepFacts }) => stepFacts);
    for (const name of customerWorkspaceGroundTruth.impactTargets[0].impactedPackages) {
      expect(facts).toContainEqual({ kind: 'package', name });
    }
    expect(leg.steps.every(({ failure }) => failure === undefined)).toBe(true);
  });

  it('preserves caller provenance and in-test metadata from who_calls nodes', () => {
    const whoCalls = stepByTool(task('impact-estimate.customer-ts'), 'opensip', 'who_calls');
    const facts = whoCalls.extract({
      data: {
        nodes: [
          {
            depth: 0,
            symbol: {
              filePath: 'src/target.ts',
              inTestFile: false,
              simpleName: 'calculateInvoice',
              symbolId: 'src/target.ts:1:0',
            },
          },
          {
            depth: 1,
            incomingEvidence: {
              confidence: 'medium',
              kind: 'call',
              resolution: 'semantic',
            },
            symbol: {
              bodyHash: 'caller-body',
              column: 2,
              filePath: 'test/caller.spec.ts',
              inTestFile: true,
              line: 7,
              package: '@fixture/customer-ts',
              qualifiedName: 'caller',
              simpleName: 'caller',
              symbolId: 'test/caller.spec.ts:7:2',
            },
          },
        ],
        unresolved: [],
      },
    });

    expect(facts).toContainEqual({
      kind: 'file',
      path: 'test/caller.spec.ts',
      role: 'caller',
    });
    expect(facts).toContainEqual(
      expect.objectContaining({
        filePath: 'test/caller.spec.ts',
        inTestFile: true,
        kind: 'symbol-handle',
        symbolId: 'test/caller.spec.ts:7:2',
      }),
    );
    expect(facts).toContainEqual({
      confidence: 'medium',
      evidenceKind: 'call',
      filePath: 'test/caller.spec.ts',
      kind: 'evidence',
      resolution: 'semantic',
      subject: 'test/caller.spec.ts#caller',
    });
    expect(facts).not.toContainEqual(expect.objectContaining({ path: 'src/target.ts' }));
  });

  it('retains unresolved owner diagnostics without claiming a reverse caller', () => {
    const whoCalls = stepByTool(task('impact-estimate.customer-ts'), 'opensip', 'who_calls');
    const facts = whoCalls.extract({
      data: {
        nodes: [{ depth: 0, symbol: { bodyHash: 'target-body' } }],
        unresolved: [
          {
            callSite: {
              column: 10,
              filePath: 'src/dispatch/registry.ts',
              line: 8,
            },
            confidence: 'low',
            ownerSymbolId: 'src/dispatch/registry.ts:6:0',
            resolution: 'dynamic-dispatch',
            targetHashes: ['unrelated-body'],
          },
        ],
        unresolvedAttribution: 'owner-only',
      },
    });

    expect(facts).not.toContainEqual(expect.objectContaining({ kind: 'file' }));
    expect(facts).toContainEqual({
      attribution: 'owner-only',
      column: 10,
      confidence: 'low',
      evidenceKind: 'owner-only-unresolved-call-site',
      filePath: 'src/dispatch/registry.ts',
      kind: 'evidence',
      line: 8,
      resolution: 'dynamic-dispatch',
      subject: 'src/dispatch/registry.ts:6:0',
      targetHashes: ['unrelated-body'],
    });
    expect(facts).not.toContainEqual(
      expect.objectContaining({ evidenceKind: 'target-linked-unresolved-call-site' }),
    );
  });

  it('scores unresolved caller evidence only when a bounded target hash matches the root handle', () => {
    const whoCalls = stepByTool(task('impact-estimate.customer-ts'), 'opensip', 'who_calls');
    const facts = whoCalls.extract({
      data: {
        nodes: [{ depth: 0, symbol: { bodyHash: 'target-body' } }],
        unresolved: [
          {
            callSite: { column: 4, filePath: 'src/linked.ts', line: 12 },
            confidence: 'low',
            ownerSymbolId: 'src/linked.ts:10:0',
            resolution: 'dynamic-dispatch',
            targetHashes: ['target-body'],
          },
        ],
        unresolvedAttribution: 'owner-only',
      },
    });

    expect(facts).toContainEqual(
      expect.objectContaining({
        evidenceKind: 'target-linked-unresolved-call-site',
        filePath: 'src/linked.ts',
        targetHashes: ['target-body'],
      }),
    );
  });

  it('normalizes only symbol and package identities present in MCP payloads', () => {
    const taskValue = task('impact-estimate.customer-workspace');
    const search = stepByTool(taskValue, 'opensip', 'search_symbols');
    const packages = stepByTool(taskValue, 'opensip', 'package_dependencies');
    const searchFacts = search.extract({
      data: {
        symbols: [
          {
            filePath: 'alternative/target.ts',
            inTestFile: false,
            package: '@alternative/core',
            simpleName: 'alternativeTarget',
            symbolId: 'alternative/target.ts:2:0',
          },
        ],
      },
    });
    const packageFacts = packages.extract({
      data: {
        calls: [
          {
            fromPackage: '@alternative/api',
            toPackage: '@alternative/core',
          },
        ],
        imports: [],
      },
    });

    expect(searchFacts).toContainEqual(
      expect.objectContaining({
        kind: 'symbol-handle',
        name: 'alternativeTarget',
        symbolId: 'alternative/target.ts:2:0',
      }),
    );
    expect(packageFacts).toEqual([
      { kind: 'package', name: '@alternative/api' },
      { kind: 'package', name: '@alternative/core' },
    ]);
    expect([...searchFacts, ...packageFacts]).not.toContainEqual(
      expect.objectContaining({ name: '@fixture/ws-core' }),
    );
  });

  it('keeps blast body twins distinct from caller files', () => {
    const blast = stepByTool(task('impact-estimate.customer-ts'), 'opensip', 'blast_radius');
    const facts = blast.extract({
      data: {
        direct: 2,
        members: [
          {
            filePath: 'src/twin.ts',
            inTestFile: false,
            simpleName: 'calculateInvoice',
            symbolId: 'src/twin.ts:3:0',
          },
        ],
        score: 3,
        totalMembership: 1,
        transitive: 2,
      },
    });

    expect(facts).toContainEqual({
      kind: 'file',
      path: 'src/twin.ts',
      role: 'body-twin',
    });
    expect(facts).not.toContainEqual(expect.objectContaining({ role: 'caller' }));
    expect(facts).toContainEqual({
      kind: 'count',
      label: 'blast.direct',
      value: 2,
    });
  });

  it('returns honest MCP empties and makes native dynamic discovery a broad target search', () => {
    const tsTask = task('impact-estimate.customer-ts');
    const whoCalls = stepByTool(tsTask, 'opensip', 'who_calls');
    expect(whoCalls.extract({ data: { nodes: [], unresolved: [] } })).toEqual([]);
    expect(whoCalls.extract({ unexpected: true })).toEqual([]);

    const references = tsTask.strategies.control.steps.find((step) =>
      step.id.endsWith('.target-references'),
    );
    expect(references?.arguments.pattern).toBe('\\bcalculateInvoice\\b');
    expect(
      references?.extract({
        matches: [
          {
            path: 'src/generated/invoice-handlers.ts',
            text: "  'invoice.total': calculateInvoice,",
          },
        ],
        truncated: false,
      }),
    ).toContainEqual({
      kind: 'file',
      path: 'src/generated/invoice-handlers.ts',
      role: 'dynamic-reference',
    });
  });

  it.each([
    ['customer-ts', 'src/generated/invoice-handlers.ts', 'dispatchInvoiceHandler'],
    ['customer-py', 'ledger/registry.py', 'dispatch_operation'],
  ] as const)(
    'discovers the %s dynamic caller through broad search and a response-bound read',
    async (fixture, dynamicCaller, dynamicSymbol) => {
      const taskValue = task(`impact-estimate.${fixture}`);
      const leg = await executeArm({
        assertions: {
          leg: 'main',
          mustInclude: taskValue.assertions.mustInclude,
        },
        invoker: createNativeInvoker(resolve(FIXTURES_ROOT, fixture)),
        steps: taskValue.strategies.control.steps,
      });
      const facts = leg.steps.flatMap(({ facts: stepFacts }) => stepFacts);
      const referenceRecord = leg.steps.find(({ stepId }) => stepId.endsWith('.target-references'));
      const readRecord = leg.steps.find(({ stepId }) => stepId.endsWith('.read-dynamic-reference'));

      expect(referenceRecord).toMatchObject({
        completeness: 'complete',
        expectedNonEmpty: true,
        noneOutcome: 'nonempty',
      });
      expect(readRecord).toMatchObject({
        completeness: 'complete',
        expectedNonEmpty: true,
        noneOutcome: 'nonempty',
      });
      expect(facts).toContainEqual(expect.objectContaining({ kind: 'file', path: dynamicCaller }));
      expect(facts).toContainEqual({
        filePath: dynamicCaller,
        kind: 'symbol',
        name: dynamicSymbol,
      });
      expect(leg.steps.every(({ failure }) => failure === undefined)).toBe(true);
    },
  );
});
