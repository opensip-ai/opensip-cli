/**
 * Small helpers extracted from `run-loop.ts` to keep the orchestration module
 * under the file-length soft gate.
 */

import { performance } from 'node:perf_hooks';

import { resolveProjectPaths } from '@opensip-cli/core';

import { asObject, getString } from './ingest-json.js';

import type {
  ExternalAdapterProgressBridge,
  ExternalAdapterProgressEvent,
  ExternalAdapterProgressStage,
} from './progress.js';
import type { AdapterRunContext, ExternalCommandSpec } from './types.js';
import type { ToolCliContext } from '@opensip-cli/core';

const ARTIFACT_EXT: Record<ExternalCommandSpec['output']['kind'], string> = {
  sarif: 'sarif',
  json: 'json',
  stdout: 'out',
};

export function defaultArtifactName(
  tool: string,
  kind: ExternalCommandSpec['output']['kind'],
): string {
  return `${tool}.${ARTIFACT_EXT[kind]}`;
}

export function configuredBinaryPath(
  config: Readonly<Record<string, unknown>>,
  tool: string,
): string | undefined {
  return getString(asObject(config.binaries)?.[tool], 'path');
}

export function emitProgress(
  bridge: ExternalAdapterProgressBridge | undefined,
  stage: ExternalAdapterProgressStage,
  status: 'start' | 'done',
  extra: Omit<ExternalAdapterProgressEvent, 'kind' | 'stage' | 'status'> = {},
): void {
  bridge?.emit({ kind: 'adapter-stage', stage, status, ...extra });
}

export async function progressStep<T>(
  bridge: ExternalAdapterProgressBridge | undefined,
  stage: ExternalAdapterProgressStage,
  fn: () => T | Promise<T>,
  deriveExtra?: (result: T) => Omit<ExternalAdapterProgressEvent, 'kind' | 'stage' | 'status'>,
): Promise<T> {
  emitProgress(bridge, stage, 'start');
  const begin = performance.now();
  try {
    const result = await fn();
    emitProgress(bridge, stage, 'done', {
      durationMs: Math.max(0, Math.round(performance.now() - begin)),
      ...deriveExtra?.(result),
    });
    return result;
  } catch (error) {
    emitProgress(bridge, stage, 'done', {
      detail: error instanceof Error ? error.name : 'error',
      durationMs: Math.max(0, Math.round(performance.now() - begin)),
    });
    throw error;
  }
}

export async function applyScanExclusion(
  cli: ToolCliContext,
  command: ExternalCommandSpec,
  ctx: AdapterRunContext,
  args: string[],
): Promise<void> {
  if (command.excludeScan === undefined) return;
  const exclusion = command.excludeScan({
    excludePath: resolveProjectPaths(ctx.projectRoot).runtimeDir,
    configPath: (name) => ctx.artifactPath(name),
  });
  if (exclusion.configFile !== undefined) {
    await cli.writeArtifact(exclusion.configFile.path, exclusion.configFile.contents);
  }
  if (exclusion.args !== undefined) args.push(...exclusion.args);
}

export function isEmptyReclaimedStdoutFindings(
  command: ExternalCommandSpec,
  code: number,
  verdict: 'ok' | 'findings' | 'fault',
  signalCount: number,
): boolean {
  return (
    command.output.kind === 'stdout' &&
    command.exitCodes?.findingsFromNonzero === true &&
    code !== 0 &&
    verdict === 'findings' &&
    signalCount === 0
  );
}
