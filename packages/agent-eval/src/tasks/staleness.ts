import { customerStalenessGroundTruth } from '../ground-truth/customer-staleness.js';
import { deepFreeze } from '../model/value-helpers.js';

import {
  assessNativeGlobProofDomain,
  createExactSymbolSearchProofAssessor,
} from './proof-closure.js';
import {
  extractCallerFacts,
  extractNativeMatchFacts,
  extractNativePathFacts,
  extractRefreshFacts,
  extractSearchSymbolFacts,
} from './staleness-extractors.js';

export {
  extractCallerFacts,
  extractNativeMatchFacts,
  extractNativePathFacts,
  extractRefreshFacts,
  extractSearchSymbolFacts,
} from './staleness-extractors.js';

import type { Arm, GoldTask, RunLeg, StrategyStep } from '../model/task.js';

const truth = customerStalenessGroundTruth;
const TARGET_FILE = truth.targetFile;
const TARGET_SYMBOL = truth.targetSymbol;
const STRATEGY_VERSIONS: Readonly<Record<Arm, string>> = {
  control: 'native-v3-exact-proof-closure',
  opensip: 'mcp-epoch-4-v3-exact-proof-closure',
};

function nativeCallerStep(id: string, leg: RunLeg): StrategyStep {
  return {
    arguments: {
      glob: '**/*.ts',
      maxFileBytes: 1_048_576,
      maxMatches: 200,
      maxTotalBytes: 8_388_608,
      maxWalkedFiles: 20_000,
      pattern: TARGET_SYMBOL,
    },
    expectedNonEmpty: true,
    extract: extractNativeMatchFacts,
    id,
    leg,
    rationale: `Search current source bytes for ${TARGET_SYMBOL} references.`,
    tool: 'contentSearch',
  };
}

function searchSymbolStep(id: string, leg: RunLeg, expectedNonEmpty: boolean): StrategyStep {
  return {
    arguments: {
      detail: 'nodes',
      filePath: TARGET_FILE,
      generated: 'exclude',
      limit: 20,
      match: 'exact',
      query: TARGET_SYMBOL,
      sourceScope: 'production',
    },
    assessProofClosure: createExactSymbolSearchProofAssessor({
      filePath: TARGET_FILE,
      query: TARGET_SYMBOL,
    }),
    expectedNonEmpty,
    extract: extractSearchSymbolFacts,
    id,
    leg,
    ...(expectedNonEmpty ? {} : { provesAbsence: [{ kind: 'file' as const, path: TARGET_FILE }] }),
    rationale: `Resolve the current exact ${TARGET_SYMBOL} occurrence before traversing.`,
    tool: 'search_symbols',
  };
}

function callerStep(id: string, leg: RunLeg, searchStepId: string): StrategyStep {
  return {
    arguments: {
      depth: 1,
      detail: 'nodes',
      generated: 'exclude',
      identity: 'occurrence',
      limit: 200,
      sourceScope: 'production',
      symbolId: {
        $fact: {
          field: 'symbolId',
          match: {
            filePath: TARGET_FILE,
            kind: 'symbol-handle',
            name: TARGET_SYMBOL,
          },
          select: 'only',
          stepId: searchStepId,
        },
      },
    },
    expectedNonEmpty: true,
    extract: extractCallerFacts,
    id,
    leg,
    rationale: `Use the response-derived ${TARGET_SYMBOL} identity to query current callers.`,
    tool: 'who_calls',
  };
}

function refreshStep(id: string): StrategyStep {
  return {
    arguments: {},
    expectedNonEmpty: true,
    extract: extractRefreshFacts,
    id,
    leg: 'recovery',
    proofRelevance: 'irrelevant',
    rationale: 'Refresh the stale catalog once before bounded recovery reads.',
    tool: 'refresh_graph',
  };
}

function nativeDeletedTargetStep(id: string): StrategyStep {
  return {
    arguments: { maxResults: 10, maxWalkedFiles: 20_000, pattern: TARGET_FILE },
    assessProofClosure: assessNativeGlobProofDomain,
    expectedNonEmpty: false,
    extract: extractNativePathFacts,
    id,
    leg: 'post-edit',
    provesAbsence: [{ kind: 'file', path: TARGET_FILE }],
    rationale: 'Check the disposable workspace directly for the deleted target file.',
    tool: 'globList',
  };
}

const preEditControl = Object.freeze([nativeCallerStep('control-pre-callers', 'pre-edit')]);
const preEditOpenSipSearch = searchSymbolStep('opensip-pre-symbol', 'pre-edit', true);
const preEditOpenSip = Object.freeze([
  preEditOpenSipSearch,
  callerStep('opensip-pre-callers', 'pre-edit', preEditOpenSipSearch.id),
]);

function addCallerTask(): GoldTask {
  const postSearch = searchSymbolStep('opensip-post-add-symbol', 'post-edit', true);
  const recoverySearch = searchSymbolStep('opensip-recovery-add-symbol', 'recovery', true);
  const preCallerFiles = truth.preEditCallers.map((caller) => ({
    kind: 'file' as const,
    path: caller.filePath,
  }));
  const newCaller = { kind: 'file' as const, path: truth.addCaller.filePath };
  const task = {
    assertions: {
      scoped: [
        { leg: 'pre-edit', mustInclude: preCallerFiles },
        { leg: 'post-edit', mustInclude: [newCaller] },
        { leg: 'recovery', mustInclude: [newCaller] },
      ],
      staleness: { postEditLeg: 'post-edit', recoveryLeg: 'recovery' },
    },
    fixture: truth.fixture,
    id: 'staleness-add-caller.customer-staleness',
    question:
      `After adding ${truth.addCaller.symbol} in ${truth.addCaller.filePath}, ` +
      `which functions call ${TARGET_SYMBOL} from ${TARGET_FILE}?`,
    staleness: {
      edit: {
        operations: [
          {
            content: truth.addCaller.content,
            kind: 'write',
            path: truth.addCaller.filePath,
          },
        ],
      },
      postEditSteps: {
        control: [nativeCallerStep('control-post-add-callers', 'post-edit')],
        opensip: [postSearch, callerStep('opensip-post-add-callers', 'post-edit', postSearch.id)],
      },
      recoverySteps: {
        control: [],
        opensip: [
          refreshStep('opensip-refresh-add'),
          recoverySearch,
          callerStep('opensip-recovery-add-callers', 'recovery', recoverySearch.id),
        ],
      },
    },
    strategies: {
      control: {
        arm: 'control',
        steps: preEditControl,
        version: STRATEGY_VERSIONS.control,
      },
      opensip: {
        arm: 'opensip',
        steps: preEditOpenSip,
        version: STRATEGY_VERSIONS.opensip,
      },
    },
    tags: ['staleness', 'invalidating-edit'],
  } satisfies GoldTask;
  return deepFreeze(task);
}

function deleteTargetTask(): GoldTask {
  const postSearch = searchSymbolStep('opensip-post-delete-symbol', 'post-edit', false);
  const recoverySearch = searchSymbolStep('opensip-recovery-delete-symbol', 'recovery', false);
  const targetFile = {
    kind: 'file' as const,
    path: truth.deleteTarget.filePath,
  };
  const task = {
    assertions: {
      scoped: [
        { leg: 'pre-edit', mustInclude: [targetFile] },
        { leg: 'post-edit', mustExclude: [targetFile] },
        { leg: 'recovery', mustExclude: [targetFile] },
      ],
      staleness: { postEditLeg: 'post-edit', recoveryLeg: 'recovery' },
    },
    fixture: truth.fixture,
    id: 'staleness-delete-symbol.customer-staleness',
    question:
      `After deleting ${truth.deleteTarget.filePath}, does ${truth.deleteTarget.symbolExpectedAbsent} ` +
      'still exist in the current project?',
    staleness: {
      edit: {
        operations: [{ kind: 'delete', path: truth.deleteTarget.filePath }],
      },
      postEditSteps: {
        control: [nativeDeletedTargetStep('control-post-delete-target')],
        opensip: [postSearch],
      },
      recoverySteps: {
        control: [],
        opensip: [refreshStep('opensip-refresh-delete'), recoverySearch],
      },
    },
    strategies: {
      control: {
        arm: 'control',
        steps: preEditControl,
        version: STRATEGY_VERSIONS.control,
      },
      opensip: {
        arm: 'opensip',
        steps: preEditOpenSip,
        version: STRATEGY_VERSIONS.opensip,
      },
    },
    tags: ['staleness', 'deletion'],
  } satisfies GoldTask;
  return deepFreeze(task);
}

export const stalenessAddCallerTask = addCallerTask();
export const stalenessDeleteSymbolTask = deleteTargetTask();
export const stalenessTasks = Object.freeze([stalenessAddCallerTask, stalenessDeleteSymbolTask]);
