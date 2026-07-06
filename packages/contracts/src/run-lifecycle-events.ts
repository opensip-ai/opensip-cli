import type { ToolCliContext } from '@opensip-cli/core';

export type RunLifecycleEvent =
  'analysis.run.started' | 'analysis.run.completed' | 'analysis.run.failed';

export type UnitLifecycleEvent =
  'analysis.unit.started' | 'analysis.unit.completed' | 'analysis.unit.failed';

export type DeliveryLifecycleEvent =
  'analysis.delivery.started' | 'analysis.delivery.completed' | 'analysis.delivery.failed';

export type ConfigLifecycleEvent =
  'analysis.config.read' | 'analysis.config.defaulted' | 'analysis.config.rejected';

export type AnalysisLifecycleEvent =
  RunLifecycleEvent | UnitLifecycleEvent | DeliveryLifecycleEvent | ConfigLifecycleEvent;

export type LifecycleMetadataValue =
  string | number | boolean | null | undefined | readonly (string | number | boolean | null)[];

export type LifecycleMetadata = Readonly<Record<string, LifecycleMetadataValue>>;

export interface AnalysisLifecycleRecord<TEvent extends AnalysisLifecycleEvent> {
  readonly event: TEvent;
  readonly metadata: LifecycleMetadata;
}

interface DiagnosticsLike {
  event(
    phase: 'execute' | 'deliver' | 'load' | 'render' | 'persist' | 'error',
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    data?: Readonly<Record<string, unknown>>,
  ): void;
}

interface LoggerLike {
  debug(msgOrObj: string | Record<string, unknown>, data?: Record<string, unknown>): void;
}

function compactMetadata(metadata: LifecycleMetadata = {}): LifecycleMetadata {
  const compacted: Record<string, LifecycleMetadataValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) compacted[key] = value;
  }
  return compacted;
}

function eventPhase(event: AnalysisLifecycleEvent): Parameters<DiagnosticsLike['event']>[0] {
  if (event.startsWith('analysis.delivery.')) return 'deliver';
  if (event === 'analysis.config.rejected') return 'error';
  if (event.startsWith('analysis.config.')) return 'load';
  return 'execute';
}

export function runLifecycleEvent(
  event: RunLifecycleEvent,
  metadata: LifecycleMetadata = {},
): AnalysisLifecycleRecord<RunLifecycleEvent> {
  return { event, metadata: compactMetadata(metadata) };
}

export function unitLifecycleEvent(
  event: UnitLifecycleEvent,
  metadata: LifecycleMetadata = {},
): AnalysisLifecycleRecord<UnitLifecycleEvent> {
  return { event, metadata: compactMetadata(metadata) };
}

export function deliveryLifecycleEvent(
  event: DeliveryLifecycleEvent,
  metadata: LifecycleMetadata = {},
): AnalysisLifecycleRecord<DeliveryLifecycleEvent> {
  return { event, metadata: compactMetadata(metadata) };
}

export function configLifecycleEvent(
  event: ConfigLifecycleEvent,
  metadata: LifecycleMetadata = {},
): AnalysisLifecycleRecord<ConfigLifecycleEvent> {
  return { event, metadata: compactMetadata(metadata) };
}

export function emitAnalysisLifecycleEvent(
  cli: ToolCliContext,
  record: AnalysisLifecycleRecord<AnalysisLifecycleEvent>,
): void {
  const diagnostics = (cli as unknown as { scope?: { diagnostics?: DiagnosticsLike } }).scope
    ?.diagnostics;
  diagnostics?.event(eventPhase(record.event), 'debug', record.event, record.metadata);
  const logger = (cli as unknown as { logger?: LoggerLike }).logger;
  logger?.debug({
    evt: record.event,
    module: 'contracts:analysis-run',
    ...record.metadata,
  });
}
