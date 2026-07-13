import { dogfoodGroundTruth } from '../ground-truth/dogfood.js';
import {
  deepFreeze,
  isUnknownRecord as isRecord,
  parseJsonRecord,
  uniqueFacts,
} from '../model/value-helpers.js';

import type { AnswerFact, GoldTask, ResponseExtractor, StrategyStep } from '../model/task.js';

const RUN_SCOPE = dogfoodGroundTruth.anchors[0];
const COMPUTE_IMPACT = dogfoodGroundTruth.anchors[1];

function dataArray(payload: unknown, key: string): readonly unknown[] {
  if (!isRecord(payload) || !isRecord(payload.data)) return [];
  const value = payload.data[key];
  return Array.isArray(value) ? value : [];
}

function nativePayloadPaths(payload: Readonly<Record<string, unknown>>): readonly unknown[] {
  if (Array.isArray(payload.paths)) return payload.paths;
  if (!Array.isArray(payload.matches)) return [];
  return payload.matches.flatMap((match) =>
    isRecord(match) && typeof match.path === 'string' ? [match.path] : [],
  );
}

const extractNativePaths: ResponseExtractor = (payload) => {
  if (!isRecord(payload)) return [];
  const paths = nativePayloadPaths(payload);
  return uniqueFacts(
    paths.flatMap((path): readonly AnswerFact[] =>
      typeof path === 'string' ? [{ kind: 'file', path }] : [],
    ),
  );
};

const extractManifestFacts: ResponseExtractor = (payload) => {
  if (!isRecord(payload) || typeof payload.content !== 'string') return [];
  const manifest = parseJsonRecord(payload.content);
  if (!isRecord(manifest)) return [];
  const facts: AnswerFact[] = [];
  if (typeof manifest.packageManager === 'string') {
    const manager = manifest.packageManager.split('@')[0];
    if (manager !== undefined && manager.length > 0) {
      facts.push({ kind: 'text', label: 'package-manager', value: manager });
    }
  }
  if (isRecord(manifest.scripts)) {
    for (const script of ['build', 'test'] as const) {
      if (typeof manifest.scripts[script] === 'string') {
        facts.push({
          command: `pnpm ${script}`,
          kind: 'command',
          purpose: script,
        });
      }
    }
  }
  return facts;
};

const extractArchitectureFacts: ResponseExtractor = (payload) => {
  if (!isRecord(payload) || !isRecord(payload.data)) return [];
  const facts: AnswerFact[] = [];
  const languages = payload.data.languages;
  if (Array.isArray(languages)) {
    facts.push(
      ...languages.flatMap((language): readonly AnswerFact[] =>
        typeof language === 'string' ? [{ kind: 'text', label: 'language', value: language }] : [],
      ),
    );
  }
  if (isRecord(payload.data.packageCount) && typeof payload.data.packageCount.value === 'number') {
    facts.push({
      kind: 'count',
      label: 'architecture-packages',
      value: payload.data.packageCount.value,
    });
  }
  return facts;
};

const extractPackageFacts: ResponseExtractor = (payload) => {
  const rows = [...dataArray(payload, 'calls'), ...dataArray(payload, 'imports')];
  return uniqueFacts(
    rows.flatMap((candidate): readonly AnswerFact[] => {
      if (!isRecord(candidate)) return [];
      return [candidate.fromPackage, candidate.toPackage].flatMap((name): readonly AnswerFact[] =>
        typeof name === 'string' ? [{ kind: 'package', name }] : [],
      );
    }),
  );
};

function declarationFacts(candidate: Readonly<Record<string, unknown>>): readonly AnswerFact[] {
  if (typeof candidate.declarationId !== 'string') return [];
  const filePath = typeof candidate.filePath === 'string' ? candidate.filePath : undefined;
  const name = typeof candidate.name === 'string' ? candidate.name : undefined;
  return [
    {
      ...(typeof candidate.column === 'number' ? { column: candidate.column } : {}),
      declarationId: candidate.declarationId,
      ...(typeof candidate.kind === 'string' ? { declarationKind: candidate.kind } : {}),
      ...(filePath === undefined ? {} : { filePath }),
      kind: 'declaration-handle',
      ...(typeof candidate.line === 'number' ? { line: candidate.line } : {}),
      ...(name === undefined ? {} : { name }),
      ...(typeof candidate.package === 'string' ? { package: candidate.package } : {}),
    },
    ...(filePath === undefined
      ? []
      : [{ kind: 'file' as const, path: filePath, role: 'declaration' }]),
  ];
}

export const extractDeclarationSearchFacts: ResponseExtractor = (payload) =>
  uniqueFacts(
    dataArray(payload, 'declarations').flatMap((candidate) =>
      isRecord(candidate) ? declarationFacts(candidate) : [],
    ),
  );

export const extractReferenceFacts: ResponseExtractor = (payload) =>
  uniqueFacts(
    dataArray(payload, 'references').flatMap((candidate): readonly AnswerFact[] => {
      if (!isRecord(candidate) || typeof candidate.filePath !== 'string') return [];
      const subject =
        typeof candidate.targetName === 'string' ? candidate.targetName : candidate.filePath;
      return [
        {
          kind: 'file',
          path: candidate.filePath,
          role: 'declaration-reference',
        },
        {
          ...(typeof candidate.confidence === 'string' ? { confidence: candidate.confidence } : {}),
          ...(typeof candidate.kind === 'string' ? { evidenceKind: candidate.kind } : {}),
          filePath: candidate.filePath,
          kind: 'evidence',
          ...(typeof candidate.basis === 'string' ? { resolution: candidate.basis } : {}),
          subject,
        },
      ];
    }),
  );

function callableSymbolFacts(candidate: Readonly<Record<string, unknown>>): readonly AnswerFact[] {
  if (typeof candidate.symbolId !== 'string') return [];
  const filePath = typeof candidate.filePath === 'string' ? candidate.filePath : undefined;
  const name = typeof candidate.simpleName === 'string' ? candidate.simpleName : undefined;
  return [
    {
      ...(typeof candidate.bodyHash === 'string' ? { bodyHash: candidate.bodyHash } : {}),
      ...(filePath === undefined ? {} : { filePath }),
      ...(typeof candidate.inTestFile === 'boolean' ? { inTestFile: candidate.inTestFile } : {}),
      kind: 'symbol-handle',
      ...(name === undefined ? {} : { name }),
      ...(typeof candidate.package === 'string' ? { package: candidate.package } : {}),
      symbolId: candidate.symbolId,
    },
    ...(filePath === undefined
      ? []
      : [{ kind: 'file' as const, path: filePath, role: 'symbol-definition' }]),
  ];
}

export const extractCallableSearchFacts: ResponseExtractor = (payload) =>
  uniqueFacts(
    dataArray(payload, 'symbols').flatMap((candidate) =>
      isRecord(candidate) ? callableSymbolFacts(candidate) : [],
    ),
  );

export const extractCallerFileFacts: ResponseExtractor = (payload) =>
  uniqueFacts(
    dataArray(payload, 'nodes').flatMap((candidate): readonly AnswerFact[] => {
      if (
        !isRecord(candidate) ||
        typeof candidate.depth !== 'number' ||
        candidate.depth <= 0 ||
        !isRecord(candidate.symbol)
      ) {
        return [];
      }
      return typeof candidate.symbol.filePath === 'string'
        ? [{ kind: 'file', path: candidate.symbol.filePath, role: 'caller' }]
        : [];
    }),
  );

function orientControlSteps(): readonly StrategyStep[] {
  return [
    {
      arguments: { maxResults: 200, maxWalkedFiles: 20_000, pattern: '*' },
      expectedNonEmpty: true,
      extract: extractNativePaths,
      id: 'dogfood-control-root-files',
      rationale: 'Inventory root manifests and lockfiles from the repository bytes.',
      tool: 'globList',
    },
    {
      arguments: { maxBytes: 262_144, path: 'package.json' },
      expectedNonEmpty: true,
      extract: extractManifestFacts,
      id: 'dogfood-control-package-manifest',
      rationale: 'Prefer executable root scripts and packageManager over prose.',
      tool: 'readFile',
    },
  ];
}

function orientOpenSipSteps(): readonly StrategyStep[] {
  return [
    {
      arguments: {
        limit: 100,
        sections: ['metrics', 'packageEdges'],
        topN: 100,
      },
      expectedNonEmpty: true,
      extract: extractArchitectureFacts,
      id: 'dogfood-opensip-architecture',
      rationale: 'Read the bounded labelled architecture overview first.',
      tool: 'get_architecture',
    },
    {
      arguments: {
        direction: 'both',
        edgeKind: 'combined',
        limit: 200,
        sampleLimit: 0,
      },
      expectedNonEmpty: true,
      extract: extractPackageFacts,
      id: 'dogfood-opensip-package-dependencies',
      rationale: 'Follow the architecture overview with labelled package inventory.',
      tool: 'package_dependencies',
    },
  ];
}

function traceControlSteps(): readonly StrategyStep[] {
  return [RUN_SCOPE.symbol, COMPUTE_IMPACT.symbol].map((symbol): StrategyStep => ({
    arguments: {
      glob: '**/*.ts',
      maxFileBytes: 1_048_576,
      maxMatches: 2000,
      maxTotalBytes: 8_388_608,
      maxWalkedFiles: 20_000,
      pattern: `\\b${symbol}\\b`,
    },
    expectedNonEmpty: true,
    extract: extractNativePaths,
    id: `dogfood-control-${symbol}-search`,
    rationale: `Search definitions and references for the named ${symbol} repository anchor.`,
    tool: 'contentSearch',
  }));
}

function traceOpenSipSteps(): readonly StrategyStep[] {
  return [
    {
      arguments: {
        detail: 'nodes',
        kinds: ['class'],
        limit: 20,
        match: 'exact',
        query: RUN_SCOPE.symbol,
        sourceScope: 'production',
      },
      expectedNonEmpty: true,
      extract: extractDeclarationSearchFacts,
      id: 'dogfood-opensip-run-scope-declaration',
      rationale: 'Resolve the class declaration identity before asking for type references.',
      tool: 'search_declarations',
    },
    {
      arguments: {
        declarationId: {
          $fact: {
            field: 'declarationId',
            match: {
              kind: 'declaration-handle',
              name: RUN_SCOPE.symbol,
            },
            select: 'only',
            stepId: 'dogfood-opensip-run-scope-declaration',
          },
        },
        detail: 'nodes',
        limit: 200,
        sourceScope: 'production',
      },
      expectedNonEmpty: true,
      extract: extractReferenceFacts,
      id: 'dogfood-opensip-run-scope-references',
      rationale: 'Use the response-derived declaration id only with references_to.',
      tool: 'references_to',
    },
    {
      arguments: {
        detail: 'nodes',
        limit: 20,
        match: 'exact',
        query: COMPUTE_IMPACT.symbol,
        sourceScope: 'production',
      },
      expectedNonEmpty: true,
      extract: extractCallableSearchFacts,
      id: 'dogfood-opensip-compute-impact-symbol',
      rationale: 'Resolve the callable computeImpact occurrence independently.',
      tool: 'search_symbols',
    },
    {
      arguments: {
        depth: 5,
        detail: 'nodes',
        identity: 'occurrence',
        limit: 200,
        sourceScope: 'production',
        symbolId: {
          $fact: {
            field: 'symbolId',
            match: {
              kind: 'symbol-handle',
              name: COMPUTE_IMPACT.symbol,
            },
            select: 'only',
            stepId: 'dogfood-opensip-compute-impact-symbol',
          },
        },
      },
      expectedNonEmpty: true,
      extract: extractCallerFileFacts,
      id: 'dogfood-opensip-compute-impact-callers',
      rationale: 'Use the response-derived callable identity only with who_calls.',
      tool: 'who_calls',
    },
  ];
}

export const orientDogfoodTask = deepFreeze({
  assertions: {
    mustInclude: [
      {
        kind: 'text',
        label: 'package-manager',
        value: dogfoodGroundTruth.packageManager,
      },
      { kind: 'file', path: dogfoodGroundTruth.lockfile },
      { kind: 'file', path: 'turbo.json' },
      { command: dogfoodGroundTruth.buildCommand, kind: 'command' },
      { command: dogfoodGroundTruth.testCommand, kind: 'command' },
    ],
  },
  fixture: 'dogfood',
  id: 'orient.dogfood',
  question:
    'Identify this repository package manager, lockfile, build system, and executable build/test commands.',
  strategies: {
    control: {
      arm: 'control',
      steps: orientControlSteps(),
      version: 'native-v1',
    },
    opensip: {
      arm: 'opensip',
      steps: orientOpenSipSteps(),
      version: 'mcp-epoch-4-v1',
    },
  },
  tags: ['dogfood', 'orientation', 'read-only'],
} satisfies GoldTask);

export const entrypointTraceDogfoodTask = deepFreeze({
  assertions: {
    mustInclude: [
      { kind: 'file', path: RUN_SCOPE.definingFile },
      ...RUN_SCOPE.referenceFiles.slice(0, 2).map((path) => ({ kind: 'file' as const, path })),
      { kind: 'file', path: COMPUTE_IMPACT.definingFile },
      ...COMPUTE_IMPACT.referenceFiles.map((path) => ({
        kind: 'file' as const,
        path,
      })),
    ],
  },
  fixture: 'dogfood',
  id: 'entrypoint-trace.dogfood',
  question:
    `Locate ${RUN_SCOPE.symbol} and ${COMPUTE_IMPACT.symbol}, then identify representative ` +
    'cross-file references/callers for both anchors.',
  strategies: {
    control: {
      arm: 'control',
      steps: traceControlSteps(),
      version: 'native-v1',
    },
    opensip: {
      arm: 'opensip',
      steps: traceOpenSipSteps(),
      version: 'mcp-epoch-4-v1',
    },
  },
  tags: ['dogfood', 'entrypoint-trace', 'read-only'],
} satisfies GoldTask);

export const dogfoodTasks: readonly GoldTask[] = Object.freeze([
  orientDogfoodTask,
  entrypointTraceDogfoodTask,
]);
