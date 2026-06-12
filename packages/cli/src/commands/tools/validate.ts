/**
 * `tools validate` — user-invocable tool conformance (ADR-0041).
 *
 * The SAME admission pipeline bootstrap runs (`admitToolPackage` — one
 * validator, four consumers), rendered as a sectioned report, plus the
 * Tier A storage-contract scan (ADR-0042) and the config-contract checks.
 *
 * EXECUTION MODEL (the trust posture, stated plainly): validating a package
 * is trusting it to execute — the runtime sections import the candidate's
 * module. Mitigations, not promises: staging installs run npm with
 * `--ignore-scripts` (install-time hooks never fire), and the module import
 * happens in a child-process probe with a hard timeout (a crash boundary,
 * NOT a security boundary).
 *
 * Staging: an npm/tarball spec installs into a TEMP host dir (removed in
 * `finally`); a local directory path validates IN PLACE by default, or via a
 * temp-host install with `--install-deps` (which also resolves the package's
 * dependencies so the runtime sections can load it).
 */

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { admitToolPackage } from '../../bootstrap/admit-tool-package.js';
import { ensureHostDir } from '../plugin/host-dir.js';
import { npmInstallIntoHost } from '../plugin-host-ops.js';

import { runRuntimeProbe } from './runtime-probe.js';
import { runStorageContractChecks, type StorageFinding } from './storage-contract-checks.js';

import type { ToolsValidateResult, ToolsValidateSection } from '@opensip-cli/contracts';

/** The one-line execution notice printed before any candidate code can run. */
export const VALIDATE_EXECUTION_NOTICE =
  'opensip: validating runs the package’s module (untrusted code; ' +
  'install scripts stay blocked, the import runs in a sandboxed-by-timeout ' +
  'child process — a crash boundary, not a security boundary).\n';

/** Options for {@link runToolValidation}. */
export interface ToolValidationOptions {
  /** Package spec: npm name/range/tarball/git spec, or a local directory path. */
  readonly spec: string;
  readonly cwd: string;
  /** For LOCAL PATH specs: stage via temp-host npm install (resolves deps). */
  readonly installDeps?: boolean;
}

/** A staged candidate: the package dir to validate + the cleanup to run. */
interface StagedCandidate {
  readonly pkgDir: string;
  readonly cleanup: () => void;
  readonly stagedByInstall: boolean;
  /** Present when staging itself failed (no pkgDir to validate). */
  readonly stagingError?: string;
}

const NOOP_CLEANUP = (): void => {
  /* in-place candidates own their dir; nothing was staged */
};

/** True when `spec` points at an existing local directory. */
function isLocalDirSpec(spec: string, cwd: string): boolean {
  const candidate = isAbsolute(spec) ? spec : resolve(cwd, spec);
  return existsSync(candidate) && statSync(candidate).isDirectory();
}

/**
 * Stage the candidate. npm/tarball specs (and `--install-deps` paths) install
 * into a fresh temp host with `--ignore-scripts`; bare local dirs stage in
 * place (zero side effects).
 */
function stageCandidate(opts: ToolValidationOptions): StagedCandidate {
  const localDir = isLocalDirSpec(opts.spec, opts.cwd);
  if (localDir && opts.installDeps !== true) {
    const pkgDir = isAbsolute(opts.spec) ? opts.spec : resolve(opts.cwd, opts.spec);
    return { pkgDir, cleanup: NOOP_CLEANUP, stagedByInstall: false };
  }
  const tempHost = mkdtempSync(join(tmpdir(), 'ost-tools-validate-'));
  const cleanup = (): void => rmSync(tempHost, { recursive: true, force: true });
  ensureHostDir(tempHost, 'tool');
  const spec = localDir && !isAbsolute(opts.spec) ? resolve(opts.cwd, opts.spec) : opts.spec;
  const outcome = npmInstallIntoHost(tempHost, spec);
  if (!outcome.ok) {
    return { pkgDir: '', cleanup, stagedByInstall: true, stagingError: outcome.error };
  }
  return {
    pkgDir: join(tempHost, 'node_modules', outcome.installedName),
    cleanup,
    stagedByInstall: true,
  };
}

function section(
  name: string,
  status: ToolsValidateSection['status'],
  diagnostics: readonly string[] = [],
): ToolsValidateSection {
  return { name, status, diagnostics };
}

function storageSections(findings: readonly StorageFinding[]): ToolsValidateSection[] {
  const isBoundary = (f: StorageFinding): boolean =>
    f.clause.includes('imports') || f.clause.includes('runners');
  const fmt = (f: StorageFinding): string => `${f.file}:${f.line} — ${f.clause}`;
  const boundaries = findings.filter((f) => isBoundary(f));
  const storage = findings.filter((f) => !isBoundary(f));
  return [
    section('storage-contract', storage.length === 0 ? 'passed' : 'failed', storage.map(fmt)),
    section(
      'import-boundaries',
      boundaries.length === 0 ? 'passed' : 'failed',
      boundaries.map(fmt),
    ),
  ];
}

/** Map one admission section result to a report section. */
function fromAdmission(s: {
  section: string;
  ok: boolean;
  diagnostic?: string;
}): ToolsValidateSection {
  return section(s.section, s.ok ? 'passed' : 'failed', s.diagnostic ? [s.diagnostic] : []);
}

/**
 * True when a FAILED probe over an IN-PLACE candidate failed on the
 * candidate's own unresolved dependencies (expected without `--install-deps`).
 * A probe-INFRA failure ("runtime probe crashed/timed out/…") must never
 * classify as a candidate missing-dep, even when the child's stderr mentions
 * an unresolved module.
 */
function isExpectedMissingDep(
  probe: ReturnType<typeof runRuntimeProbe>,
  stagedByInstall: boolean,
): boolean {
  if (probe.ok || stagedByInstall) return false;
  return probe.sections.some(
    (s) =>
      s.diagnostic !== undefined &&
      !s.diagnostic.startsWith('runtime probe') &&
      /cannot find (module|package)/i.test(s.diagnostic),
  );
}

/** The three runtime sections marked skipped (in-place, deps not installed). */
function skippedRuntimeSections(): ToolsValidateSection[] {
  return [
    section('runtime-load', 'skipped', [
      'dependencies not installed — rerun with --install-deps to verify the runtime sections',
    ]),
    section('tool-shape', 'skipped'),
    section('manifest-runtime-coherence', 'skipped'),
  ];
}

/**
 * Config contract (spec + ADR-0043 family): a manifest that declares config
 * needs a runtime `Tool.config`; a runtime namespace must equal the tool id.
 */
function configContractSection(
  manifestDeclaresConfig: boolean,
  toolConfigNamespace: string | null,
  toolId: string | undefined,
): ToolsValidateSection {
  const diagnostics: string[] = [];
  if (manifestDeclaresConfig && toolConfigNamespace === null) {
    diagnostics.push(
      'manifest declares config but the runtime Tool.config contribution is missing',
    );
  }
  if (toolConfigNamespace !== null && toolConfigNamespace !== toolId) {
    diagnostics.push(
      `Tool.config.namespace '${toolConfigNamespace}' does not match the tool id '${toolId ?? ''}'`,
    );
  }
  return section('config-contract', diagnostics.length === 0 ? 'passed' : 'failed', diagnostics);
}

/** The runtime-probe + config-contract leg. Mutates nothing; returns its sections. */
function runtimeSectionsFor(
  staged: StagedCandidate,
  manifestDeclaresConfig: boolean,
  manifestToolId: string | undefined,
): { sections: ToolsValidateSection[]; toolId: string | undefined; incomplete: boolean } {
  const probe = runRuntimeProbe(staged.pkgDir);
  if (isExpectedMissingDep(probe, staged.stagedByInstall)) {
    return { sections: skippedRuntimeSections(), toolId: manifestToolId, incomplete: true };
  }
  const sections = probe.sections
    .filter((s) => s.section !== 'manifest' && s.section !== 'compatibility')
    .map((s) => fromAdmission(s));
  let toolId = manifestToolId;
  if (probe.ok) {
    if (probe.toolId !== null) toolId = probe.toolId;
    sections.push(configContractSection(manifestDeclaresConfig, probe.toolConfigNamespace, toolId));
  }
  return { sections, toolId, incomplete: false };
}

function verdictFor(
  sections: readonly ToolsValidateSection[],
  incomplete: boolean,
): ToolsValidateResult['verdict'] {
  if (sections.some((s) => s.status === 'failed')) return 'failed';
  if (incomplete) return 'incomplete';
  return 'passed';
}

/**
 * Run every validation section against one candidate spec. Shared by
 * `tools validate` (renders it) and `tools install` (gates activation on it).
 * `keepStaged` hands ownership of the staged dir to the caller (install
 * activates from the validated bytes — never a re-download).
 */
export async function runToolValidation(
  opts: ToolValidationOptions,
  { keepStaged = false }: { keepStaged?: boolean } = {},
): Promise<{ result: ToolsValidateResult; stagedPkgDir?: string; cleanup: () => void }> {
  process.stderr.write(VALIDATE_EXECUTION_NOTICE);
  const staged = stageCandidate(opts);
  try {
    if (staged.stagingError !== undefined) {
      return {
        result: {
          type: 'tools-validate',
          spec: opts.spec,
          verdict: 'failed',
          sections: [section('staging', 'failed', [staged.stagingError])],
        },
        cleanup: NOOP_CLEANUP,
      };
    }

    // Static admission sections (manifest + compatibility) — in-process, no
    // candidate code runs.
    const staticReport = await admitToolPackage({
      dir: staged.pkgDir,
      source: 'installed',
      explicitlyRequested: true,
      staticOnly: true,
    });
    const sections: ToolsValidateSection[] = staticReport.sections.map((s) => fromAdmission(s));

    let toolId: string | undefined = staticReport.manifest?.id;
    let incomplete = false;
    if (staticReport.ok) {
      // Runtime sections — child-process probe (untrusted code executes there).
      const runtime = runtimeSectionsFor(
        staged,
        staticReport.manifest?.config !== undefined,
        toolId,
      );
      sections.push(...runtime.sections);
      toolId = runtime.toolId;
      incomplete = runtime.incomplete;
    }

    // Tier A storage contract (ADR-0042) — pure file scan, always runs.
    sections.push(...storageSections(runStorageContractChecks(staged.pkgDir)));

    return {
      result: {
        type: 'tools-validate',
        spec: opts.spec,
        ...(toolId === undefined ? {} : { toolId }),
        verdict: verdictFor(sections, incomplete),
        sections,
      },
      ...(keepStaged && staged.stagedByInstall ? { stagedPkgDir: staged.pkgDir } : {}),
      cleanup: keepStaged ? staged.cleanup : NOOP_CLEANUP,
    };
  } finally {
    if (!keepStaged) staged.cleanup();
  }
}
