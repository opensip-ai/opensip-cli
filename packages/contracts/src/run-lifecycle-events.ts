import type { DiagnosticsBus, ToolCliContext } from '@opensip-cli/core';

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

function compactMetadata(metadata: LifecycleMetadata = {}): LifecycleMetadata {
  const compacted: Record<string, LifecycleMetadataValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) compacted[key] = value;
  }
  return compacted;
}

function eventPhase(event: AnalysisLifecycleEvent): Parameters<DiagnosticsBus['event']>[0] {
  if (event.startsWith('analysis.delivery.')) return 'deliver';
  // The old untyped seam emitted a phase 'error' here — a value the real
  // DiagnosticPhase union never contained (the cast hid the mismatch). A
  // config rejection is a validate-phase event; error-ness rides the level.
  if (event === 'analysis.config.rejected') return 'validate';
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
  // Typed seam (plan 09 Task 8.5): `scope.diagnostics` is an optional typed
  // member of the core ToolScope and `logger` is a REQUIRED context member —
  // the former double-casts erased that required-ness, so a wiring regression
  // would have silently no-op'd.
  cli.scope.diagnostics?.event(eventPhase(record.event), 'debug', record.event, record.metadata);
  cli.logger.debug({
    evt: record.event,
    module: 'contracts:analysis-run',
    ...record.metadata,
  });
}
