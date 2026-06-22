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

// Document-level config blocks (the tool-agnostic surface — ADR-0023).
export { loadCliDefaults, cliConfigSchema } from './document/cli-config.js';
export type { CliDefaults } from './document/cli-config.js';
export { dashboardConfigSchema } from './document/dashboard.js';
export {
  targetDefinitionSchema,
  checkTargetValueSchema,
  targetsRecordSchema,
  globalExcludesSchema,
  checkOverridesSchema,
  pluginsConfigSchema,
  createPluginsConfigSchema,
} from './document/targeting.js';
export type {
  TargetConfig,
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
  writeGlobalConfig,
  resolveApiKey,
  resolveEffectiveCloudConfig,
  CONFIG_ENV_SPECS,
} from './document/global-config.js';
export type { GlobalConfig } from './document/global-config.js';
export { renderDocumentHeader } from './document/template.js';
export type { DocumentHeaderInput, TargetTemplateInput } from './document/template.js';
export { hostConfigDeclarations } from './document/host-declarations.js';
