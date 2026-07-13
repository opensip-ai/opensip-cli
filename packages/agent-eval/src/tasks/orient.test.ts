import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createNativeInvoker } from '../adapters/native-tools.js';
import { customerTsGroundTruth } from '../ground-truth/customer-ts.js';
import { customerWorkspaceGroundTruth } from '../ground-truth/customer-workspace.js';
import { factMatches } from '../model/argument-resolution.js';
import { executeArm } from '../runner/execute-arm.js';

import { orientCustomerTsTask, orientCustomerWorkspaceTask, orientTasks } from './orient.js';

import type { GoldTask, StrategyStep } from '../model/task.js';

const fixturesRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../__fixtures__');

function step(task: GoldTask, arm: 'control' | 'opensip', id: string): StrategyStep {
  const found = task.strategies[arm].steps.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Missing ${arm} step ${id}`);
  return found;
}

async function runControl(task: GoldTask) {
  return executeArm({
    assertions: {
      leg: 'main',
      mustExclude: task.assertions.mustExclude,
      mustInclude: task.assertions.mustInclude,
    },
    invoker: createNativeInvoker(resolve(fixturesRoot, task.fixture)),
    steps: task.strategies.control.steps,
  });
}

describe('orient gold tasks', () => {
  it('pins the customer-ts manifest truth and the stale Mocha README trap', () => {
    const include = orientCustomerTsTask.assertions.mustInclude ?? [];
    const exclude = orientCustomerTsTask.assertions.mustExclude ?? [];

    expect(include).toContainEqual({
      command: customerTsGroundTruth.orientation.testCommand,
      kind: 'command',
      purpose: 'test',
    });
    expect(include).toContainEqual({
      command: customerTsGroundTruth.orientation.buildCommand,
      kind: 'command',
      purpose: 'build',
    });
    expect(exclude).toContainEqual({
      command: 'npx mocha "test/**/*.spec.ts"',
      kind: 'command',
      purpose: 'test',
    });
    expect(exclude).not.toContainEqual(expect.objectContaining({ command: 'npm test' }));
  });

  it('pins the workspace package set and command assertions to typed ground truth', () => {
    const assertions = orientCustomerWorkspaceTask.assertions.mustInclude ?? [];
    const orientation = customerWorkspaceGroundTruth.orientation;

    expect(assertions).toContainEqual({
      command: orientation.testCommand,
      kind: 'command',
      purpose: 'test',
    });
    expect(assertions).toContainEqual({
      kind: 'count',
      label: 'packages',
      value: orientation.packageCount,
    });
    for (const name of orientation.packageNames) {
      expect(assertions).toContainEqual({ kind: 'package', name });
    }
  });

  it('normalizes manifest bytes without injecting fixture truth', () => {
    const extract = step(orientCustomerTsTask, 'control', 'control-read-root-manifest').extract;
    const alternativeManifest = JSON.stringify({
      name: '@alternative/project',
      packageManager: 'yarn@4.5.0',
      scripts: { build: 'swc src', test: 'node --test' },
    });

    const facts = extract({
      content: alternativeManifest,
      path: 'package.json',
      truncated: false,
    });

    expect(facts).toContainEqual({
      kind: 'package',
      name: '@alternative/project',
    });
    expect(facts).toContainEqual({
      kind: 'text',
      label: 'package-manager',
      value: 'yarn',
    });
    expect(facts).toContainEqual({
      command: 'node --test',
      kind: 'command',
      purpose: 'test',
    });
    expect(facts).not.toContainEqual({
      command: customerTsGroundTruth.orientation.testCommand,
      kind: 'command',
      purpose: 'test',
    });
    expect(
      extract({
        content: 'Run tests with npx mocha "test/**/*.spec.ts"',
        path: 'README.md',
        truncated: false,
      }),
    ).toEqual([]);
  });

  it('normalizes only package rows present in an MCP response', () => {
    const extract = step(
      orientCustomerWorkspaceTask,
      'opensip',
      'opensip-read-package-dependencies',
    ).extract;
    const facts = extract({
      data: {
        calls: [{ fromPackage: '@alternative/api', toPackage: '@alternative/core' }],
        imports: [],
      },
    });

    expect(facts).toEqual([
      { kind: 'package', name: '@alternative/api' },
      { kind: 'package', name: '@alternative/core' },
    ]);
    expect(facts).not.toContainEqual({
      kind: 'package',
      name: '@fixture/ws-api',
    });
  });

  it.each(orientTasks)(
    'lets the native control strategy answer $id from fixture bytes',
    async (task) => {
      const leg = await runControl(task);
      const facts = leg.steps.flatMap(({ facts: stepFacts }) => stepFacts);

      for (const expectation of task.assertions.mustInclude ?? []) {
        expect(facts.some((fact) => factMatches(expectation, fact))).toBe(true);
      }
      const exclusions =
        'mustExclude' in task.assertions ? (task.assertions.mustExclude ?? []) : [];
      for (const expectation of exclusions) {
        expect(facts.some((fact) => factMatches(expectation, fact))).toBe(false);
      }
      expect(leg.steps.every(({ failure }) => failure === undefined)).toBe(true);
    },
  );

  it('keeps setup catalog discovery out of measured strategies and freezes task data', () => {
    for (const task of orientTasks) {
      expect(Object.isFrozen(task)).toBe(true);
      expect(Object.isFrozen(task.strategies)).toBe(true);
      expect(Object.isFrozen(task.strategies.opensip.steps)).toBe(true);
      expect(task.strategies.opensip.version).toContain('epoch-4');
      expect(
        Object.values(task.strategies).flatMap(({ steps }) => steps.map(({ tool }) => tool)),
      ).not.toContain('get_agent_catalog');
    }
  });
});
