import type { ToolCliContext } from '@opensip-cli/core';

export type ExternalAdapterProgressStage =
  | 'resolve-binary'
  | 'prepare-artifacts'
  | 'run-scanner'
  | 'ingest-report'
  | 'store-evidence'
  | 'deliver-signals';

export interface ExternalAdapterProgressEvent {
  readonly kind: 'adapter-stage';
  readonly stage: ExternalAdapterProgressStage;
  readonly status: 'start' | 'done';
  readonly detail?: string;
  readonly durationMs?: number;
  readonly findings?: number;
  readonly signals?: number;
}

export interface ExternalAdapterProgressBridge {
  readonly mode: 'static' | 'live';
  readonly suppressHumanRender: boolean;
  emit(event: ExternalAdapterProgressEvent): void;
}

export const EXTERNAL_ADAPTER_PROGRESS = Symbol.for('@opensip-cli/external-tool-adapter/progress');

type ProgressCarrier = Record<symbol, ExternalAdapterProgressBridge | undefined>;

export function attachExternalAdapterProgress<T extends ToolCliContext>(
  ctx: T,
  bridge: ExternalAdapterProgressBridge,
): T {
  Object.defineProperty(ctx as unknown as ProgressCarrier, EXTERNAL_ADAPTER_PROGRESS, {
    configurable: true,
    enumerable: false,
    value: bridge,
  });
  return ctx;
}

export function externalAdapterProgressOf(
  ctx: ToolCliContext,
): ExternalAdapterProgressBridge | undefined {
  return (ctx as unknown as ProgressCarrier)[EXTERNAL_ADAPTER_PROGRESS];
}
