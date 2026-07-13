import { deepFreeze, isUnknownRecord as isRecord, uniqueStrings } from '../model/value-helpers.js';

import { asNativeReadPayload, nativeSearchMatches } from './native-response.js';
import { projectJsonManifest } from './native-task-response-extractors.js';
import { extractArchitecture, extractPackageDependencies } from './orient-mcp-extractors.js';
import { assessJsonManifestProofDomain, assessNativeGlobProofDomain } from './proof-closure.js';

import type { AnswerFact, GoldTask, ResponseExtractor, StrategyStep } from '../model/task.js';

const CONTROL_STRATEGY_VERSION = 'control-native-v4-manifest-proof-closure';
const OPENSIP_STRATEGY_VERSION = 'opensip-mcp-epoch-4';
const STALE_MOCHA_COMMAND = 'npx mocha "test/**/*.spec.ts"';

function globPaths(payload: unknown): readonly string[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.paths)) return undefined;
  if (payload.paths.some((path) => typeof path !== 'string')) return undefined;
  return payload.paths as readonly string[];
}

function extractRootFiles(payload: unknown): readonly AnswerFact[] {
  const paths = globPaths(payload);
  if (paths === undefined) return [];
  return paths.map((path) => ({
    kind: 'file',
    path,
    role: 'root-file',
  }));
}

function extractPackageManifestInventory(payload: unknown): readonly AnswerFact[] {
  const paths = globPaths(payload);
  if (paths === undefined) return [];
  const manifests = uniqueStrings(
    paths.filter((path) => path === 'package.json' || path.endsWith('/package.json')),
  );
  return [
    ...manifests.map((path): AnswerFact => ({
      kind: 'file',
      path,
      role: 'package-manifest',
    })),
    { kind: 'count', label: 'packages', value: manifests.length },
  ];
}

interface ManifestExtractionOptions {
  readonly includePackageName: boolean;
}

function commandFacts(scripts: unknown): readonly AnswerFact[] {
  if (!isRecord(scripts)) return [];
  const facts: AnswerFact[] = [];
  if (typeof scripts.build === 'string') {
    facts.push({ command: scripts.build, kind: 'command', purpose: 'build' });
  }
  if (typeof scripts.test === 'string') {
    facts.push({ command: scripts.test, kind: 'command', purpose: 'test' });
  }
  return facts;
}

function manifestExtractor(options: ManifestExtractionOptions): ResponseExtractor {
  return (payload) => {
    const projection = projectJsonManifest(payload);
    if (projection === undefined) return [];
    const { manifest } = projection;

    const facts: AnswerFact[] = [
      { kind: 'file', path: projection.path, role: 'package-manifest' },
      ...commandFacts(manifest.scripts),
    ];
    if (typeof manifest.packageManager === 'string') {
      const separator = manifest.packageManager.lastIndexOf('@');
      const packageManager =
        separator > 0 ? manifest.packageManager.slice(0, separator) : manifest.packageManager;
      facts.push(
        { kind: 'text', label: 'package-manager', value: packageManager },
        {
          kind: 'text',
          label: 'package-manager-declaration',
          value: manifest.packageManager,
        },
      );
    }
    if (options.includePackageName && typeof manifest.name === 'string') {
      facts.push({ kind: 'package', name: manifest.name });
    }
    return facts;
  };
}

function extractWorkspaceDefinition(payload: unknown): readonly AnswerFact[] {
  const result = asNativeReadPayload(payload);
  if (result === undefined) return [];
  const patterns = [...result.content.matchAll(/^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/gmu)].map(
    (match) => match[1],
  );
  return [
    { kind: 'file', path: result.path, role: 'workspace-definition' },
    ...patterns.flatMap((pattern): readonly AnswerFact[] =>
      pattern === undefined ? [] : [{ kind: 'text', label: 'workspace-pattern', value: pattern }],
    ),
  ];
}

function packageNameFromManifestLine(line: string): string | undefined {
  const match = /["']name["']\s*:\s*["']([^"']+)["']/u.exec(line);
  return match?.[1];
}

function extractWorkspacePackages(payload: unknown): readonly AnswerFact[] {
  const matches = nativeSearchMatches(payload);
  if (matches === undefined) return [];
  const packages = uniqueStrings(
    matches.flatMap(({ text }) => {
      const name = packageNameFromManifestLine(text);
      return name === undefined ? [] : [name];
    }),
  );
  const manifestPaths = uniqueStrings(matches.map(({ path }) => path));
  return [
    ...manifestPaths.map((path): AnswerFact => ({
      kind: 'file',
      path,
      role: 'package-manifest',
    })),
    ...packages.map((name): AnswerFact => ({ kind: 'package', name })),
    { kind: 'count', label: 'packages', value: packages.length },
  ];
}

function rootFileBinding(path: string, stepId: string) {
  return {
    $fact: {
      field: 'path' as const,
      match: { kind: 'file' as const, path, role: 'root-file' },
      select: 'only' as const,
      stepId,
    },
  };
}

function controlCustomerTsSteps(): readonly StrategyStep[] {
  return [
    {
      arguments: { maxResults: 100, pattern: '*' },
      expectedNonEmpty: true,
      extract: extractRootFiles,
      id: 'control-discover-root',
      proofRelevance: 'irrelevant',
      rationale: 'Inventory bounded root files before trusting prose about project commands.',
      tool: 'globList',
    },
    {
      arguments: { maxResults: 5, pattern: 'package.json' },
      assessProofClosure: assessNativeGlobProofDomain,
      expectedNonEmpty: true,
      extract: extractPackageManifestInventory,
      id: 'control-discover-package-manifests',
      rationale: 'Count observed manifests instead of assuming the repository is a workspace.',
      tool: 'globList',
    },
    {
      arguments: {
        maxBytes: 65_536,
        path: {
          $fact: {
            field: 'path',
            match: {
              kind: 'file',
              path: 'package.json',
              role: 'package-manifest',
            },
            select: 'only',
            stepId: 'control-discover-package-manifests',
          },
        },
      },
      assessProofClosure: assessJsonManifestProofDomain,
      expectedNonEmpty: true,
      extract: manifestExtractor({ includePackageName: true }),
      id: 'control-read-root-manifest',
      provesAbsence: [{ kind: 'command', purpose: 'test' }],
      rationale: 'Read package-manager and build/test commands from the authoritative manifest.',
      tool: 'readFile',
    },
  ];
}

function controlWorkspaceSteps(): readonly StrategyStep[] {
  return [
    {
      arguments: { maxResults: 100, pattern: '*' },
      expectedNonEmpty: true,
      extract: extractRootFiles,
      id: 'control-discover-root',
      rationale: 'Inventory root manifests, lockfiles, and workspace declarations first.',
      tool: 'globList',
    },
    {
      arguments: {
        maxBytes: 65_536,
        path: rootFileBinding('package.json', 'control-discover-root'),
      },
      expectedNonEmpty: true,
      extract: manifestExtractor({ includePackageName: false }),
      id: 'control-read-root-manifest',
      rationale: 'Take package-manager and command truth from the root manifest.',
      tool: 'readFile',
    },
    {
      arguments: {
        maxBytes: 65_536,
        path: rootFileBinding('pnpm-workspace.yaml', 'control-discover-root'),
      },
      expectedNonEmpty: true,
      extract: extractWorkspaceDefinition,
      id: 'control-read-workspace-definition',
      rationale: 'Read the discovered pnpm workspace declaration before enumerating packages.',
      tool: 'readFile',
    },
    {
      arguments: {
        glob: 'packages/*/package.json',
        maxMatches: 20,
        maxTotalBytes: 131_072,
        maxWalkedFiles: 1000,
        pattern: '["\u0027]name["\u0027]\\s*:',
      },
      expectedNonEmpty: true,
      extract: extractWorkspacePackages,
      id: 'control-read-workspace-package-names',
      rationale: 'Enumerate names from the bounded package manifests selected by the workspace.',
      tool: 'contentSearch',
    },
  ];
}

function opensipOrientSteps(expectDependencies: boolean): readonly StrategyStep[] {
  return [
    {
      arguments: {
        generated: 'exclude',
        limit: 100,
        sections: ['metrics'],
        sourceScope: 'production',
        topN: 20,
      },
      expectedNonEmpty: true,
      extract: extractArchitecture,
      id: 'opensip-read-architecture',
      rationale: 'Use the published architecture read for labelled package and language counts.',
      tool: 'get_architecture',
    },
    {
      arguments: {
        direction: 'both',
        edgeKind: 'combined',
        generated: 'exclude',
        limit: 100,
        sampleLimit: 0,
        sourceScope: 'production',
      },
      expectedNonEmpty: expectDependencies,
      extract: extractPackageDependencies,
      id: 'opensip-read-package-dependencies',
      rationale: 'Use labelled package edges to recover package identities visible in the graph.',
      tool: 'package_dependencies',
    },
  ];
}

export const orientCustomerTsTask = deepFreeze({
  assertions: {
    mustExclude: [{ command: STALE_MOCHA_COMMAND, kind: 'command', purpose: 'test' }],
    mustInclude: [
      { kind: 'text', label: 'package-manager', value: 'pnpm' },
      {
        kind: 'text',
        label: 'package-manager-declaration',
        value: 'pnpm@11.10.0',
      },
      { kind: 'file', path: 'pnpm-lock.yaml' },
      { kind: 'package', name: '@fixture/customer-ts' },
      { kind: 'count', label: 'packages', value: 1 },
      { command: 'tsc -p tsconfig.json', kind: 'command', purpose: 'build' },
      { command: 'vitest run', kind: 'command', purpose: 'test' },
    ],
  },
  fixture: 'customer-ts',
  id: 'orient.customer-ts',
  question:
    'Identify the customer project package manager, package topology, and authoritative build/test commands.',
  strategies: {
    control: {
      arm: 'control',
      steps: controlCustomerTsSteps(),
      version: CONTROL_STRATEGY_VERSION,
    },
    opensip: {
      arm: 'opensip',
      steps: opensipOrientSteps(false),
      version: OPENSIP_STRATEGY_VERSION,
    },
  },
  tags: ['orientation', 'manifest-authority', 'stale-readme'],
} as const satisfies GoldTask);

export const orientCustomerWorkspaceTask = deepFreeze({
  assertions: {
    mustInclude: [
      { kind: 'text', label: 'package-manager', value: 'pnpm' },
      {
        kind: 'text',
        label: 'package-manager-declaration',
        value: 'pnpm@11.10.0',
      },
      { kind: 'file', path: 'pnpm-lock.yaml' },
      { kind: 'file', path: 'pnpm-workspace.yaml' },
      { kind: 'count', label: 'packages', value: 4 },
      { kind: 'package', name: '@fixture/ws-api' },
      { kind: 'package', name: '@fixture/ws-core' },
      { kind: 'package', name: '@fixture/ws-tools' },
      { kind: 'package', name: '@fixture/ws-web' },
      { command: 'pnpm -r build', kind: 'command', purpose: 'build' },
      { command: 'vitest run', kind: 'command', purpose: 'test' },
    ],
  },
  fixture: 'customer-workspace',
  id: 'orient.customer-workspace',
  question:
    'Identify the pnpm workspace package topology and authoritative root build/test commands.',
  strategies: {
    control: {
      arm: 'control',
      steps: controlWorkspaceSteps(),
      version: CONTROL_STRATEGY_VERSION,
    },
    opensip: {
      arm: 'opensip',
      steps: opensipOrientSteps(true),
      version: OPENSIP_STRATEGY_VERSION,
    },
  },
  tags: ['orientation', 'workspace', 'manifest-authority'],
} as const satisfies GoldTask);

export const orientTasks = Object.freeze([
  orientCustomerTsTask,
  orientCustomerWorkspaceTask,
] as const);
