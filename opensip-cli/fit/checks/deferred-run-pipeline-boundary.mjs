/**
 * @fileoverview deferred-run-pipeline-boundary — keep the host-owned run
 * pipeline behind its approved contracts boundary.
 *
 * Spec 29 promotes `defineAnalysisRunCommand`, config read helpers, and the
 * lifecycle vocabulary as contracts-owned APIs. This guard permits those
 * approved package boundaries while still blocking opportunistic tool-local
 * pipeline copies.
 */
import { defineCheck } from '@opensip-cli/fitness';

const PRODUCTION_TS = /(^|\/)packages\/.*\/src\/.*\.ts$/;
const TEST_OR_FIXTURE = /(^|\/)(?:__tests__|__fixtures__|fixtures)\//;
const TEST_FILE = /\.test\.ts$/;
const CONTRACTS_SRC = /(^|\/)packages\/contracts\/src\//;
const TOOL_COMMAND_SRC =
  /(^|\/)packages\/(?:fitness\/engine|graph\/engine|simulation\/engine|yagni\/engine)\/src\/cli\/.*\.ts$/;
const TOOL_CONFIG_BRIDGE =
  /(^|\/)packages\/(?:fitness\/engine|graph\/engine|simulation\/engine|yagni\/engine)\/src\/cli\/.*config\.ts$/;

const RESERVED_SYMBOLS = ['RunCommandPipeline'];

const PROMOTED_SYMBOLS = [
  'defineAnalysisRunCommand',
  'readToolConfig',
  'readOptionalToolConfig',
  'RunLifecycleEvent',
  'UnitLifecycleEvent',
  'DeliveryLifecycleEvent',
  'ConfigLifecycleEvent',
];

const RESERVED_RE = new RegExp(`\\b(?:${RESERVED_SYMBOLS.join('|')})\\b`, 'u');
const PROMOTED_RE = new RegExp(`\\b(?:${PROMOTED_SYMBOLS.join('|')})\\b`, 'gu');
const DEFINITION_RE = new RegExp(
  `\\b(?:export\\s+)?(?:function|class|const|let|var|interface|type)\\s+(?:${PROMOTED_SYMBOLS.join('|')})\\b`,
  'u',
);

function allowedPromotedSymbolUse(symbol, normalizedPath, content) {
  if (CONTRACTS_SRC.test(normalizedPath)) return true;
  if (DEFINITION_RE.test(content)) return false;

  if (symbol === 'defineAnalysisRunCommand') {
    return TOOL_COMMAND_SRC.test(normalizedPath);
  }
  if (symbol === 'readToolConfig' || symbol === 'readOptionalToolConfig') {
    return TOOL_CONFIG_BRIDGE.test(normalizedPath);
  }
  return false;
}

export function analyzeDeferredRunPipelineBoundary(content, filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  if (!PRODUCTION_TS.test(normalized)) return [];
  if (TEST_OR_FIXTURE.test(normalized) || TEST_FILE.test(normalized)) return [];

  const match = RESERVED_RE.exec(content);
  if (match !== null) {
    return [
      {
        message: `Reserved run-pipeline API '${match[0]}' is not part of the approved host-owned analysis-run boundary.`,
        severity: 'error',
        suggestion:
          'Use defineAnalysisRunCommand from @opensip-cli/contracts; do not introduce a separate RunCommandPipeline abstraction.',
      },
    ];
  }

  for (const promoted of content.matchAll(PROMOTED_RE)) {
    const symbol = promoted[0];
    if (allowedPromotedSymbolUse(symbol, normalized, content)) continue;
    return [
      {
        message: `Host-owned run-pipeline API '${symbol}' appears outside its approved contracts/tool-command boundary.`,
        severity: 'error',
        suggestion:
          'Import promoted analysis-run helpers from @opensip-cli/contracts only in approved command/config bridges; do not define tool-local copies.',
      },
    ];
  }

  return [];
}

export const deferredRunPipelineBoundary = defineCheck({
  id: 'b6c8ef38-1d6f-4c7d-b49e-21eec3abf7bb',
  slug: 'deferred-run-pipeline-boundary',
  description: 'Host-owned run pipeline APIs must stay behind the approved contracts boundary',
  scope: { languages: ['typescript'], concerns: ['architecture'] },
  tags: ['architecture'],
  fileTypes: ['ts'],
  // Match reserved API *symbols* in code only; a comment or string mentioning
  // the deferred names (e.g. a migration note or an ADR-0104 reference) is not a
  // premature implementation and must not fail the gate.
  contentFilter: 'strip-strings-and-comments',
  analyze: analyzeDeferredRunPipelineBoundary,
});
