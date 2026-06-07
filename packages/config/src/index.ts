/**
 * @opensip-tools/config — the capability-configuration layer.
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
 * @opensip-tools/core live in the barrel.)
 */

export { ConfigurationError } from '@opensip-tools/core';

export { composeConfigSchema, validateConfigDocument } from './composer.js';
export type {
  EnvBindingDeclaration,
  EnvBindingType,
  ToolConfigDeclaration,
} from './declaration.js';
export { resolveConfig } from './precedence.js';
export type { ResolveConfigInput, ResolvedConfig } from './precedence.js';
export { toJsonSchema } from './json-schema.js';
export type { JsonSchema } from './json-schema.js';
