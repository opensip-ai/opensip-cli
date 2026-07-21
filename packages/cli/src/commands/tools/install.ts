/**
 * `tools install` — atomic stage → validate → activate (ADR-0041).
 *
 * The candidate stages into a temp host (npm `--ignore-scripts`) and the FULL
 * validation (`runToolValidation`, keepStaged) runs against the staged bytes.
 * Only a `passed` verdict activates — and activation installs a tarball
 * `npm pack`ed FROM THE STAGED DIR, never a re-resolve of the original spec
 * (a registry re-resolve between validate and activate could deliver
 * different bytes than the ones validated; and `npm install <dir>` would
 * symlink the about-to-be-deleted temp host). A failed install leaves no
 * discoverable tool behind: the temp host is removed in `finally` and the
 * scope host is never touched.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { isPathInside } from '@opensip-cli/core';

import { admitToolPackage } from '../../bootstrap/admit-tool-package.js';
import { policyCiEvidenceFromCurrentEnv } from '../../bootstrap/policy-evidence.js';
import {
  evaluatePolicyPep,
  policyAuditFromCurrentScope,
  policyFromCurrentScope,
} from '../../bootstrap/policy-pep.js';
import { recordInstalledToolTrust } from '../../bootstrap/tool-trust.js';
import { addToolPlugin } from '../plugin-host-ops.js';

import { runToolValidation } from './validate.js';

import type { ToolsInstallResult, ToolsValidateResult } from '@opensip-cli/contracts';
import type { ToolPluginManifest } from '@opensip-cli/core';

/** Options for {@link toolsInstall}. */
export interface ToolsInstallOptions {
  readonly spec: string;
  readonly cwd: string;
  /** Install into the project `.runtime` tool host instead of user-global. */
  readonly project?: boolean;
}

/**
 * Expected npm-pack tarball basename from package.json identity
 * (`@scope/name` → `scope-name-version.tgz`). Never trust pack stdout alone.
 */
export function expectedNpmPackTarballName(packageName: string, version: string): string {
  const base = packageName.startsWith('@') ? packageName.slice(1).replace('/', '-') : packageName;
  return `${base}-${version}.tgz`;
}

/**
 * Resolve the packed tarball path inside `stagedPkgDir` without trusting
 * attacker-controlled `npm pack` stdout as a path (L7).
 *
 * Preference order:
 * 1. package.json name+version → expected basename (known identity)
 * 2. basename-only of the last pack stdout line, only if it is a bare `.tgz`
 *    name with no path separators / `..` and resolves inside the staged dir
 * @throws {Error} when the pack stdout cannot be safely resolved to a tarball
 *   inside the staged package dir (unsafe path, `..`, or outside the dir).
 */
export function resolvePackedTarballPath(stagedPkgDir: string, packStdout: string): string {
  let expected: string | undefined;
  try {
    const raw = JSON.parse(readFileSync(join(stagedPkgDir, 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    if (typeof raw.name === 'string' && typeof raw.version === 'string') {
      expected = expectedNpmPackTarballName(raw.name, raw.version);
    }
  } catch {
    // @swallow-ok package.json missing/malformed — fall through to basename validation.
  }

  const reportedLine = packStdout.trim().split('\n').at(-1)?.trim() ?? '';
  const reportedBase = reportedLine.length > 0 ? basename(reportedLine) : '';
  // Reject path components, parent segments, and non-tarball names in the
  // stdout-derived candidate. basename alone is not enough if the reported
  // line was already a bare hostile name that we should not prefer over identity.
  const stdoutSafe =
    reportedBase.length > 0 &&
    reportedBase === reportedLine &&
    !reportedBase.includes('..') &&
    !reportedBase.includes('/') &&
    !reportedBase.includes('\\') &&
    /\.tgz$/i.test(reportedBase);

  // Prefer package.json identity over pack stdout when both are available.
  const name = expected ?? (stdoutSafe ? reportedBase : '');
  if (name.length === 0 || name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error(
      'npm pack did not produce a usable tarball name (expected package.json name/version or a bare .tgz basename)',
    );
  }
  // Bare basename + join keeps the path inside stagedPkgDir; realpath containment
  // is an extra check once the file exists (symlink escape after pack).
  const tarball = join(stagedPkgDir, name);
  if (existsSync(tarball) && !isPathInside(tarball, stagedPkgDir)) {
    throw new Error(`npm pack tarball is outside the staged package dir: ${name}`);
  }
  return tarball;
}

/** Pack the staged package dir into a tarball beside it; returns the tarball path. */
function packStagedDir(stagedPkgDir: string): string {
  const out = execFileSync('npm', ['pack', '--pack-destination', stagedPkgDir, '.'], {
    cwd: stagedPkgDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', process.stderr],
  });
  return resolvePackedTarballPath(stagedPkgDir, out);
}

function installNextSteps(manifest: ToolPluginManifest | undefined): readonly string[] | undefined {
  if (manifest === undefined) return undefined;
  const commandName = manifest.commands[0]?.name;
  return commandName === undefined ? [] : [`opensip ${commandName}`];
}

function installFailure(args: {
  readonly spec: string;
  readonly scope: 'global' | 'project';
  readonly validation: ToolsValidateResult;
  readonly error?: string;
  readonly toolId?: string;
  readonly version?: string;
}): ToolsInstallResult {
  return {
    type: 'tools-install',
    spec: args.spec,
    success: false,
    scope: args.scope,
    validation: args.validation,
    ...(args.error === undefined ? {} : { error: args.error }),
    ...(args.toolId === undefined ? {} : { toolId: args.toolId }),
    ...(args.version === undefined ? {} : { version: args.version }),
  };
}

/** Stage, validate, and (on a `passed` verdict only) activate one tool package. */
export async function toolsInstall(opts: ToolsInstallOptions): Promise<ToolsInstallResult> {
  const scope = opts.project === true ? 'project' : 'global';
  const { result, stagedPkgDir, cleanup } = await runToolValidation(
    { spec: opts.spec, cwd: opts.cwd, installDeps: true },
    { keepStaged: true },
  );
  try {
    if (result.verdict !== 'passed') {
      return installFailure({ spec: opts.spec, scope, validation: result });
    }
    /* v8 ignore next 9 -- defensive: a passed verdict from a keepStaged run always carries the staged dir */
    if (stagedPkgDir === undefined) {
      return installFailure({
        spec: opts.spec,
        scope,
        validation: result,
        error: 'validation passed but no staged package dir was retained',
      });
    }

    const report = await admitToolPackage({
      dir: stagedPkgDir,
      source: 'installed',
      explicitlyRequested: true,
      staticOnly: true,
    });
    if (report.manifest === undefined) {
      return installFailure({
        spec: opts.spec,
        scope,
        validation: result,
        error: 'validated package could not be re-read for policy admission',
      });
    }

    const policyDecision = evaluatePolicyPep({
      policy: policyFromCurrentScope(),
      subject: { kind: 'installed-tool', id: report.manifest.id, source: 'installed' },
      action: 'install',
      evidence: {
        legacyTrusted: true,
        provenanceStatus: 'unavailable',
        ci: policyCiEvidenceFromCurrentEnv(),
      },
      audit: policyAuditFromCurrentScope(),
    });
    if (!policyDecision.allowed) {
      return installFailure({
        spec: opts.spec,
        scope,
        validation: result,
        toolId: report.manifest.id,
        version: report.manifest.version,
        error: `policy denied install: ${policyDecision.decision.reasons.join('; ')}`,
      });
    }

    // Activate the VALIDATED bytes: pack the staged dir, install the tarball.
    const tarball = packStagedDir(stagedPkgDir);
    const activation = addToolPlugin(tarball, opts.cwd, opts.project === true);
    if (activation.type !== 'plugin-add' || activation.success !== true) {
      const error =
        'error' in activation ? (activation.error ?? 'activation failed') : 'activation failed';
      return {
        type: 'tools-install',
        spec: opts.spec,
        success: false,
        scope,
        validation: result,
        error,
      };
    }

    if (report.manifest !== undefined && report.provenance !== undefined) {
      recordInstalledToolTrust({
        scope,
        cwd: opts.cwd,
        toolId: report.manifest.id,
        packageName: activation.packageName,
        version: report.manifest.version,
        manifestHash: report.provenance.manifestHash,
        installSourcePath: stagedPkgDir,
      });
    }
    return {
      type: 'tools-install',
      spec: opts.spec,
      success: true,
      scope,
      validation: result,
      ...(report.manifest === undefined
        ? {}
        : {
            toolId: report.manifest.id,
            version: report.manifest.version,
            trustReason: 'managed-install',
            nextSteps: installNextSteps(report.manifest),
          }),
    };
  } finally {
    cleanup();
  }
}
