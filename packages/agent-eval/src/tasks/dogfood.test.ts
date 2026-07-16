import { describe, expect, it } from 'vitest';

import { dogfoodGroundTruth } from '../ground-truth/dogfood.js';
import { runTaskArm } from '../runner/run-task.js';

import {
  dogfoodTasks,
  entrypointTraceDogfoodTask,
  extractCallerFileFacts,
  extractDeclarationSearchFacts,
  extractReferenceFacts,
  orientDogfoodTask,
} from './dogfood.js';

describe('dogfood tasks', () => {
  it('uses the canonical read-only fixture and never declares refresh or edits', () => {
    expect(dogfoodTasks).toHaveLength(2);
    for (const task of dogfoodTasks) {
      expect(task.fixture).toBe('dogfood');
      expect(task.staleness).toBeUndefined();
      expect(task.strategies.opensip.steps.map((step) => step.tool)).not.toContain('refresh_graph');
      expect(task.strategies.opensip.steps.map((step) => step.tool)).not.toContain(
        'repair_apply_verify',
      );
    }
  });

  it('keeps orientation assertions on durable dogfood truth', () => {
    expect(orientDogfoodTask.assertions.mustInclude).toEqual(
      expect.arrayContaining([
        {
          kind: 'text',
          label: 'package-manager',
          value: dogfoodGroundTruth.packageManager,
        },
        { kind: 'file', path: dogfoodGroundTruth.lockfile },
        { command: dogfoodGroundTruth.buildCommand, kind: 'command' },
        { command: dogfoodGroundTruth.testCommand, kind: 'command' },
      ]),
    );
  });

  it('keeps declaration ids distinct from callable symbol ids in bindings', () => {
    const steps = entrypointTraceDogfoodTask.strategies.opensip.steps;
    const references = steps.find((step) => step.tool === 'references_to');
    const callers = steps.find((step) => step.tool === 'who_calls');
    expect(references?.arguments.declarationId).toMatchObject({
      $fact: {
        field: 'declarationId',
        match: { kind: 'declaration-handle', name: 'RunScope' },
      },
    });
    expect(callers?.arguments.symbolId).toMatchObject({
      $fact: {
        field: 'symbolId',
        match: { kind: 'symbol-handle', name: 'computeImpact' },
      },
    });
  });

  it('extracts synthetic declaration/reference response facts without fixed truth', () => {
    expect(
      extractDeclarationSearchFacts({
        data: {
          declarations: [
            {
              declarationId: 'd1|synthetic',
              filePath: 'synthetic/definition.ts',
              kind: 'class',
              name: 'Synthetic',
            },
          ],
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          declarationId: 'd1|synthetic',
          kind: 'declaration-handle',
        }),
        { kind: 'file', path: 'synthetic/definition.ts', role: 'declaration' },
      ]),
    );
    expect(
      extractReferenceFacts({
        data: {
          references: [
            {
              basis: 'compiler',
              confidence: 'high',
              filePath: 'synthetic/reference.ts',
              kind: 'type',
              targetName: 'Synthetic',
            },
          ],
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        {
          kind: 'file',
          path: 'synthetic/reference.ts',
          role: 'declaration-reference',
        },
      ]),
    );
  });

  it('does not mislabel the queried depth-zero symbol as its own caller', () => {
    expect(
      extractCallerFileFacts({
        data: {
          nodes: [
            { depth: 0, symbol: { filePath: 'target.ts' } },
            { depth: 1, symbol: { filePath: 'caller.ts' } },
          ],
        },
      }),
    ).toEqual([{ kind: 'file', path: 'caller.ts', role: 'caller' }]);
  });

  it('finds every durable anchor in a real bounded dogfood control run', async () => {
    const result = await runTaskArm(entrypointTraceDogfoodTask, 'control');

    expect(result.assertions.passed).toBe(true);
    expect(result.record.legs[0]?.steps).toHaveLength(2);
    expect(result.record.legs[0]?.steps.every((step) => !step.truncated)).toBe(true);
  });
});
