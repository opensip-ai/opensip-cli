import { posix } from 'node:path';

import { customerPyGroundTruth } from '../ground-truth/customer-py.js';
import { customerTsGroundTruth } from '../ground-truth/customer-ts.js';
import { customerWorkspaceGroundTruth } from '../ground-truth/customer-workspace.js';
import { deepFreeze, escapeRegularExpression } from '../model/value-helpers.js';

import { extractImpactFiles } from './context-surface-extractors.js';
import {
  callerEvidenceSubject,
  extractAliasSourcePaths,
  extractCallableAliasesFromSource,
  extractDeclaredFunctionSymbols,
  extractNativeCallerCandidates,
  extractPackageManifestFacts,
  extractPackageManifestPaths,
  extractPackageNamesFromManifestMatches,
  extractSymbolSearch,
  extractTargetReferenceFiles,
  extractWhoCallers,
} from './task-response-extractors.js';

import type { ImpactTargetFact } from '../ground-truth/types.js';
import type { AnswerFactPattern, FactBinding, GoldTask, StrategyStep } from '../model/task.js';

const SEARCH_LIMIT = 20;
const PAGE_LIMIT = 500;
const CONTROL_STRATEGY_VERSION = 'control-native-v1';
const OPENSIP_STRATEGY_VERSION = 'opensip-mcp-epoch-7-v1-impact-files';
const NATIVE_MAX_MATCHES = 200;
const NATIVE_MAX_WALKED_FILES = 20_000;
const NATIVE_MAX_FILE_BYTES = 1024 * 1024;
const NATIVE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const OPENSIP_IMPACT_DEPTH = 2;
const OPENSIP_IMPACT_LIMIT = 50;

interface ImpactTaskConfig {
  readonly aliasExpected: boolean;
  readonly dynamicDispatchExpected: boolean;
  readonly fixture: 'customer-py' | 'customer-ts' | 'customer-workspace';
  readonly rootManifestPath?: string;
  readonly target: ImpactTargetFact;
  readonly workspaceManifestGlob?: string;
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

function nativeSearchArguments(pattern: string) {
  return {
    pattern,
    maxFileBytes: NATIVE_MAX_FILE_BYTES,
    maxMatches: NATIVE_MAX_MATCHES,
    maxTotalBytes: NATIVE_MAX_TOTAL_BYTES,
    maxWalkedFiles: NATIVE_MAX_WALKED_FILES,
  };
}

function controlSteps(config: ImpactTaskConfig): readonly StrategyStep[] {
  const prefix = `impact.${config.fixture}.control`;
  const targetPattern = escapeRegularExpression(config.target.targetSymbol);
  const aliasDiscoveryId = `${prefix}.discover-alias`;
  const aliasDefinitionId = `${prefix}.read-alias-definition`;
  const steps: StrategyStep[] = [
    {
      arguments: nativeSearchArguments(`\\b${targetPattern}\\s*\\(`),
      expectedNonEmpty: true,
      extract: extractNativeCallerCandidates,
      id: `${prefix}.direct-calls`,
      rationale: 'Search direct call syntax for the named change target before widening the chase.',
      tool: 'contentSearch',
    },
  ];
  if (config.aliasExpected) {
    const aliasSource = posix.join(posix.dirname(config.target.targetFile), 'index.ts');
    steps.push(
      {
        arguments: {
          ...nativeSearchArguments(targetPattern),
          glob: aliasSource,
        },
        expectedNonEmpty: true,
        extract: extractAliasSourcePaths,
        id: aliasDiscoveryId,
        rationale: 'Locate the conventional sibling barrel that mentions the target symbol.',
        tool: 'contentSearch',
      },
      {
        arguments: {
          maxBytes: NATIVE_MAX_FILE_BYTES,
          path: {
            $fact: {
              field: 'path',
              match: { kind: 'file', role: 'alias-source' },
              select: 'only',
              stepId: aliasDiscoveryId,
            },
          },
        },
        expectedNonEmpty: true,
        extract: extractCallableAliasesFromSource(config.target.targetSymbol),
        id: aliasDefinitionId,
        rationale: 'Read the discovered barrel and derive an explicit alias or wrapper name.',
        tool: 'readFile',
      },
      {
        arguments: {
          ...nativeSearchArguments('placeholder'),
          pattern: {
            $fact: {
              field: 'value',
              match: { kind: 'text', label: 'call-alias' },
              select: 'only',
              stepId: aliasDefinitionId,
            },
          },
        },
        expectedNonEmpty: true,
        extract: extractNativeCallerCandidates,
        id: `${prefix}.alias-callers`,
        rationale: 'Follow the response-derived wrapper name to its textual callers.',
        tool: 'contentSearch',
      },
    );
  }
  if (config.dynamicDispatchExpected) {
    const referenceSearchId = `${prefix}.target-references`;
    steps.push(
      {
        arguments: nativeSearchArguments(`\\b${targetPattern}\\b`),
        expectedNonEmpty: true,
        extract: extractTargetReferenceFiles(config.target.targetSymbol),
        id: referenceSearchId,
        rationale:
          'Search every bounded textual reference to the named target, including imports, assignments, and indirect registries.',
        tool: 'contentSearch',
      },
      {
        arguments: {
          maxBytes: NATIVE_MAX_FILE_BYTES,
          path: {
            $fact: {
              field: 'path',
              match: { kind: 'file', role: 'dynamic-reference' },
              select: 'only',
              stepId: referenceSearchId,
            },
          },
        },
        expectedNonEmpty: true,
        extract: extractDeclaredFunctionSymbols,
        id: `${prefix}.read-dynamic-reference`,
        rationale:
          'Read the response-identified registry file and discover its enclosing callable without a fixture path or symbol selector.',
        tool: 'readFile',
      },
    );
  }
  if (config.rootManifestPath !== undefined) {
    steps.push({
      arguments: {
        maxBytes: NATIVE_MAX_FILE_BYTES,
        path: config.rootManifestPath,
      },
      expectedNonEmpty: true,
      extract: extractPackageManifestFacts,
      id: `${prefix}.root-manifest`,
      rationale: "Read the conventional root manifest to identify the target project's package.",
      tool: 'readFile',
    });
  }
  if (config.workspaceManifestGlob !== undefined) {
    steps.push(
      {
        arguments: {
          maxResults: PAGE_LIMIT,
          maxWalkedFiles: NATIVE_MAX_WALKED_FILES,
          pattern: config.workspaceManifestGlob,
        },
        expectedNonEmpty: true,
        extract: extractPackageManifestPaths,
        id: `${prefix}.discover-workspace-manifests`,
        rationale:
          'Discover bounded workspace package manifests from the conventional packages directory.',
        tool: 'globList',
      },
      {
        arguments: {
          ...nativeSearchArguments('["\']name["\']\\s*:'),
          glob: config.workspaceManifestGlob,
        },
        expectedNonEmpty: true,
        extract: extractPackageNamesFromManifestMatches,
        id: `${prefix}.workspace-package-names`,
        rationale:
          'Read package names only within the manifest shape established by the prior inventory.',
        tool: 'contentSearch',
      },
    );
  }
  return steps;
}

function opensipSteps(config: ImpactTaskConfig): readonly StrategyStep[] {
  const prefix = `impact.${config.fixture}.opensip`;
  const searchId = `${prefix}.search-target`;
  const binding = symbolBinding(searchId, config.target.targetSymbol);
  const steps: StrategyStep[] = [
    {
      arguments: {
        depth: OPENSIP_IMPACT_DEPTH,
        files: [config.target.targetFile],
        top: OPENSIP_IMPACT_LIMIT,
      },
      expectedNonEmpty: true,
      extract: extractImpactFiles,
      id: `${prefix}.impact-files`,
      rationale:
        'Use the explicit changed file to recover the bounded caller-file and package impact projection.',
      tool: 'impact_files',
    },
  ];
  // The Python fixture's current graph explicitly cannot close its dynamic
  // reverse frontier. Appending expected-nonempty identity/traversal reads
  // would convert that known limitation into an incorrect-none result.
  if (config.fixture === 'customer-py') return steps;
  steps.push(
    {
      arguments: {
        detail: 'nodes',
        generated: 'include',
        limit: SEARCH_LIMIT,
        match: 'exact',
        query: config.target.targetSymbol,
        sourceScope: 'all',
      },
      expectedNonEmpty: true,
      extract: extractSymbolSearch,
      id: searchId,
      rationale:
        'Resolve the named target to the current catalog identity used by traversal reads.',
      tool: 'search_symbols',
    },
    {
      arguments: {
        depth: OPENSIP_IMPACT_DEPTH,
        detail: 'nodes',
        generated: 'include',
        identity: 'occurrence',
        limit: OPENSIP_IMPACT_LIMIT,
        sourceScope: 'all',
        symbolId: binding,
      },
      expectedNonEmpty: true,
      extract: extractWhoCallers,
      id: `${prefix}.who-calls`,
      rationale:
        'Page bounded occurrence-precise caller nodes from the response-derived symbol identity.',
      tool: 'who_calls',
    },
  );
  return steps;
}

function impactAssertions(target: ImpactTargetFact): readonly AnswerFactPattern[] {
  const structuralCallers = target.callers.filter(
    (caller) =>
      caller.evidenceKind === 'barrel-reexport' || caller.evidenceKind === 'dynamic-dispatch',
  );
  return [
    ...target.callers.map((caller) => ({
      kind: 'file' as const,
      path: caller.filePath,
    })),
    ...structuralCallers.map((caller) => ({
      filePath: caller.filePath,
      kind: 'symbol' as const,
      name: caller.symbol,
    })),
    ...target.callers.map((caller): AnswerFactPattern =>
      caller.expectedConfidence === 'unresolved'
        ? {
            evidenceKind: 'target-linked-unresolved-call-site',
            filePath: caller.filePath,
            kind: 'evidence',
            minimumConfidence: 'low',
          }
        : {
            evidenceKind: 'call',
            filePath: caller.filePath,
            kind: 'evidence',
            minimumConfidence: caller.expectedConfidence,
            subject: callerEvidenceSubject(caller.filePath, caller.symbol),
          },
    ),
    ...target.impactedPackages.map((name) => ({
      kind: 'package' as const,
      name,
    })),
  ];
}

function makeImpactTask(config: ImpactTaskConfig): GoldTask {
  return deepFreeze({
    assertions: {
      mustInclude: impactAssertions(config.target),
    },
    fixture: config.fixture,
    id: `impact-estimate.${config.fixture}`,
    question: `Estimate the caller files and impacted packages for a change to ${config.target.targetSymbol} in ${config.target.targetFile}. Preserve the evidence confidence supporting each caller.`,
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
    // quality-baseline: impact_files is present on the current surface (epoch 7+).
    // Remaining failures measure completeness/trust/confidence, not tool absence.
    tags: ['impact', 'quality-baseline'],
  });
}

/** Frozen impact-estimate instances consumed by the explicit task registry. */
export const impactTasks: readonly GoldTask[] = deepFreeze([
  makeImpactTask({
    aliasExpected: true,
    dynamicDispatchExpected: true,
    fixture: 'customer-ts',
    rootManifestPath: 'package.json',
    target: customerTsGroundTruth.impactTargets[0],
  }),
  makeImpactTask({
    aliasExpected: false,
    dynamicDispatchExpected: true,
    fixture: 'customer-py',
    rootManifestPath: 'pyproject.toml',
    target: customerPyGroundTruth.impactTargets[0],
  }),
  makeImpactTask({
    aliasExpected: false,
    dynamicDispatchExpected: false,
    fixture: 'customer-workspace',
    target: customerWorkspaceGroundTruth.impactTargets[0],
    workspaceManifestGlob: 'packages/*/package.json',
  }),
]);
