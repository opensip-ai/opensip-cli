import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { logger } from '../lib/logger.js';
import { validateToolIdentity, type ToolIdentity } from '../tools/identity.js';

import { isRecord, isStringArray } from './json-guards.js';
import { normalizeDiscovery } from './manifest-discovery.js';

import type { PluginLayout } from './types.js';
import type { CapabilityContributionKind, ToolCapabilityDeclaration } from '../tools/capability.js';
import type { ToolConfigManifestDescriptor } from '../tools/manifest-config.js';
import type { RawToolPluginManifest, ToolCommandManifest, ToolSource } from '../tools/manifest.js';

/**
 * Filename of the project-local manifest sidecar. A project-local tool is
 * authored content under `<project>/opensip-cli/…`, not an installed npm
 * package, so it has no `package.json#opensipTools` marker — it declares
 * its identity via this JSON sidecar (deliberately NOT an executable
 * `.mjs`, so the host reads identity without running tool code).
 */
export const PROJECT_LOCAL_MANIFEST_FILE = 'opensip-tool.manifest.json';

/** `module` field stamped on every structured log event from this file. */
export const LOADER_MODULE = 'core:plugins';

/** Raw manifest block + the package.json identity fields it derives from. */
export interface RawManifest {
  readonly block: Record<string, unknown>;
  readonly name: unknown;
  readonly version: unknown;
  readonly reason?: string;
}

/**
 * Read `<dir>/package.json` and extract the `opensipTools` block plus the
 * top-level `name`/`version`. Returns `undefined` when the file is missing
 * or unparseable, or when there is no object-shaped `opensipTools` block.
 */
export function readPackageManifest(dir: string): RawManifest | undefined {
  const json = readJson(join(dir, 'package.json'));
  if (json === undefined) return undefined;
  const block = json.opensipTools;
  if (!isRecord(block)) return undefined;
  return { block, name: json.name, version: json.version };
}

/**
 * Read the project-local JSON sidecar. The sidecar IS the manifest block
 * and carries `name`/`version` inline (there is no package.json alongside
 * an authored project-local tool).
 */
export function readSidecar(dir: string): RawManifest | undefined {
  const json = readJson(join(dir, PROJECT_LOCAL_MANIFEST_FILE));
  if (json === undefined) return undefined;
  return { block: json, name: json.name, version: json.version };
}

function isIdentityObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrow an unknown value to a non-empty string (the manifest identity-field guard). */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function normalizeIdentity(raw: unknown): ToolIdentity | undefined {
  if (!isIdentityObject(raw)) return undefined;
  try {
    const normalized = validateToolIdentity(raw as unknown as ToolIdentity);
    return {
      name: normalized.name,
      ...(normalized.aliases.length === 0 ? {} : { aliases: normalized.aliases }),
      ...(normalized.layoutKey === normalized.name ? {} : { layoutKey: normalized.layoutKey }),
    };
  } catch {
    return undefined;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isAbsentOrUuidString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && UUID_RE.test(value));
}

function validateOptionalCapabilities(
  raw: unknown,
): readonly ToolCapabilityDeclaration[] | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  return normalizeCapabilities(raw) ?? 'invalid';
}

function normalizeManifestIdentity(block: Record<string, unknown>):
  | {
      readonly identity: ToolIdentity;
      readonly normalized: ReturnType<typeof validateToolIdentity>;
    }
  | undefined {
  const identity = normalizeIdentity(block.identity);
  if (identity === undefined) return undefined;
  const normalized = validateToolIdentity(identity);
  return block.id === normalized.name ? { identity, normalized } : undefined;
}

function layoutMatchesIdentity(
  pluginLayout: PluginLayout | undefined,
  identity: ReturnType<typeof validateToolIdentity>,
): boolean {
  return pluginLayout === undefined || pluginLayout.domain === identity.layoutKey;
}

type ConfigParseResult =
  | { readonly ok: true; readonly config?: ToolConfigManifestDescriptor }
  | { readonly ok: false };

function configMatchesIdentity(
  config: ToolConfigManifestDescriptor | undefined,
  identity: ReturnType<typeof validateToolIdentity>,
): boolean {
  return config === undefined || config.namespace === identity.name;
}

/** Validate and normalize a raw `opensipTools` or sidecar manifest block. */
export function validateManifest(
  block: Record<string, unknown>,
  name: unknown,
  version: unknown,
): RawToolPluginManifest | undefined {
  if (block.kind !== 'tool') return undefined;
  if (!isNonEmptyString(block.id)) return undefined;
  if (!isNonEmptyString(name)) return undefined;
  if (!isNonEmptyString(version)) return undefined;

  const commands = normalizeCommands(block.commands);
  if (commands === undefined) return undefined;

  const identityResult = normalizeManifestIdentity(block);
  if (identityResult === undefined) return undefined;
  const { identity, normalized: normalizedIdentity } = identityResult;

  const apiVersion = block.apiVersion;
  if (apiVersion !== undefined && typeof apiVersion !== 'number') return undefined;

  if (!isAbsentOrUuidString(block.stableId)) return undefined;
  const stableId = block.stableId;

  const capabilities = validateOptionalCapabilities(block.capabilities);
  if (capabilities === 'invalid') return undefined;

  const pluginLayout = normalizePluginLayout(block.pluginLayout);
  if (block.pluginLayout !== undefined && pluginLayout === undefined) return undefined;
  if (!layoutMatchesIdentity(pluginLayout, normalizedIdentity)) return undefined;

  const configResult = normalizeConfig(block.config);
  if (!configResult.ok) return undefined;
  const { config } = configResult;
  if (!configMatchesIdentity(config, normalizedIdentity)) return undefined;

  return {
    kind: 'tool',
    id: block.id,
    identity,
    ...opt('stableId', stableId),
    name,
    version,
    ...opt('apiVersion', apiVersion),
    commands,
    ...opt('capabilities', capabilities),
    ...opt('config', config),
    ...opt('pluginLayout', pluginLayout),
    ...opt('compatibility', block.compatibility),
    ...opt('distribution', block.distribution),
    ...opt('extensionMetadata', block.extensionMetadata),
  };
}

function opt<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

const CONTRIBUTION_KINDS: readonly CapabilityContributionKind[] = [
  'module-export',
  'manifest-entry',
  'file',
];

function parseCapabilityEntry(entry: unknown): ToolCapabilityDeclaration | undefined {
  if (!isRecord(entry)) return undefined;
  if (typeof entry.id !== 'string' || entry.id === '') return undefined;
  // Capability epochs are bounded INTEGERS (ADR-0074): reject non-integers like
  // 1.5 and semver-shaped numbers, not just non-numbers.
  if (typeof entry.apiVersion !== 'number' || !Number.isInteger(entry.apiVersion)) return undefined;
  if (
    typeof entry.minSupportedApiVersion !== 'number' ||
    !Number.isInteger(entry.minSupportedApiVersion)
  ) {
    return undefined;
  }
  if (entry.minSupportedApiVersion > entry.apiVersion) return undefined;
  const kind = entry.contributionKind;
  if (!isContributionKind(kind)) return undefined;
  const discovery = normalizeDiscovery(entry.discovery);
  if (discovery.status === 'invalid') return undefined;
  return {
    id: entry.id,
    apiVersion: entry.apiVersion,
    minSupportedApiVersion: entry.minSupportedApiVersion,
    contributionSchema: entry.contributionSchema,
    contributionKind: kind,
    ...(discovery.status === 'ok' ? { discovery: discovery.descriptor } : {}),
  };
}

function normalizeCapabilities(value: unknown): readonly ToolCapabilityDeclaration[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ToolCapabilityDeclaration[] = [];
  // Small per-plugin manifest list (batch limit irrelevant).
  for (const entry of value) {
    const parsed = parseCapabilityEntry(entry);
    if (parsed === undefined) return undefined;
    out.push(parsed);
  }
  return out;
}

function isContributionKind(value: unknown): value is CapabilityContributionKind {
  return typeof value === 'string' && (CONTRIBUTION_KINDS as readonly string[]).includes(value);
}

const COMMAND_OUTPUT_MODES = new Set([
  'signal-envelope',
  'command-result',
  'raw-stream',
  'live-view',
]);
const COMMAND_SCOPE_REQUIREMENTS = new Set(['project', 'none']);

function isRecordArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((e) => isRecord(e));
}

const COMMAND_SHELL_VALIDATORS: Readonly<Record<string, (v: unknown) => boolean>> = {
  visibility: (v) => v === 'public' || v === 'internal',
  parent: (v) => typeof v === 'string' && v !== '',
  commonFlags: (v) => isStringArray(v),
  options: isRecordArray,
  args: isRecordArray,
  scope: (v) => typeof v === 'string' && COMMAND_SCOPE_REQUIREMENTS.has(v),
  output: (v) => typeof v === 'string' && COMMAND_OUTPUT_MODES.has(v),
  rawStreamReason: (v) => typeof v === 'string',
};

function normalizeCommandShell(
  entry: Record<string, unknown>,
): Partial<ToolCommandManifest> | undefined {
  const shell: Record<string, unknown> = {};
  for (const [field, isValid] of Object.entries(COMMAND_SHELL_VALIDATORS)) {
    const value = entry[field];
    if (value === undefined) continue;
    if (!isValid(value)) return undefined;
    shell[field] = value;
  }
  return shell;
}

function normalizeCommands(value: unknown): readonly ToolCommandManifest[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ToolCommandManifest[] = [];
  // Small per-plugin manifest list (batch limit irrelevant).
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    if (typeof entry.name !== 'string' || entry.name === '') return undefined;
    if (typeof entry.description !== 'string') return undefined;
    const { aliases } = entry;
    if (aliases !== undefined && !isStringArray(aliases)) return undefined;
    const shell = normalizeCommandShell(entry);
    if (shell === undefined) return undefined;
    out.push({
      name: entry.name,
      description: entry.description,
      ...(aliases === undefined ? {} : { aliases }),
      ...shell,
    });
  }
  return out;
}

function normalizePluginLayout(value: unknown): PluginLayout | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const { domain, userSubdirs } = value;
  if (typeof domain !== 'string' || domain === '') return undefined;
  if (!isStringArray(userSubdirs)) return undefined;
  return { domain, userSubdirs };
}

function normalizeConfig(value: unknown): ConfigParseResult {
  if (value === undefined) return { ok: true };
  if (!isRecord(value)) return { ok: false };
  const { namespace, schema } = value;
  if (!isNonEmptyString(namespace)) return { ok: false };
  if (!isRecord(schema)) return { ok: false };
  return { ok: true, config: { namespace, schema } };
}

/** Compute a stable SHA-256 fingerprint of a normalized tool manifest. */
export function hashManifest(manifest: RawToolPluginManifest): string {
  const canonical = JSON.stringify({
    kind: manifest.kind,
    id: manifest.id,
    identity: manifest.identity,
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion ?? null,
    config: manifest.config ?? null,
    pluginLayout: manifest.pluginLayout ?? null,
    commands: manifest.commands.map((c) => ({
      name: c.name,
      description: c.description,
      aliases: c.aliases ?? null,
    })),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    logger.debug({
      evt: 'plugin.manifest.read_failed',
      module: LOADER_MODULE,
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Emit a structured debug log when manifest discovery or parsing fails. */
export function diagnose(dir: string, source: ToolSource, reason: string): void {
  logger.debug({
    evt: 'plugin.manifest.read_failed',
    module: LOADER_MODULE,
    dir,
    source,
    reason,
  });
}
