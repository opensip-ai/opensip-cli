/**
 * register-authored-tools — admission + discovery for AUTHORED Tool sidecars
 * (project-local + user-global), extracted from register-tools-discovery.ts so
 * the installed-package discovery path stays a focused module under the
 * file-length soft limit.
 *
 * Authored tools are authored CONTENT (a JSON sidecar, not an installed npm
 * package): project-local is deny-by-default (allowlisted via
 * `OPENSIP_CLI_ALLOW_PROJECT_TOOLS`), user-global is trusted-by-default. Both are
 * EXTERNAL provenance, so ADR-0054 M4-G applies: in the HOST the registration
 * registers a manifest-derived synthetic `Tool` (no runtime import); the dispatch
 * WORKER (`OPENSIP_CLI_IN_TOOL_WORKER=1`) imports the real runtime.
 */

import {
  admitTool,
  assertManifestMatchesTool,
  discoverAuthoredToolSidecars,
  loadToolManifest,
  PluginIncompatibleError,
  PROJECT_LOCAL_MANIFEST_FILE,
  type ToolPluginManifest,
  type ToolProvenance,
  type ToolRegistry,
  type ToolSource,
} from '@opensip-cli/core';

import { importToolRuntime, workerRuntimeImportPolicyFor } from './admit-tool-package.js';
import { synthesizeExternalTool } from './synthesize-external-tool.js';
import { isHostRuntimeImportForbidden } from './tool-provenance.js';
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

/**
 * Discover + admit + register AUTHORED Tool sidecars from the two authored
 * roots. ADR-0054 M4-G: authored tools are always EXTERNAL provenance, so the
 * HOST registers a manifest-derived synthetic Tool (no runtime import); the
 * dispatch WORKER (`OPENSIP_CLI_IN_TOOL_WORKER=1`) imports the real runtime via
 * the shared `importToolRuntime` seam.
 */
export async function discoverAndRegisterAuthoredTools(
  registry: ToolRegistry,
  opts: {
    readonly projectAuthoredDir?: string;
    readonly globalAuthoredDir: string;
    readonly env?: NodeJS.ProcessEnv;
  },
  builtInIds: ReadonlySet<string>,
  provenance: ToolProvenance[] = [],
  manifests: ToolPluginManifest[] = [],
): Promise<void> {
  const env = opts.env ?? process.env;
  for (const candidate of discoverAuthoredToolSidecars(opts.globalAuthoredDir)) {
    await admitAndRegisterAuthored({
      registry,
      admission: admitUserGlobalTool({ dir: candidate.dir }),
      dir: candidate.dir,
      builtInIds,
      provenance,
      manifests,
      env,
    });
  }
  if (opts.projectAuthoredDir !== undefined) {
    for (const candidate of discoverAuthoredToolSidecars(opts.projectAuthoredDir)) {
      await admitAndRegisterAuthored({
        registry,
        admission: admitProjectLocalTool({ dir: candidate.dir, env: opts.env }),
        dir: candidate.dir,
        builtInIds,
        provenance,
        manifests,
        env,
      });
    }
  }
}

interface AuthoredRegisterArgs {
  readonly registry: ToolRegistry;
  readonly admission: AuthoredAdmission;
  readonly dir: string;
  readonly builtInIds: ReadonlySet<string>;
  readonly provenance: ToolProvenance[];
  readonly manifests: ToolPluginManifest[];
  readonly env: NodeJS.ProcessEnv;
}

/** @throws {PluginIncompatibleError} When the authored tool runtime fails to load. */
async function admitAndRegisterAuthored(args: AuthoredRegisterArgs): Promise<void> {
  const { registry, admission, dir, builtInIds, provenance, manifests, env } = args;
  const { provenance: prov, manifest } = admission;
  if (builtInIds.has(prov.id)) return;

  // ADR-0054 M4-G (capstone): authored tools are EXTERNAL. In the HOST, register
  // a manifest-derived synthetic Tool — never import the untrusted runtime. The
  // dispatch WORKER imports the real runtime (the isolation boundary). The trust
  // gate already ran in `admitProjectLocalTool` (deny-by-default), so a
  // non-allowlisted tool never reaches here.
  if (isHostRuntimeImportForbidden(env)) {
    const tool = synthesizeExternalTool(manifest);
    registry.register(tool);
    provenance.push(prov);
    manifests.push(manifest);
    return;
  }

  const load = await importToolRuntime(dir, workerRuntimeImportPolicyFor(prov.source));
  if (!load.ok) {
    const detailSuffix = load.detail ? `: ${load.detail}` : '';
    throw new PluginIncompatibleError(
      `${prov.source} tool '${prov.id}' failed to load via the plugin path (${load.reason}${detailSuffix})`,
      { diagnostic: `authored tool runtime load failed: ${load.reason}` },
    );
  }

  assertManifestMatchesTool(manifest, load.tool);

  registry.register(load.tool);
  provenance.push(prov);
  manifests.push(manifest);
}
