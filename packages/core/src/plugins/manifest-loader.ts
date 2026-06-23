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

import { logger } from '../lib/logger.js';
import { checkCompatibility, type CompatibilityVerdict } from '../tools/compatibility.js';
import { PLUGIN_API_VERSION } from '../tools/manifest.js';

import {
  diagnose,
  hashManifest,
  LOADER_MODULE,
  PROJECT_LOCAL_MANIFEST_FILE,
  readPackageManifest,
  readSidecar,
  validateManifest,
} from './manifest-loader-helpers.js';

export { PROJECT_LOCAL_MANIFEST_FILE };

import type {
  RawToolPluginManifest,
  ToolPluginManifest,
  ToolProvenance,
  ToolSource,
} from '../tools/manifest.js';

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