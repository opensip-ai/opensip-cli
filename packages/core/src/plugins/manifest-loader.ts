/**
 * @fileoverview Static manifest reader + the single admission gate
 * (release 2.8.0, identity & compatibility — Phase 2).
 *
 * `loadToolManifest` reads a tool's static front matter **before**
 * importing its runtime `Tool` module:
 *
 *   - **bundled** / **installed** — `package.json#opensipTools` in the tool's
 *     own package dir (one read for both; the discovery walker already
 *     touches these package.json files).
 *   - **project-local** — a JSON sidecar (`opensip-tool.manifest.json`) in
 *     the tool's directory, since a project-local tool is authored content,
 *     not an installed npm package with a package.json marker.
 *
 * It validates the identity subset (`kind: 'tool'`, `id`, `commands`),
 * derives `name`/`version` from the package.json's own top-level fields
 * (the manifest block does NOT redeclare them — single source of truth),
 * and returns `undefined` (with a structured logger diagnostic) on a
 * malformed or missing manifest. It NEVER imports the tool module.
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

import type {
  ToolCommandManifest,
  ToolPluginManifest,
  ToolProvenance,
  ToolSource,
} from '../tools/manifest.js';

/**
 * Filename of the project-local manifest sidecar. A project-local tool is
 * authored content under `<project>/opensip-tools/…`, not an installed npm
 * package, so it has no `package.json#opensipTools` marker — it declares
 * its identity via this JSON sidecar (deliberately NOT an executable
 * `.mjs`, so the host reads identity without running tool code).
 */
export const PROJECT_LOCAL_MANIFEST_FILE = 'opensip-tool.manifest.json';

/**
 * Read + validate a tool's static `ToolPluginManifest` for the given
 * source, WITHOUT importing the tool's runtime module.
 *
 *   - `bundled` / `installed` — reads `<dir>/package.json`, taking identity
 *     from the `opensipTools` block and `name`/`version` from the
 *     package.json's own top-level fields.
 *   - `project-local` — reads `<dir>/opensip-tool.manifest.json` (the JSON
 *     sidecar), which carries the full identity inline.
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
): ToolPluginManifest | undefined {
  const raw = source === 'project-local' ? readSidecar(dir) : readPackageManifest(dir);
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
export interface AdmissionResult {
  readonly decision: 'admit' | 'skip' | 'fail-closed';
  readonly provenance: ToolProvenance;
  readonly verdict: CompatibilityVerdict;
  readonly diagnostic?: string;
}

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
  readonly manifest: ToolPluginManifest;
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
    version: manifest.version,
    ...(packageName === undefined ? {} : { packageName }),
    resolvedPath: dir,
    manifestHash,
  };

  const verdict = checkCompatibility(manifest.apiVersion);

  if (verdict.kind === 'compatible') {
    logger.info({
      evt: 'plugin.manifest.loaded',
      module: 'core:plugins',
      id: manifest.id,
      source,
      apiVersion: manifest.apiVersion,
      engine: undefined,
      manifestHash,
      decision: 'admit',
    });
    return { decision: 'admit', provenance, verdict };
  }

  // incompatible
  const diagnostic = verdict.reason;
  if (explicitlyRequested) {
    logger.error({
      evt: 'plugin.incompatible.failed',
      module: 'core:plugins',
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
    module: 'core:plugins',
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
 * `ToolPluginManifest`. `name`/`version` come from the package.json's own
 * fields (bundled/installed) or inline (sidecar). Returns `undefined` (with
 * a `reason` is reported by the caller) on any identity violation.
 */
function validateManifest(
  block: Record<string, unknown>,
  name: unknown,
  version: unknown,
): ToolPluginManifest | undefined {
  if (block.kind !== 'tool') return undefined;
  if (typeof block.id !== 'string' || block.id === '') return undefined;
  if (typeof name !== 'string' || name === '') return undefined;
  if (typeof version !== 'string' || version === '') return undefined;

  const commands = normalizeCommands(block.commands);
  if (commands === undefined) return undefined;

  const apiVersion = block.apiVersion;
  if (apiVersion !== undefined && typeof apiVersion !== 'number') return undefined;

  return {
    kind: 'tool',
    id: block.id,
    name,
    version,
    ...(apiVersion === undefined ? {} : { apiVersion }),
    commands,
  };
}

/**
 * Validate + normalize the `commands` array to `ToolCommandManifest[]`.
 * Each entry must carry a string `name` + `description`; optional
 * `aliases` must be a string array. Returns `undefined` on any violation.
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
    out.push({
      name: entry.name,
      description: entry.description,
      ...(aliases === undefined ? {} : { aliases }),
    });
  }
  return out;
}

/** Type guard: a value is a `readonly string[]`. */
function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((a) => typeof a === 'string');
}

/**
 * SHA-256 over the canonical JSON of the manifest's identity subset.
 * Keys are emitted in a fixed order (and commands canonicalized) so the
 * hash is stable across object-key ordering and absent optional fields —
 * a deterministic identity/tamper fingerprint for provenance.
 */
function hashManifest(manifest: ToolPluginManifest): string {
  const canonical = JSON.stringify({
    kind: manifest.kind,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion ?? null,
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
      module: 'core:plugins',
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Emit the structured read-failure diagnostic (debug — a missing/malformed manifest is a skip, not a crash). */
function diagnose(dir: string, source: ToolSource, reason: string): void {
  logger.debug({
    evt: 'plugin.manifest.read_failed',
    module: 'core:plugins',
    dir,
    source,
    reason,
  });
}
