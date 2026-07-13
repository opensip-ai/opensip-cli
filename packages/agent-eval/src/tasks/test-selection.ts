import { customerPyGroundTruth } from '../ground-truth/customer-py.js';
import { customerTsGroundTruth } from '../ground-truth/customer-ts.js';
import {
  deepFreeze,
  escapeRegularExpression,
  isUnknownRecord as isRecord,
} from '../model/value-helpers.js';

import { createTestAndCallerFrontierProjection } from './native-frontier-extractors.js';
import {
  assessJsonManifestProofDomain,
  assessNativeReadProofDomain,
  createExactSymbolSearchProofAssessor,
} from './proof-closure.js';
import {
  extractFallbackFromManifest,
  extractSymbolSearch,
  extractTestCallers,
  projectTestCallers,
} from './task-response-extractors.js';

import type { TestMappingFact } from '../ground-truth/types.js';
import type {
  AnswerFactPattern,
  ArgumentTemplate,
  ArgumentTemplateValue,
  FactBinding,
  GoldTask,
  ProofClosureAssessment,
  StrategyStep,
} from '../model/task.js';

const SEARCH_LIMIT = 20;
const PAGE_LIMIT = 500;
const CONTROL_STRATEGY_VERSION = 'control-native-v4-lexical-proof-closure';
const OPENSIP_STRATEGY_VERSION = 'opensip-mcp-epoch-4-v4-exact-proof-closure';
const NATIVE_MAX_MATCHES = 200;
const NATIVE_MAX_WALKED_FILES = 20_000;
const NATIVE_MAX_FILE_BYTES = 1024 * 1024;
const NATIVE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const NATIVE_CONTEXT_LINES = 40;
const STALE_MOCHA_COMMAND = 'npx mocha "test/**/*.spec.ts"';
const OPENSIP_CALLER_DEPTH = 5;

interface TestSelectionConfig {
  readonly controlCallerHops: number;
  readonly fixture: 'customer-py' | 'customer-ts';
  readonly manifestPath: string;
  readonly mapping: TestMappingFact;
  readonly testGlobs: readonly string[];
}

function symbolBinding(stepId: string, name: string): FactBinding {
  return {
    $fact: {
      field: 'symbolId',
      match: { kind: 'symbol-handle', name },
      select: 'only',
      stepId,
    },
  };
}

function nativeSearchArguments(pattern: ArgumentTemplateValue): ArgumentTemplate {
  return {
    contextLines: NATIVE_CONTEXT_LINES,
    pattern,
    maxFileBytes: NATIVE_MAX_FILE_BYTES,
    maxMatches: NATIVE_MAX_MATCHES,
    maxTotalBytes: NATIVE_MAX_TOTAL_BYTES,
    maxWalkedFiles: NATIVE_MAX_WALKED_FILES,
  };
}

function callerPatternBinding(stepId: string): FactBinding {
  return {
    $fact: {
      field: 'value',
      match: { kind: 'text', label: 'caller-frontier-pattern' },
      select: 'only',
      stepId,
    },
  };
}

function closure(
  projectionComplete: boolean,
  domainExhausted: boolean,
  reasonCodes: readonly string[],
): ProofClosureAssessment {
  return { domainExhausted, projectionComplete, reasonCodes };
}

function assessMcpTestTraversal(payload: unknown): ProofClosureAssessment {
  if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.nodes)) {
    return closure(false, false, ['malformed-test-traversal']);
  }
  const nodes = payload.data.nodes;
  const callerProjection = projectTestCallers(payload);
  const malformedNode = !callerProjection.projectionComplete;
  const unresolved = payload.data.unresolved;
  const malformedUnresolved = !Array.isArray(unresolved);
  const hasUnresolved = Array.isArray(unresolved) && unresolved.length > 0;
  const depthBoundary = nodes.some(
    (node) =>
      isRecord(node) && typeof node.depth === 'number' && node.depth >= OPENSIP_CALLER_DEPTH,
  );
  const projectionComplete = !malformedNode && !malformedUnresolved && !hasUnresolved;
  return closure(projectionComplete, projectionComplete && !depthBoundary, [
    ...(malformedNode || malformedUnresolved ? ['malformed-test-traversal'] : []),
    ...(hasUnresolved ? ['unresolved-test-caller'] : []),
    ...(depthBoundary ? ['caller-depth-boundary'] : []),
  ]);
}

function fallbackManifestStep(config: TestSelectionConfig, prefix: string): StrategyStep {
  return {
    arguments: { maxBytes: NATIVE_MAX_FILE_BYTES, path: config.manifestPath },
    assessProofClosure:
      config.fixture === 'customer-ts'
        ? assessJsonManifestProofDomain
        : assessNativeReadProofDomain,
    expectedNonEmpty: true,
    extract: extractFallbackFromManifest,
    id: `${prefix}.fallback-manifest`,
    ...(config.fixture === 'customer-ts'
      ? {
          provesAbsence: [{ kind: 'command' as const, purpose: 'test-script' }],
        }
      : {}),
    rationale: 'Derive the conservative fallback only from the authoritative project manifest.',
    tool: 'readFile',
  };
}

function controlSteps(config: TestSelectionConfig): readonly StrategyStep[] {
  const prefix = `test-selection.${config.fixture}.control`;
  const targetPattern = `\\b${escapeRegularExpression(config.mapping.targetSymbol)}\\b`;
  const frontier = createTestAndCallerFrontierProjection(config.testGlobs);
  const firstStepId = `${prefix}.target-references`;
  const steps: StrategyStep[] = [
    fallbackManifestStep(config, prefix),
    {
      arguments: nativeSearchArguments(targetPattern),
      assessProofClosure: frontier.assessProofClosure,
      expectedNonEmpty: true,
      extract: frontier.extract,
      id: firstStepId,
      rationale:
        'Search bounded source and test context for direct references and the first outward caller frontier.',
      tool: 'contentSearch',
    },
  ];
  let priorStepId = firstStepId;
  for (let hop = 1; hop <= config.controlCallerHops; hop += 1) {
    const stepId = `${prefix}.caller-frontier-${String(hop)}`;
    steps.push({
      arguments: nativeSearchArguments(callerPatternBinding(priorStepId)),
      assessProofClosure: frontier.assessProofClosure,
      expectedNonEmpty: true,
      extract: frontier.extract,
      id: stepId,
      ...(hop === config.controlCallerHops
        ? {
            provesAbsence: (config.mapping.irrelevantTestFiles ?? []).map((path) => ({
              kind: 'file' as const,
              path,
              role: 'test',
            })),
          }
        : {}),
      rationale:
        'Follow only caller names derived from the preceding bounded response and retain matching tests.',
      tool: 'contentSearch',
    });
    priorStepId = stepId;
  }
  return steps;
}

function opensipSteps(config: TestSelectionConfig): readonly StrategyStep[] {
  const prefix = `test-selection.${config.fixture}.opensip`;
  const searchId = `${prefix}.search-target`;
  return [
    {
      arguments: {
        detail: 'nodes',
        generated: 'include',
        limit: SEARCH_LIMIT,
        match: 'exact',
        query: config.mapping.targetSymbol,
        sourceScope: 'all',
      },
      assessProofClosure: createExactSymbolSearchProofAssessor({
        query: config.mapping.targetSymbol,
      }),
      expectedNonEmpty: true,
      extract: extractSymbolSearch,
      id: searchId,
      rationale: 'Resolve the changed function to a response-derived symbol identity.',
      tool: 'search_symbols',
    },
    {
      arguments: {
        depth: OPENSIP_CALLER_DEPTH,
        detail: 'nodes',
        generated: 'include',
        identity: 'occurrence',
        limit: PAGE_LIMIT,
        sourceScope: 'all',
        symbolId: symbolBinding(searchId, config.mapping.targetSymbol),
      },
      assessProofClosure: assessMcpTestTraversal,
      expectedNonEmpty: true,
      extract: extractTestCallers,
      id: `${prefix}.test-callers`,
      provesAbsence: (config.mapping.irrelevantTestFiles ?? []).map((path) => ({
        kind: 'file' as const,
        path,
        role: 'test',
      })),
      rationale: 'Filter bounded caller nodes by their catalog-provided inTestFile metadata.',
      tool: 'who_calls',
    },
  ];
}

function makeTestSelectionTask(config: TestSelectionConfig): GoldTask {
  const mustInclude: readonly AnswerFactPattern[] = [
    ...config.mapping.testFiles.map((path) => ({
      kind: 'file' as const,
      path,
      role: 'test',
    })),
    { command: config.mapping.fallbackCommand, kind: 'command' },
  ];
  return deepFreeze({
    assertions: {
      mustInclude,
      mustExclude: [
        ...(config.mapping.irrelevantTestFiles ?? []).map((path) => ({
          kind: 'file' as const,
          path,
          role: 'test',
        })),
        ...(config.fixture === 'customer-ts'
          ? [
              {
                command: STALE_MOCHA_COMMAND,
                kind: 'command' as const,
                purpose: 'test-script',
              },
            ]
          : []),
      ],
    },
    fixture: config.fixture,
    id: `test-selection.${config.fixture}`,
    question: `Select the focused tests for a change to ${config.mapping.targetSymbol} in ${config.mapping.targetFile}, then give a conservative project-wide fallback command.`,
    strategies: {
      control: {
        arm: 'control',
        steps: controlSteps(config),
        version: CONTROL_STRATEGY_VERSION,
      },
      opensip: {
        arm: 'opensip',
        steps: opensipSteps(config),
        version: OPENSIP_STRATEGY_VERSION,
      },
    },
    tags: ['test-selection', 'before-baseline'],
  });
}

/** Frozen focused-test-selection instances consumed by the explicit task registry. */
export const testSelectionTasks: readonly GoldTask[] = deepFreeze([
  makeTestSelectionTask({
    controlCallerHops: 4,
    fixture: 'customer-ts',
    manifestPath: 'package.json',
    mapping: customerTsGroundTruth.testMappings[0],
    testGlobs: ['**/*.test.ts', '**/*.spec.ts'],
  }),
  makeTestSelectionTask({
    controlCallerHops: 1,
    fixture: 'customer-py',
    manifestPath: 'pyproject.toml',
    mapping: customerPyGroundTruth.testMappings[0],
    testGlobs: ['tests/test_*.py'],
  }),
]);
