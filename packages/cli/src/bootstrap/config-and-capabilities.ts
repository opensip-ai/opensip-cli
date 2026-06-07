/**
 * config-and-capabilities — the pre-dispatch composition seam for the
 * capability-configuration release (2.10.0, ADR-0023 / §5.3, Phase 4).
 *
 * Two host responsibilities the composition root owns once per run, extracted
 * from the pre-action-hook to keep that hook within its complexity budget:
 *
 *   1. {@link composeAndValidateToolConfig} — gather every registered tool's
 *      contributed `ToolConfigDeclaration`, compose them into ONE strict
 *      whole-document schema, validate the parsed `opensip-tools.config.yml`
 *      STRICT before any command runs (a typo in ANY tool namespace throws a
 *      single `ConfigurationError` → `CONFIGURATION_ERROR` exit through the
 *      existing error boundary), then resolve precedence (flag > env > file >
 *      defaults) and return the resolved config to attach to the scope.
 *
 *   2. {@link wireCapabilityRegistry} — construct the per-run capability
 *      registry, register every admitted manifest's declared domains (each
 *      seeded with a DEFERRED placeholder registrar), then replace each
 *      placeholder with the owning tool's REAL registrar
 *      (`tool.capabilityRegistrars`). The host routes by domain; the tool owns
 *      the registrar.
 *
 * This module is the ONE place the CLI imports `@opensip-tools/config` (the
 * composer + precedence resolver). Tools never import it; they read their
 * validated namespace off `scope.toolConfig`.
 */

import {
  composeConfigSchema,
  resolveConfig,
  validateConfigDocument,
  type ToolConfigDeclaration,
} from '@opensip-tools/config';
import {
  type CapabilityRegistry,
  type ResolvedToolConfig,
  type ToolPluginManifest,
  type ToolRegistry,
  registerCapabilityDomainsFromManifest,
  readYamlFile,
} from '@opensip-tools/core';

/** A plain-object guard that treats arrays and null as non-objects. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Collect the contributed config declarations from the registered tools. A
 * tool's `config` slot is the kernel-side `ToolConfigContribution` carrier; it
 * is structurally a `ToolConfigDeclaration` (the schema is `unknown` at the
 * kernel boundary, a Zod schema at the config layer), so narrowing it here —
 * the composition root, which DOES import `@opensip-tools/config` — is sound.
 */
function collectDeclarations(tools: ToolRegistry): readonly ToolConfigDeclaration[] {
  const declarations: ToolConfigDeclaration[] = [];
  for (const tool of tools.list()) {
    if (tool.config !== undefined) {
      declarations.push(tool.config as ToolConfigDeclaration);
    }
  }
  return declarations;
}

/**
 * Project the validated document's per-namespace blocks into the `file`
 * precedence source (`namespace -> { key -> value }`). Only the declared
 * namespaces are read; unclaimed top-level keys (cli/targets/globalExcludes)
 * are not this resolver's concern.
 */
function fileBlocksFor(
  declarations: readonly ToolConfigDeclaration[],
  validated: unknown,
): Record<string, Record<string, unknown>> {
  const file: Record<string, Record<string, unknown>> = {};
  if (!isPlainObject(validated)) return file;
  for (const decl of declarations) {
    const block = validated[decl.namespace];
    if (isPlainObject(block)) file[decl.namespace] = block;
  }
  return file;
}

/**
 * Compose + strict-validate the config document, then resolve precedence.
 *
 * Reads the project config file (when one exists), composes the registered
 * tools' schemas, validates STRICT (rejecting a typo inside any tool
 * namespace), and resolves precedence. Returns `undefined` when there is no
 * config document to validate (a project-agnostic command or a config-less
 * project) — the scope then carries no `toolConfig` and tools fall back to
 * their in-tool defaults.
 *
 * @param tools The per-run tool registry (supplies the contributed schemas).
 * @param configPath The resolved path to `opensip-tools.config.yml`, or
 *   `undefined` when the run has no config document.
 * @param env The environment map for env-binding precedence (typically
 *   `process.env`).
 * @returns The resolved tool config to attach to the scope, or `undefined`.
 * @throws {ConfigurationError} (`CONFIGURATION_ERROR`) when the document fails
 *   strict validation in ANY tool namespace.
 */
export function composeAndValidateToolConfig(args: {
  readonly tools: ToolRegistry;
  readonly configPath: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}): ResolvedToolConfig | undefined {
  const { tools, configPath, env } = args;
  const declarations = collectDeclarations(tools);
  if (declarations.length === 0) return undefined;

  // No config document → nothing to strict-validate. Resolve defaults + env so
  // a flagless/fileless run still gets the declared defaults on the scope.
  const raw: unknown = configPath === undefined ? {} : readYamlFile(configPath);
  const document = isPlainObject(raw) ? raw : {};

  const schema = composeConfigSchema(declarations);
  // STRICT gate: a typo in any tool namespace throws ConfigurationError here,
  // before dispatch. The CLI error boundary maps it to CONFIGURATION_ERROR.
  const validated = validateConfigDocument(schema, document);

  return resolveConfig({
    declarations,
    file: fileBlocksFor(declarations, validated),
    env,
  });
}

/**
 * Construct + populate the per-run capability registry (§5.3, Phase 4).
 *
 * Registers every admitted manifest's declared capability domains (each with
 * a deferred placeholder registrar), then replaces each placeholder with the
 * owning tool's REAL registrar from `tool.capabilityRegistrars`. A registrar
 * for a domain the tool's manifest did not declare is skipped (the host only
 * wires registrars for declared domains).
 *
 * @param tools The per-run tool registry (supplies each tool's real registrars).
 * @param manifests The admitted manifests (supply the declared domains).
 * @returns The populated registry, ready to attach to `scope.capabilities`.
 */
export function wireCapabilityRegistry(args: {
  readonly tools: ToolRegistry;
  readonly manifests: readonly ToolPluginManifest[];
  readonly registry: CapabilityRegistry;
}): CapabilityRegistry {
  const { tools, manifests, registry } = args;

  // 1. Register every manifest-declared domain with a deferred placeholder.
  for (const manifest of manifests) {
    registerCapabilityDomainsFromManifest(manifest, registry);
  }

  // 2. Replace each placeholder with the owning tool's real registrar. A
  //    registrar whose domain id was not declared in any manifest is skipped
  //    (hasDomain false) — the host never invents a domain a tool didn't
  //    declare.
  for (const tool of tools.list()) {
    const registrars = tool.capabilityRegistrars;
    if (registrars === undefined) continue;
    for (const [domainId, registrar] of Object.entries(registrars)) {
      if (registry.hasDomain(domainId)) {
        registry.setRegistrar(domainId, registrar);
      }
    }
  }

  return registry;
}
