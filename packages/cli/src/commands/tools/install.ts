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

import { admitToolPackage } from '../../bootstrap/admit-tool-package.js';
import { addToolPlugin } from '../plugin-host-ops.js';

import { runToolValidation } from './validate.js';

import type { ToolsInstallResult } from '@opensip-cli/contracts';
import type { ToolPluginManifest } from '@opensip-cli/core';

/** Options for {@link toolsInstall}. */
export interface ToolsInstallOptions {
  readonly spec: string;
  readonly cwd: string;
  /** Install into the project `.runtime` tool host instead of user-global. */
  readonly project?: boolean;
}

/** Pack the staged package dir into a tarball beside it; returns the tarball path. */
function packStagedDir(stagedPkgDir: string): string {
  const out = execFileSync('npm', ['pack', '--pack-destination', stagedPkgDir, '.'], {
    cwd: stagedPkgDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', process.stderr],
  });
  const name = out.trim().split('\n').at(-1)?.trim() ?? '';
  return `${stagedPkgDir}/${name}`;
}

function installNextSteps(manifest: ToolPluginManifest | undefined): readonly string[] | undefined {
  if (manifest === undefined) return undefined;
  const commandName = manifest.commands[0]?.name;
  return [
    `export OPENSIP_CLI_ALLOW_INSTALLED_TOOLS='${manifest.id}'`,
    ...(commandName === undefined ? [] : [`opensip ${commandName}`]),
  ];
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
      return {
        type: 'tools-install',
        spec: opts.spec,
        success: false,
        scope,
        validation: result,
      };
    }
    /* v8 ignore next 9 -- defensive: a passed verdict from a keepStaged run always carries the staged dir */
    if (stagedPkgDir === undefined) {
      return {
        type: 'tools-install',
        spec: opts.spec,
        success: false,
        scope,
        validation: result,
        error: 'validation passed but no staged package dir was retained',
      };
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

    // Inventory row from the ACTIVATED install (manifest file read — no import).
    const report = await admitToolPackage({
      dir: stagedPkgDir,
      source: 'installed',
      explicitlyRequested: true,
      staticOnly: true,
    });
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
            nextSteps: installNextSteps(report.manifest),
          }),
    };
  } finally {
    cleanup();
  }
}
