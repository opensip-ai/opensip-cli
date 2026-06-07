/**
 * @fileoverview Static manifest reader (release 2.8.0, identity &
 * compatibility — Phase 2, Task 2.1).
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
 * The admission gate (`admitTool`) that consumes this manifest is Task 2.2.
 *
 * Pure over real filesystem reads of package.json / the sidecar — no
 * tool-module import, no module singletons. Stays in core (the kernel) and
 * imports nothing from contracts/cli/tools-runtime.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { logger } from '../lib/logger.js';

import type {
  ToolCommandManifest,
  ToolPluginManifest,
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
    diagnose(dir, source, 'manifest failed identity validation');
    return undefined;
  }
  return manifest;
}

// ── Internals ────────────────────────────────────────────────────────────

/** Raw manifest block + the package.json identity fields it derives from. */
interface RawManifest {
  readonly block: Record<string, unknown>;
  readonly name: unknown;
  readonly version: unknown;
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
 * fields (bundled/installed) or inline (sidecar). Returns `undefined` on
 * any identity violation.
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
  } catch {
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
