/**
 * admit-tool-package — the tool admission pipeline as ONE reusable callable
 * (ADR-0041: one validator, four consumers).
 *
 * The sequence every whole-tool plugin travels — `loadToolManifest` →
 * `admitTool` (compatibility gate) → dynamic runtime import → `isValidTool`
 * shape gate → `assertManifestMatchesTool` drift guard — previously lived
 * inline in `register-tools.ts` with per-source failure POLICY (bundled fails
 * closed, installed skips-with-diagnostic) woven through it. This module
 * factors the SEQUENCE out as a report producer and leaves policy at the
 * callers:
 *
 *   - `registerFirstPartyTools` (bundled bootstrap) converts a failed report
 *     into the same fail-closed `PluginIncompatibleError`s it always threw.
 *   - `tools validate` renders the report's sections to the user.
 *   - `tools install` gates activation on `report.ok`.
 *   - The bundled-tool conformance tests run it against fitness/sim/graph.
 *
 * EXECUTES UNTRUSTED CODE: the runtime sections dynamic-import the package's
 * module. Callers that need isolation (e.g. `tools validate` probing a
 * not-yet-trusted package) pass `staticOnly: true` here and run the runtime
 * sections in a child-process probe instead.
 */

import { pathToFileURL } from 'node:url';

import {
  admitTool,
  assertManifestMatchesTool,
  loadToolManifest,
  readToolPackageMetadata,
  type RawToolPluginManifest,
  type Tool,
  type ToolPluginManifest,
  type ToolProvenance,
  type ToolSource,
} from '@opensip-tools/core';

import { isValidTool } from './validate-tool.js';

/**
 * The outcome of importing a tool package's runtime module. A discriminated
 * result (never throws) so each caller maps it to its own policy — bundled
 * fails closed, installed skips-with-diagnostic. (Relocated verbatim from
 * `register-tools.ts`; the authored/installed discovery legs import it from
 * here.)
 */
export type ToolRuntimeLoad =
  | { readonly ok: true; readonly tool: Tool }
  | {
      readonly ok: false;
      readonly reason: 'no-entry' | 'invalid-shape' | 'import-failed';
      readonly detail?: string;
    };

/**
 * Resolve a tool package's entry, DYNAMIC-IMPORT it, and validate the exported
 * `tool` shape. This is the ONE runtime-load path every installation source
 * travels (3.0.0 GA, north-star Figure 7): no static `import` of a tool runtime
 * survives in the host — a bundled tool is imported by its resolved entry path
 * exactly as an installed one is. Import is by `pathToFileURL(meta.mainEntry)`,
 * not the bare package name, so a tool living in a host dir off the CLI's own
 * module-resolution path still loads. A third-party tool is an untrusted
 * boundary, so `isValidTool` gates the exported symbol before it is touched.
 *
 * Never throws: returns a discriminated result the caller acts on.
 */
export async function importToolRuntime(dir: string): Promise<ToolRuntimeLoad> {
  const meta = readToolPackageMetadata(dir);
  if (!meta) return { ok: false, reason: 'no-entry' };
  let mod: { tool?: unknown };
  try {
    mod = (await import(pathToFileURL(meta.mainEntry).href)) as {
      tool?: unknown;
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'import-failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!isValidTool(mod.tool)) return { ok: false, reason: 'invalid-shape' };
  return { ok: true, tool: mod.tool };
}

/** The named conformance sections of the admission pipeline, in run order. */
export type AdmissionSection =
  | 'manifest'
  | 'compatibility'
  | 'runtime-load'
  | 'tool-shape'
  | 'manifest-runtime-coherence';

/** One section's verdict. `diagnostic` is present on failure (and only then). */
export interface AdmissionSectionResult {
  readonly section: AdmissionSection;
  readonly ok: boolean;
  readonly diagnostic?: string;
}

/**
 * The full admission verdict for one package dir. `ok` ⇔ every executed
 * section passed. Sections later than the first failure are not executed
 * (each depends on its predecessor's artifact); with `staticOnly` the three
 * runtime sections are not executed either — absent from `sections`, so a
 * renderer can show them as skipped.
 */
export interface AdmissionReport {
  readonly ok: boolean;
  readonly sections: readonly AdmissionSectionResult[];
  /**
   * The raw `loadToolManifest` result — present once the manifest section
   * passes, even when the compatibility gate later rejects (callers render
   * the candidate's id from it).
   */
  readonly rawManifest?: RawToolPluginManifest;
  /** The ADMITTED manifest — present iff the compatibility section passed. */
  readonly manifest?: ToolPluginManifest;
  /** Present iff the compatibility section passed. */
  readonly provenance?: ToolProvenance;
  /** Present iff every runtime section passed (never with `staticOnly`). */
  readonly tool?: Tool;
  /** The raw gate decision when the compatibility section ran. */
  readonly compatibilityDecision?: 'admit' | 'skip' | 'fail-closed';
  /** Failure detail from the runtime-load/tool-shape sections, when they ran. */
  readonly runtimeLoadReason?: 'no-entry' | 'invalid-shape' | 'import-failed';
  readonly runtimeLoadDetail?: string;
  /**
   * The ORIGINAL error thrown by `assertManifestMatchesTool` when the
   * coherence section fails — preserved so a fail-closed caller (the bundled
   * bootstrap) can rethrow it unchanged.
   */
  readonly coherenceError?: unknown;
}

/** Input to {@link admitToolPackage}. */
export interface AdmitToolPackageOptions {
  /** The package directory whose `package.json#opensipTools` is the manifest. */
  readonly dir: string;
  readonly source: ToolSource;
  readonly packageName?: string;
  /** Threaded to the compatibility gate (skip-vs-fail posture lives there). */
  readonly explicitlyRequested: boolean;
  /**
   * Stop after the static (no-code-execution) sections: manifest +
   * compatibility. The runtime sections (`runtime-load`, `tool-shape`,
   * `manifest-runtime-coherence`) execute the package's module — callers
   * validating untrusted candidates run those in a child-process probe.
   */
  readonly staticOnly?: boolean;
}

/**
 * Run the admission pipeline over one package dir and report per-section
 * verdicts. Pure sequencing — no logging, no throwing, no registration;
 * policy (fail-closed vs skip vs render) belongs to the caller.
 */
export async function admitToolPackage(opts: AdmitToolPackageOptions): Promise<AdmissionReport> {
  const sections: AdmissionSectionResult[] = [];

  // Section 1 — manifest: a conformant package.json#opensipTools (or sidecar,
  // per source) must load. Identity only; no code runs.
  const rawManifest = loadToolManifest(opts.source, opts.dir);
  if (rawManifest === undefined) {
    sections.push({
      section: 'manifest',
      ok: false,
      diagnostic: 'manifest missing or malformed',
    });
    return { ok: false, sections };
  }
  sections.push({ section: 'manifest', ok: true });

  // Section 2 — compatibility: the shared admitTool gate (apiVersion epoch,
  // capability coherence). Still static — no code runs.
  const result = admitTool({
    manifest: rawManifest,
    source: opts.source,
    dir: opts.dir,
    ...(opts.packageName === undefined ? {} : { packageName: opts.packageName }),
    explicitlyRequested: opts.explicitlyRequested,
  });
  if (result.decision !== 'admit') {
    sections.push({
      section: 'compatibility',
      ok: false,
      diagnostic: result.diagnostic ?? 'compatibility gate rejected it',
    });
    return {
      ok: false,
      sections,
      rawManifest,
      compatibilityDecision: result.decision,
    };
  }
  sections.push({ section: 'compatibility', ok: true });
  const { manifest, provenance } = result;

  if (opts.staticOnly === true) {
    return {
      ok: true,
      sections,
      rawManifest,
      manifest,
      provenance,
      compatibilityDecision: 'admit',
    };
  }

  // Section 3+4 — runtime load + tool shape: dynamic import (UNTRUSTED code
  // executes here) and the exported-symbol gate.
  const load = await importToolRuntime(opts.dir);
  if (!load.ok) {
    if (load.reason === 'invalid-shape') {
      sections.push(
        { section: 'runtime-load', ok: true },
        {
          section: 'tool-shape',
          ok: false,
          diagnostic: 'module does not export a valid `tool`',
        },
      );
    } else {
      sections.push({
        section: 'runtime-load',
        ok: false,
        diagnostic: load.detail ?? load.reason,
      });
    }
    return {
      ok: false,
      sections,
      manifest,
      provenance,
      compatibilityDecision: 'admit',
      runtimeLoadReason: load.reason,
      ...(load.detail === undefined ? {} : { runtimeLoadDetail: load.detail }),
    };
  }
  sections.push({ section: 'runtime-load', ok: true }, { section: 'tool-shape', ok: true });

  // Section 5 — coherence: the static manifest and the runtime tool are two
  // declarations of one identity; they must agree (id + command surface).
  try {
    assertManifestMatchesTool(manifest, load.tool);
  } catch (error) {
    sections.push({
      section: 'manifest-runtime-coherence',
      ok: false,
      diagnostic: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      sections,
      manifest,
      provenance,
      compatibilityDecision: 'admit',
      coherenceError: error,
    };
  }
  sections.push({ section: 'manifest-runtime-coherence', ok: true });

  return {
    ok: true,
    sections,
    manifest,
    provenance,
    tool: load.tool,
    compatibilityDecision: 'admit',
  };
}
