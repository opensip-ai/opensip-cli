/**
 * @opensip-cli/config — the capability-configuration layer.
 *
 * Each tool contributes a {@link ToolConfigDeclaration}; the host composes the
 * registered namespaced Zod schemas into one strict whole-document schema
 * ({@link composeConfigSchema}), validates a raw document against it
 * ({@link validateConfigDocument}), resolves precedence across flags / env /
 * file / defaults ({@link resolveConfig}), and emits a JSON Schema for editors
 * and docs ({@link toJsonSchema}).
 *
 * The barrel also re-exports the kernel's {@link ConfigurationError} — the
 * error every config-resolution path in this layer throws on a malformed or
 * contradictory configuration. Surfacing it from the config package's own
 * barrel means consumers `catch` against the configuration layer they call,
 * not the kernel underneath it. (This re-export also keeps a runtime import of
 * @opensip-cli/core live in the barrel.)
 */

export { ConfigurationError } from '@opensip-cli/core';

export { composeConfigSchema, validateConfigDocument } from './composer.js';
export { decorateToolConfigDeclarationsWithGateKeys } from './gate-keys.js';
// ADR-0043: the unclaimed-namespace claim report (pure; the CLI emits the
// warning / applies the loaded-tool rejection).
export { analyzeNamespaceClaims } from './namespace-claims.js';
export type { NamespaceClaimReport, UnclaimedNamespace } from './namespace-claims.js';
export { partitionUnclaimedNamespaces } from './namespace-policy.js';
export type { UnclaimedNamespacePartition } from './namespace-policy.js';
export type {
  EnvBindingDeclaration,
  EnvBindingType,
  ToolConfigDeclaration,
} from './declaration.js';
export { resolveConfig } from './precedence.js';
export type { ResolveConfigInput, ResolvedConfig } from './precedence.js';
// One descriptor-driven capability-preference resolver (§5.3, Phase 3): reads a
// domain's explicit-list / auto-discover / scopes from the project config through
// the keys its discovery descriptor declares — replacing the three bespoke
// per-tool readers with the documented keys unchanged.
export { resolveCapabilityPreferences } from './capability-preferences.js';
export type { CapabilityPreferences } from './capability-preferences.js';
export { toJsonSchema, jsonSchemaObjectToZod } from './json-schema.js';
export type { JsonSchema } from './json-schema.js';
export { MAX_CONFIG_MIGRATION_BYTES, migrateConfigFile, migrateConfigText } from './migration.js';
export type {
  ConfigMigrationOperation,
  ConfigMigrationOperationKind,
  MigrateConfigFileInput,
  MigrateConfigFileResult,
  MigrateConfigTextInput,
  MigrateConfigTextResult,
} from './migration.js';

// Document-level config blocks (the tool-agnostic surface — ADR-0023).
export { loadCliDefaults, readProjectTrustPolicy, cliConfigSchema } from './document/cli-config.js';
export type { CliDefaults, ReadProjectTrustPolicyResult } from './document/cli-config.js';
export { dashboardConfigSchema } from './document/dashboard.js';
export {
  isReservedSuiteName,
  RESERVED_SUITE_NAMES,
  reservedSuiteNameMessage,
  suiteDefinitionSchema,
  suiteExecutionSchema,
  suitesConfigSchema,
  suiteStepArgsSchema,
  suiteStepSchema,
} from './document/suites.js';
export type { SuiteDefinition, SuitesConfig, SuiteStep } from './document/suites.js';
export {
  findUnsafeTargetConventionPaths,
  targetDefinitionSchema,
  targetConventionsSchema,
  freezeTargetConventions,
  isUnsafeTargetConventionPath,
  checkTargetValueSchema,
  targetsRecordSchema,
  globalExcludesSchema,
  checkOverridesSchema,
  pluginsConfigSchema,
  createPluginsConfigSchema,
} from './document/targeting.js';
export type {
  TargetConfig,
  TargetConventionsConfig,
  TargetConventionPathField,
  TargetConventionPathIssue,
  TargetConventionUsedExportConfig,
  Target,
  CheckTargetMap,
  PluginsConfig,
  PluginConfigKeyKind,
  PluginConfigKeyDeclaration,
  TargetsConfig,
} from './document/targeting.js';
export {
  GLOBAL_CONFIG_PATH,
  readGlobalConfig,
  readGlobalTrustPolicy,
  writeGlobalConfig,
  resolveApiKey,
  resolveEffectiveCloudConfig,
  CONFIG_ENV_SPECS,
} from './document/global-config.js';
export type { GlobalConfig, ReadGlobalTrustPolicyResult } from './document/global-config.js';
export { renderDocumentHeader } from './document/template.js';
export type { DocumentHeaderInput, TargetTemplateInput } from './document/template.js';
export { hostConfigDeclarations } from './document/host-declarations.js';
export {
  POLICY_ACTIONS,
  POLICY_DECISION_OUTCOMES,
  POLICY_EXCEPTION_MAX_COUNT,
  POLICY_ID_MAX_LENGTH,
  POLICY_ORG_CACHE_MAX_AGE_MS,
  POLICY_REASON_MAX_LENGTH,
  POLICY_RESOURCE_CLASSES,
  POLICY_SUBJECT_KINDS,
  POLICY_SUBJECT_MAX_LENGTH,
  PROVENANCE_STATUSES,
  TRUST_POLICY_SOURCE_TIERS,
  CAPABILITY_ISOLATION_LEVELS,
  capabilityIsolationLevelSchema,
  formatPolicySubject,
  orgPolicyCacheSchema,
  parsePolicySubject,
  policyDecisionOutcomeSchema,
  policyResourceClassSchema,
  policySubjectKindSchema,
  provenanceStatusSchema,
  trustPolicyExceptionSchema,
  trustPolicyOrgConfigSchema,
  trustPolicySchema,
} from './policy/trust-policy-schema.js';
export type {
  OrgPolicyCacheDocument,
  OrgPolicyStatus,
  CapabilityIsolationLevel,
  PolicyAction,
  PolicyAuditEvent,
  PolicyDecision,
  PolicyDecisionOutcome,
  PolicyEvaluationRequest,
  PolicyResourceClass,
  PolicyResourceDecision,
  PolicyResourceRequirement,
  PolicySubject,
  PolicySubjectKind,
  ProvenanceStatus,
  ResolvedTrustPolicy,
  ResolvedTrustPolicyException,
  TrustPolicyDocument,
  TrustPolicyExceptionDocument,
  TrustPolicyOrgConfig,
  TrustPolicySource,
  TrustPolicySourceTier,
} from './policy/trust-policy-schema.js';
export {
  BUILTIN_TRUST_POLICY,
  resolveTrustPolicySources,
  trustPolicySource,
} from './policy/trust-policy-resolution.js';
export { evaluateTrustPolicy } from './policy/trust-policy-evaluator.js';
