// @fitness-ignore-file file-length-limit -- one cohesive manifest pipeline: the static reader (loadToolManifest), the single admission gate (admitTool), and their private validate/normalize/hash/diagnose helpers form one read→validate→admit subsystem over the raw-vs-admitted compatibility contract. The helpers are admission-internal (not reused elsewhere); hoisting them out would scatter one contract across files. Grew past the 400-line soft limit with the per-field normalization helpers.
/**
 * @fileoverview Static manifest reader + the single admission gate
 * (launch, raw-vs-admitted compatibility contract).
 *
 * `loadToolManifest` reads a tool's static front matter **before**
 * importing its runtime `Tool` module:
 *
 *   - **bundled** / **installed** — `package.json#opensipTools` in the tool's
 *     own package dir (one read for both; the discovery walker already
 *     touches these package.json files).
 *   - **project-local** / **user-global** — a JSON sidecar
 *     (`opensip-tool.manifest.json`) in the tool's directory, since an
 *     authored tool is authored content, not an installed npm package with a
 *     package.json marker. Both authored sources read the SAME sidecar; only
 *     their trust posture differs (deny-by-default vs trusted-by-default),
 *     which is the admission caller's concern, not the loader's.
 *
 * It validates the raw identity subset (`kind: 'tool'`, `id`, `commands`),
 * derives `name`/`version` from the package.json's own top-level fields
 * (the manifest block does NOT redeclare them — single source of truth),
 * validates concrete additive descriptors such as `capabilities`, and returns
 * `undefined` (with a structured logger diagnostic) on a malformed or missing
 * manifest. A missing `apiVersion` is still representable as a
 * `RawToolPluginManifest` so `admitTool` can reject it with a compatibility
 * diagnostic. It NEVER imports the tool module.
 *
 * `admitTool` is the single gate the bundled and external paths share: it
 * records `ToolProvenance` (incl. a `manifestHash` over the canonical
 * manifest JSON) and runs `checkCompatibility(manifest.apiVersion)`:
 *   - compatible                       → `admit`
 *   - incompatible + not requested     → `skip` (with diagnostic)
 *   - incompatible + explicitly asked  → `fail-closed` (with diagnostic)
 * It emits exactly one structured logger evt per decision.
 *
 * Both functions are pure over real filesystem reads of package.json /
 * the sidecar — no tool-module import, no module singletons. They stay in
 * core (the kernel) and import nothing from contracts/cli/tools-runtime.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { logger } from '../lib/logger.js';
import { checkCompatibility, type CompatibilityVerdict } from '../tools/compatibility.js';
import { validateToolIdentity, type ToolIdentity } from '../tools/identity.js';
import { PLUGIN_API_VERSION } from '../tools/manifest.js';

import { isRecord, isStringArray } from './json-guards.js';
import { normalizeDiscovery } from './manifest-discovery.js';

import type { PluginLayout } from './types.js';
import type { CapabilityContributionKind, ToolCapabilityDeclaration } from '../tools/capability.js';
import type { ToolConfigManifestDescriptor } from '../tools/manifest-config.js';
import type {
  RawToolPluginManifest,
  ToolCommandManifest,
  ToolPluginManifest,
  ToolProvenance,
  ToolSource,
} from '../tools/manifest.js';

/**
 * Filename of the project-local manifest sidecar. A project-local tool is
 * authored content under `<project>/opensip-cli/…`, not an installed npm
 * package, so it has no `package.json#opensipTools` marker — it declares
 * its identity via this JSON sidecar (deliberately NOT an executable
 * `.mjs`, so the host reads identity without running tool code).
 */
export const PROJECT_LOCAL_MANIFEST_FILE = 'opensip-tool.manifest.json';

/** `module` field stamped on every structured log event from this file. */
const LOADER_MODULE = 'core:plugins';

/**
 * Read + validate a tool's static `ToolPluginManifest` for the given
 * source, WITHOUT importing the tool's runtime module.
 *
 *   - `bundled` / `installed` — reads `<dir>/package.json`, taking identity
 *     from the `opensipTools` block and `name`/`version` from the
 *     package.json's own top-level fields.
 *   - `project-local` / `user-global` — reads
 *     `<dir>/opensip-tool.manifest.json` (the JSON sidecar), which carries the
 *     full identity inline. Both authored sources share the sidecar branch.
 *
 * @param source Where the tool came from — selects the manifest location.
 * @param dir The tool's package/authoring directory.
 * @returns The validated manifest, or `undefined` (with a structured
 *   `plugin.manifest.read_failed` diagnostic) when the file is missing,
 *   unparseable, or fails identity validation.
 */
export function loadToolManifest(
  source: ToolSource,
  dir: string,
): RawToolPluginManifest | undefined {
  // Both authored sources (project-local + user-global) declare identity via
  // the JSON sidecar; bundled/installed read package.json#opensipTools.
  const authored = source === 'project-local' || source === 'user-global';
  const raw = authored ? readSidecar(dir) : readPackageManifest(dir);
  if (raw === undefined) {
    diagnose(dir, source, 'manifest file missing or unreadable');
    return undefined;
  }

  const manifest = validateManifest(raw.block, raw.name, raw.version);
  if (manifest === undefined) {
    diagnose(dir, source, raw.reason ?? 'manifest failed identity validation');
    return undefined;
  }
  return manifest;
}

/**
 * The outcome of the single admission gate — the decision plus the
 * `ToolProvenance` recorded regardless of verdict (so an incompatible
 * tool can still be surfaced) and the underlying `CompatibilityVerdict`.
 *
 *   - `admit`        — compatible; the host may import + register the tool.
 *   - `skip`         — incompatible but not explicitly requested: dropped
 *                      silently from the user's perspective (diagnostic only).
 *   - `fail-closed`  — incompatible AND explicitly requested: the host must
 *                      fail with the Phase-0 incompatible exit code.
 */
export type AdmissionResult =
  | {
      readonly decision: 'admit';
      readonly provenance: ToolProvenance;
      readonly verdict: Extract<CompatibilityVerdict, { kind: 'compatible' }>;
      readonly manifest: ToolPluginManifest;
      readonly diagnostic?: undefined;
    }
  | {
      readonly decision: 'skip' | 'fail-closed';
      readonly provenance: ToolProvenance;
      readonly verdict: CompatibilityVerdict;
      readonly diagnostic?: string;
    };

/**
 * Run the single compatibility gate over a manifest and produce an
 * {@link AdmissionResult}. Records `ToolProvenance` (source + identity +
 * `manifestHash`) regardless of verdict, then maps the
 * `checkCompatibility` outcome to a decision:
 *
 *   - compatible                          → `admit`
 *   - incompatible + `!explicitlyRequested` → `skip`
 *   - incompatible + `explicitlyRequested`  → `fail-closed`
 *
 * Emits exactly one structured logger evt per decision
 * (`plugin.manifest.loaded` / `plugin.incompatible.skipped` /
 * `plugin.incompatible.failed`). Never throws, never imports the tool.
 *
 * @param args.manifest The validated manifest (from {@link loadToolManifest}).
 * @param args.source Where the tool came from.
 * @param args.dir The tool's resolved directory (recorded as `resolvedPath`).
 * @param args.packageName npm package name, when known (bundled/installed).
 * @param args.explicitlyRequested Whether the user named this tool directly
 *   (e.g. via a plugin pin) — promotes an incompatible `skip` to `fail-closed`.
 */
export function admitTool(args: {
  readonly manifest: RawToolPluginManifest;
  readonly source: ToolSource;
  readonly dir: string;
  readonly packageName?: string;
  readonly explicitlyRequested: boolean;
}): AdmissionResult {
  const { manifest, source, dir, packageName, explicitlyRequested } = args;

  const manifestHash = hashManifest(manifest);
  const provenance: ToolProvenance = {
    source,
    id: manifest.id,
    ...(manifest.stableId ? { stableId: manifest.stableId } : {}),
    version: manifest.version,
    ...(packageName === undefined ? {} : { packageName }),
    resolvedPath: dir,
    manifestHash,
  };

  const verdict = checkCompatibility(manifest.apiVersion);

  if (verdict.kind === 'compatible') {
    const admittedManifest: ToolPluginManifest = {
      ...manifest,
      // `verdict.kind === 'compatible'` ⇒ apiVersion equals the engine epoch (a
      // defined number); the `?? PLUGIN_API_VERSION` fallback is never reached
      // when compatible — it only narrows the type to `number` without a
      // non-null assertion.
      apiVersion: manifest.apiVersion ?? PLUGIN_API_VERSION,
    };
    logger.info({
      evt: 'plugin.manifest.loaded',
      module: LOADER_MODULE,
      id: manifest.id,
      source,
      apiVersion: admittedManifest.apiVersion,
      engine: undefined,
      manifestHash,
      decision: 'admit',
    });
    return {
      decision: 'admit',
      provenance,
      verdict,
      manifest: admittedManifest,
    };
  }

  // incompatible
  const diagnostic = verdict.reason;
  if (explicitlyRequested) {
    logger.error({
      evt: 'plugin.incompatible.failed',
      module: LOADER_MODULE,
      id: manifest.id,
      source,
      apiVersion: verdict.declared,
      engine: verdict.engine,
      manifestHash,
      decision: 'fail-closed',
      diagnostic,
    });
    return { decision: 'fail-closed', provenance, verdict, diagnostic };
  }

  logger.warn({
    evt: 'plugin.incompatible.skipped',
    module: LOADER_MODULE,
    id: manifest.id,
    source,
    apiVersion: verdict.declared,
    engine: verdict.engine,
    manifestHash,
    decision: 'skip',
    diagnostic,
  });
  return { decision: 'skip', provenance, verdict, diagnostic };
}

// ── Internals ────────────────────────────────────────────────────────────

/** Raw manifest block + the package.json identity fields it derives from. */
interface RawManifest {
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
function readPackageManifest(dir: string): RawManifest | undefined {
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
function readSidecar(dir: string): RawManifest | undefined {
  const json = readJson(join(dir, PROJECT_LOCAL_MANIFEST_FILE));
  if (json === undefined) return undefined;
  return { block: json, name: json.name, version: json.version };
}

/**
 * Validate the identity subset of a manifest block and assemble a typed
 * `RawToolPluginManifest`. `name`/`version` come from the package.json's own
 * fields (bundled/installed) or inline (sidecar). Returns `undefined` (with
 * a `reason` is reported by the caller) on any identity violation.
 */
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

/** Narrow to an optional non-empty string: absent, or a non-empty string. */
function isAbsentOrNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

/**
 * Validate the optional `capabilities` slot. Returns `undefined` when absent
 * (additive — no declared domains), the normalized array when valid, or the
 * `'invalid'` sentinel when present-but-malformed (the caller then rejects the
 * whole manifest). Keeps the absent/invalid distinction out of the main
 * validator's control flow.
 */
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

function validateManifest(
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

  // ADR-0048: the tool's stable machine identity (UUID). Additive + optional —
  // present-but-non-string fails validation, mirroring the `id` guard above.
  // MUST be carried onto the manifest: the drift guard (assertManifestMatchesTool)
  // matches it against the runtime `metadata.id`, and capability-domain ownership
  // (registerCapabilityDomainsFromManifest) stamps `ownerToolId = stableId ?? id`.
  // Dropping it here silently breaks graph-adapter discovery (owner never matches
  // the tool's UUID `metadata.id`).
  if (!isAbsentOrNonEmptyString(block.stableId)) return undefined;
  const stableId = block.stableId;

  // §5.3 (launch): the `capabilities` slot. Absent ⇒ no declared domains;
  // present-but-malformed ⇒ the whole manifest is invalid (the `'invalid'`
  // sentinel), mirroring the strict `commands` parse above.
  const capabilities = validateOptionalCapabilities(block.capabilities);
  if (capabilities === 'invalid') return undefined;

  // ADR-0054 M4-G: the serializable `pluginLayout` (`{ domain, userSubdirs }`).
  // Absent ⇒ no extension-pack surface; present-but-malformed ⇒ the whole
  // manifest is invalid (mirroring the strict `commands`/`capabilities` parse).
  const pluginLayout = normalizePluginLayout(block.pluginLayout);
  if (pluginLayout === 'invalid') return undefined;
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
    // Reserved for future community/catalog (see ToolPluginManifestBase): copied
    // through as `unknown` (additive) so they survive load → admit without loss.
    ...opt('compatibility', block.compatibility),
    ...opt('distribution', block.distribution),
    ...opt('extensionMetadata', block.extensionMetadata),
  };
}

/** Spread helper: `{}` when `value` is undefined, else `{ [key]: value }`. Keeps
 *  the manifest assembly flat (one expression per optional field). */
function opt<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** Closed set of valid `contributionKind` values for a capability declaration. */
const CONTRIBUTION_KINDS: readonly CapabilityContributionKind[] = [
  'module-export',
  'manifest-entry',
  'file',
];

/**
 * Validate + normalize a PRESENT `capabilities` array to
 * `ToolCapabilityDeclaration[]`. Each entry needs a non-empty string `id`,
 * a numeric `apiVersion`, and a `contributionKind` in the closed set;
 * `contributionSchema` is `unknown` (the kernel carries no Zod) and is
 * passed through verbatim. Returns the declarations on success, or
 * `undefined` when the slot is malformed (the caller fails the manifest,
 * mirroring `normalizeCommands`). The absent case is handled by the caller.
 */
function normalizeCapabilities(value: unknown): readonly ToolCapabilityDeclaration[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ToolCapabilityDeclaration[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    if (typeof entry.id !== 'string' || entry.id === '') return undefined;
    if (typeof entry.apiVersion !== 'number') return undefined;
    const kind = entry.contributionKind;
    if (!isContributionKind(kind)) return undefined;
    // `discovery` is optional, but a PRESENT-but-malformed descriptor fails the
    // manifest (mirroring the strict `contributionKind` check above).
    const discovery = normalizeDiscovery(entry.discovery);
    if (discovery.status === 'invalid') return undefined;
    out.push({
      id: entry.id,
      apiVersion: entry.apiVersion,
      // `contributionSchema` is unknown by contract — pass through as-is
      // (may legitimately be absent for a domain that validates inside its
      // own registrar).
      contributionSchema: entry.contributionSchema,
      contributionKind: kind,
      ...(discovery.status === 'ok' ? { discovery: discovery.descriptor } : {}),
    });
  }
  return out;
}

/** Type guard for the closed `CapabilityContributionKind` union. */
function isContributionKind(value: unknown): value is CapabilityContributionKind {
  return typeof value === 'string' && (CONTRIBUTION_KINDS as readonly string[]).includes(value);
}

/** Closed set of valid command `output` modes (mirrors core's `CommandOutputMode`). */
const COMMAND_OUTPUT_MODES = new Set([
  'signal-envelope',
  'command-result',
  'raw-stream',
  'live-view',
]);
/** Closed set of valid command `scope` requirements (mirrors core's `CommandScopeRequirement`). */
const COMMAND_SCOPE_REQUIREMENTS = new Set(['project', 'none']);

/** Is `v` an array of plain-object records (the shape options/args round-trip as)? */
function isRecordArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((e) => isRecord(e));
}

/**
 * Per-field validators for the ADR-0054 M4-G serializable command SHELL. Each
 * entry validates ONE optional field; a present-but-malformed value fails the
 * whole manifest (mirroring the strict `commands`/`capabilities` parse). Keeping
 * the validators table-driven keeps {@link normalizeCommandShell} a flat loop
 * (low cognitive complexity) and the field set self-documenting.
 *
 * `options`/`args` pass through as opaque object arrays — the host's
 * `assertCommandSpec` re-validates the synthesized spec and Commander validates
 * flag syntax at mount, so this stays a shallow structural guard. The
 * non-serializable `OptionSpec.parse` closure is intentionally not modelled.
 */
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

/**
 * Round-trip the ADR-0054 M4-G serializable command SHELL fields onto a
 * normalized {@link ToolCommandManifest}. The host mounts an EXTERNAL tool's
 * command from this shell (no runtime import). Absent fields are omitted — the
 * host synthesizer applies the runtime `CommandSpec` defaults.
 *
 * @returns the shell fields to merge, or `'invalid'` when a present field is
 *   malformed.
 */
function normalizeCommandShell(
  entry: Record<string, unknown>,
): Partial<ToolCommandManifest> | 'invalid' {
  const shell: Record<string, unknown> = {};
  for (const [field, isValid] of Object.entries(COMMAND_SHELL_VALIDATORS)) {
    const value = entry[field];
    if (value === undefined) continue;
    if (!isValid(value)) return 'invalid';
    shell[field] = value;
  }
  return shell;
}

/**
 * Validate + normalize the `commands` array to `ToolCommandManifest[]`.
 * Each entry must carry a string `name` + `description`; optional
 * `aliases` must be a string array. The ADR-0054 M4-G serializable command
 * SHELL fields round-trip via {@link normalizeCommandShell}. Returns
 * `undefined` on any violation.
 */
function normalizeCommands(value: unknown): readonly ToolCommandManifest[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ToolCommandManifest[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    if (typeof entry.name !== 'string' || entry.name === '') return undefined;
    if (typeof entry.description !== 'string') return undefined;
    const { aliases } = entry;
    if (aliases !== undefined && !isStringArray(aliases)) return undefined;
    const shell = normalizeCommandShell(entry);
    if (shell === 'invalid') return undefined;
    out.push({
      name: entry.name,
      description: entry.description,
      ...(aliases === undefined ? {} : { aliases }),
      ...shell,
    });
  }
  return out;
}

/**
 * Validate + normalize the ADR-0054 M4-G `pluginLayout` descriptor
 * (`{ domain, userSubdirs }`, mirroring the runtime {@link Tool.pluginLayout}).
 * The host reads it to mount the domain-bound `<tool> plugin …` extension-pack
 * group + drive `init` scaffolding for an EXTERNAL tool WITHOUT importing its
 * runtime. A present-but-malformed layout fails the whole manifest (mirroring the
 * strict `commands`/`capabilities` parse); absent ⇒ the tool hosts no packs.
 *
 * @returns the validated layout, `undefined` when absent, or `'invalid'` when
 *   present-but-malformed.
 */
function normalizePluginLayout(value: unknown): PluginLayout | undefined | 'invalid' {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return 'invalid';
  const { domain, userSubdirs } = value;
  if (typeof domain !== 'string' || domain === '') return 'invalid';
  if (!isStringArray(userSubdirs)) return 'invalid';
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

function hashManifest(manifest: RawToolPluginManifest): string {
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

/**
 * Read + JSON-parse a file, returning the parsed object or `undefined`
 * when the file is missing, unreadable, unparseable, or not an object.
 * Mirrors the JSON-read pattern in `marker-discovery.ts` (best-effort,
 * never throws) so the discovery surfaces share one read style.
 */
function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    // Best-effort read (mirrors marker-discovery.ts): a malformed/unreadable
    // manifest file is a skip, not a crash — but we surface WHY at debug so a
    // genuinely broken file is diagnosable rather than silently invisible.
    logger.debug({
      evt: 'plugin.manifest.read_failed',
      module: LOADER_MODULE,
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Emit the structured read-failure diagnostic (debug — a missing/malformed manifest is a skip, not a crash). */
function diagnose(dir: string, source: ToolSource, reason: string): void {
  logger.debug({
    evt: 'plugin.manifest.read_failed',
    module: LOADER_MODULE,
    dir,
    source,
    reason,
  });
}
