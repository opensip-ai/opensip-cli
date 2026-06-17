import {
  admitTool,
  loadToolManifest,
  PluginIncompatibleError,
  PROJECT_LOCAL_MANIFEST_FILE,
  type ToolSource,
} from '@opensip-cli/core';

import { isProjectLocalToolTrusted } from './tool-trust.js';

import type { ToolAdmission } from './tool-admission-types.js';

export type AuthoredAdmission = ToolAdmission;

/**
 * The shared admission tail for both authored sources. When `preloadedManifest`
 * is supplied we use that snapshot so the trust decision and compatibility gate
 * see the identical declaration.
 *
 * @throws {PluginIncompatibleError} When the sidecar manifest is missing,
 * malformed, or rejected by the compatibility gate.
 */
function admitAuthoredTool(
  source: ToolSource,
  dir: string,
  preloadedManifest?: ReturnType<typeof loadToolManifest>,
): AuthoredAdmission {
  const rawManifest = preloadedManifest ?? loadToolManifest(source, dir);
  if (rawManifest === undefined) {
    throw new PluginIncompatibleError(
      `${source} tool at '${dir}' has no conformant ${PROJECT_LOCAL_MANIFEST_FILE} sidecar`,
      { diagnostic: 'manifest missing or malformed' },
    );
  }

  const result = admitTool({
    manifest: rawManifest,
    source,
    dir,
    explicitlyRequested: true,
  });
  if (result.decision !== 'admit') {
    throw new PluginIncompatibleError(
      `${source} tool '${rawManifest.id}' is incompatible: ${result.diagnostic ?? 'compatibility gate rejected it'}`,
      { diagnostic: result.diagnostic },
    );
  }
  return { provenance: result.provenance, manifest: result.manifest };
}

/**
 * Admit or reject a PROJECT-LOCAL authored tool under the deny-by-default trust
 * policy. The trust decision always precedes module import; a non-allowlisted
 * tool fails closed before any authored code can run.
 *
 * @throws {PluginIncompatibleError} When the sidecar manifest is missing,
 * malformed, incompatible, or not trusted by the project-tool allowlist.
 */
export function admitProjectLocalTool(args: {
  readonly dir: string;
  readonly env?: NodeJS.ProcessEnv;
}): AuthoredAdmission {
  const manifest = loadToolManifest('project-local', args.dir);
  if (manifest === undefined) {
    throw new PluginIncompatibleError(
      `project-local tool at '${args.dir}' has no conformant ${PROJECT_LOCAL_MANIFEST_FILE} sidecar`,
      { diagnostic: 'manifest missing or malformed' },
    );
  }
  if (!isProjectLocalToolTrusted(manifest.id, args.env)) {
    throw new PluginIncompatibleError(
      `project-local tool '${manifest.id}' is not trusted to load (deny-by-default). ` +
        `Allowlist it via OPENSIP_CLI_ALLOW_PROJECT_TOOLS='${manifest.id}' to admit it.`,
      { diagnostic: 'project-local tool not allowlisted (deny-by-default)' },
    );
  }
  return admitAuthoredTool('project-local', args.dir, manifest);
}

/**
 * Admit a USER-GLOBAL authored tool — trusted-by-default because the user placed
 * it in their own home-dir tool host, but still fail-closed on a missing or
 * incompatible manifest.
 */
export function admitUserGlobalTool(args: { readonly dir: string }): AuthoredAdmission {
  return admitAuthoredTool('user-global', args.dir);
}
