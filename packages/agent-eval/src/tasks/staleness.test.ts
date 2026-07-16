import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { customerStalenessGroundTruth } from '../ground-truth/customer-staleness.js';

import {
  extractCallerFacts,
  extractNativeMatchFacts,
  extractSearchSymbolFacts,
  stalenessAddCallerTask,
  stalenessDeleteSymbolTask,
  stalenessTasks,
} from './staleness.js';

const fixtureRoot = new URL('../../__fixtures__/customer-staleness/', import.meta.url).pathname;

describe('staleness tasks', () => {
  it('declares valid add/delete preconditions against the committed fixture', () => {
    const truth = customerStalenessGroundTruth;
    expect(existsSync(join(fixtureRoot, truth.addCaller.filePath))).toBe(false);
    expect(existsSync(join(fixtureRoot, truth.deleteTarget.filePath))).toBe(true);
    expect(stalenessTasks).toHaveLength(2);
    expect(stalenessTasks.every((task) => Object.isFrozen(task))).toBe(true);
  });

  it('keeps edit legs isolated and recovery bounded to one refresh', () => {
    for (const task of stalenessTasks) {
      expect(task.strategies.control.steps.every((step) => step.leg === 'pre-edit')).toBe(true);
      expect(task.strategies.opensip.steps.every((step) => step.leg === 'pre-edit')).toBe(true);
      expect(task.staleness?.postEditSteps.control.every((step) => step.leg === 'post-edit')).toBe(
        true,
      );
      expect(task.staleness?.postEditSteps.opensip.every((step) => step.leg === 'post-edit')).toBe(
        true,
      );
      expect(task.staleness?.recoverySteps?.control).toEqual([]);
      const recovery = task.staleness?.recoverySteps?.opensip ?? [];
      expect(recovery.filter((step) => step.tool === 'refresh_graph')).toHaveLength(1);
      expect(recovery[0]?.tool).toBe('refresh_graph');
      expect(recovery.every((step) => step.leg === 'recovery')).toBe(true);
    }
  });

  it('re-resolves symbol identity after every edit and never calls who_calls with an old id', () => {
    const addPost = stalenessAddCallerTask.staleness?.postEditSteps.opensip ?? [];
    const addRecovery = stalenessAddCallerTask.staleness?.recoverySteps?.opensip ?? [];
    const postCaller = addPost.find((step) => step.tool === 'who_calls');
    const recoveryCaller = addRecovery.find((step) => step.tool === 'who_calls');
    expect(postCaller?.arguments.symbolId).toMatchObject({
      $fact: { stepId: 'opensip-post-add-symbol' },
    });
    expect(recoveryCaller?.arguments.symbolId).toMatchObject({
      $fact: { stepId: 'opensip-recovery-add-symbol' },
    });

    const deleteRecovery = stalenessDeleteSymbolTask.staleness?.recoverySteps?.opensip ?? [];
    expect(deleteRecovery.map((step) => step.tool)).toEqual(['refresh_graph', 'search_symbols']);
    expect(deleteRecovery.some((step) => step.tool === 'who_calls')).toBe(false);
  });

  it('requires an exact symbol projection before proving the deleted target absent', () => {
    const search = stalenessDeleteSymbolTask.staleness?.postEditSteps.opensip.find(
      (step) => step.tool === 'search_symbols',
    );
    expect(
      search?.assessProofClosure?.({
        data: { detail: 'nodes', symbols: [], totalMatches: 0 },
      }),
    ).toMatchObject({ domainExhausted: true, projectionComplete: true });

    const baseSymbol = {
      bodyHash: 'body',
      column: 0,
      definedInGenerated: false,
      filePath: customerStalenessGroundTruth.targetFile,
      inTestFile: false,
      kind: 'function-declaration',
      line: 1,
      package: '@fixture/customer-staleness',
      qualifiedName: customerStalenessGroundTruth.targetSymbol,
      simpleName: customerStalenessGroundTruth.targetSymbol,
      symbolId: `${customerStalenessGroundTruth.targetFile}:1:0`,
      visibility: 'module-local',
    };
    for (const symbol of [
      { ...baseSymbol, filePath: undefined },
      { ...baseSymbol, simpleName: undefined },
      { ...baseSymbol, symbolId: '' },
    ]) {
      expect(
        search?.assessProofClosure?.({
          data: { detail: 'nodes', symbols: [symbol], totalMatches: 1 },
        }),
      ).toMatchObject({ domainExhausted: false, projectionComplete: false });
    }
  });

  it('extracts only synthetic response facts and never task ground truth', () => {
    expect(
      extractNativeMatchFacts({
        matches: [{ path: 'synthetic/new.ts', line: 1, text: 'x' }],
      }),
    ).toEqual([{ kind: 'file', path: 'synthetic/new.ts', role: 'match' }]);
    expect(
      extractSearchSymbolFacts({
        data: {
          symbols: [
            {
              filePath: 'synthetic/target.ts',
              simpleName: 'syntheticTarget',
              symbolId: 'synthetic:1:0',
            },
          ],
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'symbol-handle',
          symbolId: 'synthetic:1:0',
        }),
        {
          kind: 'file',
          path: 'synthetic/target.ts',
          role: 'symbol-definition',
        },
      ]),
    );
    expect(
      extractCallerFacts({
        data: {
          nodes: [
            {
              depth: 1,
              incomingEvidence: {
                confidence: 'low',
                kind: 'call',
                resolution: 'dynamic',
              },
              symbol: {
                filePath: 'synthetic/caller.ts',
                simpleName: 'syntheticCaller',
                symbolId: 'synthetic:2:0',
              },
            },
          ],
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        { kind: 'file', path: 'synthetic/caller.ts', role: 'caller' },
        expect.objectContaining({ confidence: 'low', kind: 'evidence' }),
      ]),
    );
    expect(
      extractCallerFacts({
        data: {
          nodes: [
            {
              depth: 0,
              symbol: { filePath: 'synthetic/target.ts', symbolId: 'target' },
            },
            {
              depth: 1,
              symbol: { filePath: 'synthetic/caller.ts', symbolId: 'caller' },
            },
          ],
        },
      }),
    ).toEqual(
      expect.not.arrayContaining([{ kind: 'file', path: 'synthetic/target.ts', role: 'caller' }]),
    );
  });

  it('uses an exhaustive exact search as the deletion recovery proof', () => {
    const search = stalenessDeleteSymbolTask.staleness?.recoverySteps?.opensip.at(-1);
    expect(search).toMatchObject({
      arguments: {
        detail: 'nodes',
        filePath: customerStalenessGroundTruth.deleteTarget.filePath,
        match: 'exact',
        query: customerStalenessGroundTruth.deleteTarget.symbolExpectedAbsent,
      },
      expectedNonEmpty: false,
      provesAbsence: [
        {
          kind: 'file',
          path: customerStalenessGroundTruth.deleteTarget.filePath,
        },
      ],
      tool: 'search_symbols',
    });
  });
});
