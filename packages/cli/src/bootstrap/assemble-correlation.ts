import { basename } from 'node:path';

import { resolveApiKey } from '@opensip-cli/config';
import { currentTraceparent, type ProjectContext, type RunCorrelation } from '@opensip-cli/core';

/** Inputs for {@link assembleCorrelation}. */
export interface AssembleCorrelationInput {
  readonly runId: string;
  readonly tool: string;
  readonly parentCommand: string;
  readonly apiKey?: string;
  readonly noCloud?: boolean;
  readonly effectiveCloud: { readonly sync?: boolean; readonly endpoint?: string } | undefined;
  readonly project: ProjectContext;
  readonly cwd: string;
}

/** Assemble the cloud-aware {@link RunCorrelation} bag and diagnostics facts. */
export function assembleCorrelation(input: AssembleCorrelationInput): {
  readonly correlation: RunCorrelation;
  readonly cloudActive: boolean;
  readonly traceId: string | undefined;
} {
  const cloudActive =
    resolveApiKey(input.apiKey) !== undefined &&
    input.noCloud !== true &&
    input.effectiveCloud?.sync !== false;

  const repoBaseDir = input.project.scope === 'project' ? input.project.projectRoot : input.cwd;
  const repo = cloudActive ? basename(repoBaseDir) || undefined : undefined;

  const traceId = currentTraceparent();

  const correlation: RunCorrelation = {
    runId: input.runId,
    tool: input.tool,
    parentCommand: input.parentCommand,
    ...(traceId ? { traceId } : {}),
    ...(repo ? { repo } : {}),
  };

  return { correlation, cloudActive, traceId };
}
