/**
 * @fileoverview Build the {@link AdapterRunContext} from a `ToolCliContext`
 * (ADR-0090, Phase-0 decision 8).
 *
 * Layer-legal: paths come from core `resolveProjectPaths`, NOT a `cli` import.
 * `scan` REQUIRES a project — a config-less/project-agnostic run has no targeting
 * root to scan, so a missing `projectContext` is a `ConfigurationError` (exit 2),
 * mirroring MCP's datastore-unavailable handling (Phase-0 decision 2).
 */

import { ConfigurationError, resolveProjectPaths } from '@opensip-cli/core';

import { resolveScannerArtifactPath } from './artifact-path.js';

import type { AdapterRunContext, ResolvedBinary } from './types.js';
import type { ToolCliContext } from '@opensip-cli/core';

export interface BuildRunContextInput {
  readonly cli: ToolCliContext;
  readonly tool: string;
  readonly adapterPackage?: string;
  readonly binary: ResolvedBinary;
  readonly config: Readonly<Record<string, unknown>>;
}

/**
 * Construct the per-run {@link AdapterRunContext}. Throws `ConfigurationError`
 * when no project scope is present (scan needs a targeting root).
 */
export function buildAdapterRunContext(input: BuildRunContextInput): AdapterRunContext {
  const project = input.cli.scope.projectContext;
  if (project === undefined) {
    throw new ConfigurationError(
      `Cannot run '${input.tool}': no opensip-cli project found here. ` +
        `Run 'opensip ${input.tool}' from inside an opensip-cli project (a directory with opensip-cli.config.yml).`,
      { code: 'ADAPTER.SCAN.NO_PROJECT' },
    );
  }
  const projectPaths = resolveProjectPaths(project.projectRoot);
  const runId = input.cli.scope.runId;
  return {
    tool: input.tool,
    adapterPackage: input.adapterPackage,
    projectRoot: project.projectRoot,
    runId,
    logger: input.cli.logger,
    config: input.config,
    binary: input.binary,
    configPath: project.configPath,
    artifactPath: (name) =>
      resolveScannerArtifactPath(
        { artifactDir: projectPaths.artifactDir, runId },
        input.tool,
        name,
      ),
  };
}
