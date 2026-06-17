import { admitTool, loadToolManifest, logger } from '@opensip-cli/core';

import { BOOTSTRAP_MODULE } from './register-tools-shared.js';

import type { ToolRuntimeLoad } from './admit-tool-package.js';
import type { ToolAdmission } from './tool-admission-types.js';

/**
 * Run the admission gate over a discovered INSTALLED tool package before its
 * module is imported. Installed tools are best-effort: incompatible or malformed
 * ambient packages skip with diagnostics rather than crashing unrelated commands.
 */
export function admitInstalledTool(
  pkg: { readonly name: string; readonly packageDir: string },
  builtInIds: ReadonlySet<string>,
): ToolAdmission | undefined {
  const manifest = loadToolManifest('installed', pkg.packageDir);
  if (manifest === undefined) {
    process.stderr.write(
      `opensip: tool package ${pkg.name} has no conformant package.json#opensipTools manifest — skipping\n`,
    );
    logger.warn({
      evt: 'cli.tool.manifest_invalid',
      module: BOOTSTRAP_MODULE,
      name: pkg.name,
    });
    return undefined;
  }
  if (builtInIds.has(manifest.id)) return undefined;

  const result = admitTool({
    manifest,
    source: 'installed',
    dir: pkg.packageDir,
    packageName: pkg.name,
    explicitlyRequested: false,
  });
  if (result.decision !== 'admit') return undefined;
  return { provenance: result.provenance, manifest: result.manifest };
}

/**
 * Emit the best-effort stderr line + structured warning for a discovered
 * INSTALLED tool whose runtime failed to load. Each failure reason maps to its
 * own diagnostic while preserving the installed leg's skip-not-crash posture.
 */
export function emitInstalledLoadFailure(
  name: string,
  load: Extract<ToolRuntimeLoad, { ok: false }>,
): void {
  if (load.reason === 'no-entry') {
    process.stderr.write(
      `opensip: tool package ${name} has no resolvable entry point — skipping\n`,
    );
    logger.warn({ evt: 'cli.tool.no_entry', module: BOOTSTRAP_MODULE, name });
    return;
  }
  if (load.reason === 'invalid-shape') {
    process.stderr.write(
      `opensip: tool package ${name} does not export a valid \`tool\` — skipping\n`,
    );
    logger.warn({
      evt: 'cli.tool.invalid_shape',
      module: BOOTSTRAP_MODULE,
      name,
    });
    return;
  }
  process.stderr.write(`opensip: failed to load tool ${name}: ${load.detail ?? 'import failed'}\n`);
  logger.warn({
    evt: 'cli.tool.load_failed',
    module: BOOTSTRAP_MODULE,
    name,
    error: load.detail,
  });
}
