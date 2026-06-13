/**
 * config-and-capabilities — the pre-dispatch composition seam for the
 * capability-configuration release (ADR-0023 / §5.3, Phase 4).
 *
 * Two host responsibilities the composition root owns once per run, extracted
 * from the pre-action-hook to keep that hook within its complexity budget:
 *
 *   1. {@link composeAndValidateToolConfig} — gather every registered tool's
 *      contributed `ToolConfigDeclaration`, compose them into ONE strict
 *      whole-document schema, validate the parsed `opensip-cli.config.yml`
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
 * This module is the ONE place the CLI imports `@opensip-cli/config` (the
 * composer + precedence resolver). Tools never import it; they read their
 * validated namespace off `scope.toolConfig`.
 */

import {
  analyzeNamespaceClaims,
  composeConfigSchema,
  hostConfigDeclarations,
  resolveConfig,
  validateConfigDocument,
  type PluginConfigKeyDeclaration,
  type ToolConfigDeclaration,
} from '@opensip-cli/config';
import {
  type CapabilityRegistry,
  ConfigurationError,
  logger,
  readYamlFileOrThrow,
  type ResolvedToolConfig,
  type ToolPluginManifest,
  type ToolRegistry,
  registerCapabilityDomainsFromManifest,
} from '@opensip-cli/core';

/** A plain-object guard that treats arrays and null as non-objects. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Collect the contributed config declarations from the registered tools. A
 * tool's `config` slot is the kernel-side `ToolConfigContribution` carrier; it
 * is structurally a `ToolConfigDeclaration` (the schema is `unknown` at the
 * kernel boundary, a Zod schema at the config layer), so narrowing it here —
 * the composition root, which DOES import `@opensip-cli/config` — is sound.
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

function addPluginConfigKey(
  keys: Map<string, PluginConfigKeyDeclaration['kind']>,
  key: string | undefined,
  kind: PluginConfigKeyDeclaration['kind'],
): void {
  if (key === undefined) return;
  const existing = keys.get(key);
  if (existing !== undefined && existing !== kind) {
    throw new ConfigurationError(
      `Plugin config key '${key}' is declared with conflicting value kinds (${existing}, ${kind}).`,
      { code: 'CONFIGURATION_ERROR', namespace: 'plugins' },
    );
  }
  keys.set(key, kind);
}

function collectPluginConfigKeys(
  manifests: readonly ToolPluginManifest[],
): readonly PluginConfigKeyDeclaration[] {
  const keys = new Map<string, PluginConfigKeyDeclaration['kind']>();
  for (const manifest of manifests) {
    for (const capability of manifest.capabilities ?? []) {
      const configKeys = capability.discovery?.configKeys;
      if (configKeys === undefined) continue;
      addPluginConfigKey(keys, configKeys.packages, 'packages');
      addPluginConfigKey(keys, configKeys.autoDiscover, 'autoDiscover');
      addPluginConfigKey(keys, configKeys.scopes, 'scopes');
    }
  }
  return [...keys.entries()].map(([key, kind]) => ({ key, kind }));
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
 * @param configPath The resolved path to `opensip-cli.config.yml`, or
 *   `undefined` when the run has no config document.
 * @param env The environment map for env-binding precedence (typically
 *   `process.env`).
 * @returns The resolved tool config to attach to the scope, or `undefined`.
 * @throws {ConfigurationError} (`CONFIGURATION_ERROR`) when the document fails
 *   strict validation in ANY tool namespace.
 */
export function composeAndValidateToolConfig(args: {
  readonly tools: ToolRegistry;
  readonly manifests?: readonly ToolPluginManifest[];
  readonly configPath: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}): { readonly config: ResolvedToolConfig | undefined; readonly document: unknown } {
  const { tools, configPath, env, manifests = [] } = args;
  const toolDeclarations = collectDeclarations(tools);
  // A run with no tools that declare config (e.g. a project-agnostic context)
  // carries no toolConfig — tools fall back to their in-tool defaults. The host
  // document-level blocks (cli/dashboard/schemaVersion) only need composing when
  // there is a tool dispatch to validate the document for; the real CLI always
  // registers fit/graph/sim, so they are always composed in practice.
  if (toolDeclarations.length === 0) return { config: undefined, document: {} };

  // Compose the host document-level declarations (cli/dashboard/schemaVersion,
  // and from Phase 1 the targeting blocks) BESIDE the tool declarations, so the
  // whole document — not just the tool namespaces — validates STRICT through the
  // one composed schema (ADR-0023, the launch seam).
  const declarations: readonly ToolConfigDeclaration[] = [
    ...hostConfigDeclarations({ pluginConfigKeys: collectPluginConfigKeys(manifests) }),
    ...toolDeclarations,
  ];

  // When a configPath was resolved by the project context (i.e. a real
  // opensip-cli.config.yml or a package.json pointer), read it *strictly*.
  // Malformed YAML or unreadable file must fail before any dispatch (a
  // silent `{}` would bypass targets, gates, cloud settings, etc.).
  // When no configPath, fall back to defaults only (permissive discovery
  // paths elsewhere still use the non-throwing reader).
  const raw: unknown =
    configPath === undefined ? {} : readYamlFileOrThrow(configPath, { loader: 'project-config' });
  const document = isPlainObject(raw) ? raw : {};

  const schema = composeConfigSchema(declarations);
  // STRICT gate: a typo in any tool namespace throws ConfigurationError here,
  // before dispatch. The CLI error boundary maps it to CONFIGURATION_ERROR.
  const validated = validateConfigDocument(schema, document);

  // ADR-0043: the composer TOLERATES unclaimed top-level namespaces (the
  // uninstalled-tool forward-compat contract) — but never silently. Two cases:
  //   - the namespace equals a LOADED tool's id → that tool declares no
  //     Tool.config yet its block exists: a tool-authoring bug, hard-reject;
  //   - otherwise → warn loudly (structured event + stderr for CI), with a
  //     did-you-mean when the key is edit-distance-close to a claimed one.
  reportUnclaimedNamespaces({ declarations, document: validated, tools });

  // The validated document is returned alongside the resolved config so the
  // host can build the targeting substrate (`buildTargets`) from the SAME
  // single validated read — no second `readYamlFile` (ADR-0023 one-reader).
  // `targets`/`globalExcludes` are host namespaces validated by the composed
  // schema; `buildTargets` is a pure builder over them, never a reader.
  return {
    config: resolveConfig({
      declarations,
      file: fileBlocksFor(declarations, validated),
      env,
    }),
    document: validated,
  };
}

/**
 * The ADR-0043 unclaimed-namespace policy: reject a LOADED tool's undeclared
 * block; warn (event + stderr, once per namespace per run) on the rest.
 *
 * @throws {ConfigurationError} when an unclaimed namespace equals a loaded
 *   tool's id — the block exists but the tool cannot consume it.
 */
function reportUnclaimedNamespaces(args: {
  readonly declarations: readonly ToolConfigDeclaration[];
  readonly document: unknown;
  readonly tools: ToolRegistry;
}): void {
  const report = analyzeNamespaceClaims(args.declarations, args.document);
  if (report.unclaimed.length === 0) return;

  const loadedToolNames = new Set(args.tools.list().map((t) => t.metadata.name ?? t.metadata.id));
  const toolBugs = report.unclaimed.filter((u) => loadedToolNames.has(u.namespace));
  if (toolBugs.length > 0) {
    const names = toolBugs.map((u) => `'${u.namespace}'`).join(', ');
    throw new ConfigurationError(
      `Config declares ${names} but the loaded tool(s) of the same id contribute no Tool.config — ` +
        `the block can never apply. Remove the block or fix the tool's config contribution. (ADR-0043)`,
      { code: 'CONFIGURATION_ERROR' },
    );
  }

  for (const u of report.unclaimed) {
    const didYouMean = u.suggestion === undefined ? '' : ` — did you mean '${u.suggestion}:'?`;
    logger.warn({
      evt: 'cli.config.unclaimed_namespace',
      module: 'cli:bootstrap',
      namespace: u.namespace,
      suggestion: u.suggestion,
    });
    process.stderr.write(
      `opensip: config namespace '${u.namespace}:' is not claimed by any loaded tool${didYouMean} ` +
        `(expected if that tool isn't installed in this project)\n`,
    );
  }
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
