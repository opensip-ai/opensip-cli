/**
 * Export-surface lock for `@opensip-cli/core`.
 *
 * Core is the kernel contract shared by tools: signals, tool/plugin contracts,
 * language primitives, RunScope, recipe substrate, config/path helpers, logging,
 * telemetry, and runtime progress transport. The package is intentionally
 * broad, so this test pins its runtime value exports and makes future widening
 * an explicit compatibility decision.
 *
 * Scope note: type-only exports are erased at runtime and cannot be asserted
 * here. Adding a *value* export to the barrel is a deliberate minor-version act
 * and must be reflected in EXPECTED below (and in the package catalog);
 * removing one is a major change.
 */

import { describe, expect, it } from 'vitest';

import * as barrel from '../index.js';

/** The complete, intended set of runtime value exports. Keep alphabetised. */
const EXPECTED_VALUE_EXPORTS = [
  'CLI_SUPPORTED_SCHEMA_VERSION',
  'COMMENT_OPENERS',
  'COMMON_FLAG_KEYS',
  'CapabilityRegistry',
  'CapabilitySchemaMismatchError',
  'ConfigurationError',
  'DiagnosticsBus',
  'EnvRegistry',
  'LanguageParseCache',
  'LanguageRegistry',
  'LoggerImpl',
  'MARKER_KINDS',
  'MAX_SIGNALS_PER_BATCH',
  'NetworkError',
  'NotFoundError',
  'PLUGIN_API_VERSION',
  'PROJECT_CONFIG_FILENAME',
  'PROJECT_LOCAL_MANIFEST_FILE',
  'PluginIncompatibleError',
  'RECOGNIZED_NON_CODE_FORMATS',
  'RecipeRegistry',
  'Registry',
  'RunScope',
  'SeverityPolicy',
  'SystemError',
  // ADR-0035: host-owned verdict policy surface.
  'HOST_VERDICT_POLICY_FALLBACK',
  'policyPasses',
  'resolveVerdictPolicy',
  // Host-owned baseline/ratchet plane (ADR-0036).
  'contentHashFallbackFingerprintStrategy',
  'defaultFingerprintStrategy',
  'fileLevelFingerprintStrategy',
  'stampFingerprints',
  'DEFAULT_FAIL_ON_DEGRADED',
  'resolveFailOnDegraded',
  // Upstream barrel export missing from this curated list (modular-monolith
  // boundary commits added it to index.ts but not here); the barrel exports it.
  'RAW_STREAM_REASONS',
  // Public Tool-contract version marker (ADR-0046) — exported from the barrel
  // by the contract-versioning commits; curated here so the surface test tracks it.
  'TOOL_CONTRACT_VERSION',
  'TOOL_LONG_IDS',
  'TOOL_LONG_TO_SHORT',
  'TOOL_SHORT_IDS',
  'TOOL_SHORT_TO_LONG',
  'TimeoutError',
  'ToolError',
  'ToolRegistry',
  'UnknownCapabilityDomainError',
  'UnknownLiveViewError',
  'VALID_NPM_SCOPE_REGEX',
  'ValidationError',
  'admitTool',
  'applyContentFilter',
  'applyRegions',
  'assertCommandSpec',
  'assertManifestMatchesTool',
  'buildLineStarts',
  'buildMinimalTextTree',
  'buildSignalBatch',
  'checkCompatibility',
  'checkSchemaCompat',
  'clearCurrentRecipeUnitConfig',
  'clearParseCache',
  'configureLogger',
  'createRunLogger',
  'createCapabilityRegistry',
  'createInProcessTransport',
  'createRunLifecycle',
  'createRunTimer',
  'createSignal',
  'createSignalFromViolation',
  'createSubprocessProgressRun',
  'currentCapabilityRegistry',
  'currentLogger',
  'currentScope',
  'currentTraceparent',
  'defineCommand',
  'deriveRecipeId',
  'detectPhantomRuntimes',
  'discoverAuthoredToolSidecars',
  'discoverCapabilityContributions',
  'discoverPackagesByDeclaredKind',
  'discoverPackagesByMarker',
  'discoverPackagesInNodeModules',
  'discoverPlugins',
  'discoverScopedPackages',
  'discoverToolPackages',
  'discoverToolPackagesFromAnchors',
  'enterScope',
  'err',
  'executePipeline',
  'extractPayloadVersion',
  'extractTimestamp',
  'filterSignalsBySuppressions',
  'formatDuration',
  'generateId',
  'generatePrefixedId',
  'generateUUID',
  'getParseTree',
  'getParseTreeForFile',
  'getMeter',
  'getTracer',
  'getUnitConfig',
  'hasPackageJson',
  'initParseCache',
  'isCapabilityValidator',
  'isErrorSeverity',
  'isErrorSignal',
  'isIdentChar',
  'isMarkerKind',
  'isPathInside',
  'isRecognizedNonCodeFormat',
  'isRecord',
  'isStringArray',
  'isStructuralContributionSchema',
  'isToolLongId',
  'isToolShortId',
  'loadAllPlugins',
  'loadCapabilityDomain',
  'loadPlugin',
  'loadToolManifest',
  'logger',
  'makeStripper',
  'noopSignalSink',
  'ok',
  'readConfigSchemaVersion',
  'readDeclaredKind',
  'readMarkerKind',
  'readPackageVersion',
  'readProjectPluginsList',
  'readToolPackageMetadata',
  'readYamlFile',
  'readYamlFileOrThrow',
  'registerCapabilityDomainsFromManifest',
  'registerRecipesFromMod',
  'resolvePackageDir',
  'resolvePackageEntryPoint',
  'resolveProjectConfigPath',
  'resolveProjectContext',
  'resolveProjectPaths',
  'resolveScopes',
  'resolveSelector',
  'resolveUserPaths',
  'runOffThreadOrInProcess',
  'runWithRetry',
  'runWithScope',
  'runWithScopeSync',
  'runWithTimeout',
  'scanBlockCommentNesting',
  'scanBlockCommentNonNesting',
  'scanCharLiteral',
  'scanLineComment',
  'scanRegularString',
  'scanSuppressionDirectives',
  'scheduleUnits',
  'setCurrentRecipeUnitConfig',
  'stripCommentOpener',
  'tryCatch',
  'tryCatchAsync',
  'validateCommandSpec',
  'withRetry',
  'withSpan',
  'withSpanAsync',
  'yieldToEventLoop',
].sort();

describe('@opensip-cli/core public barrel', () => {
  it('exposes exactly the curated value-export surface', () => {
    const actual = Object.keys(barrel)
      .filter((k) => barrel[k as keyof typeof barrel] !== undefined)
      .sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });

  it('exposes the kernel scope and tool registry primitives', () => {
    expect(barrel.RunScope).toBeDefined();
    expect(barrel.ToolRegistry).toBeDefined();
  });

  it('does NOT leak test utilities or private plugin-discovery helpers through the barrel', () => {
    for (const leak of [
      'withScope',
      'withScopeSync',
      'makeTestScope',
      'safeReaddir',
      'selfCore',
      'foreignCorePath',
      'filterSameCorePackages',
      'normalizeDiscovery',
      'resetContentFilterWarningForTests',
    ]) {
      expect(barrel).not.toHaveProperty(leak);
    }
  });
});
