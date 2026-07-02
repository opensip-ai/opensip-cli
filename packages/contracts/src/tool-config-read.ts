import { ConfigurationError, isPlainRecord, type ToolCliContext } from '@opensip-cli/core';

import { configLifecycleEvent, emitAnalysisLifecycleEvent } from './run-lifecycle-events.js';

interface SafeParseSuccess<T> {
  readonly success: true;
  readonly data: T;
}

interface SafeParseFailure {
  readonly success: false;
  readonly error?: unknown;
}

/** Minimal safeParse-compatible parser shape accepted by host-owned tool config readers. */
export interface SafeToolConfigParser<T> {
  safeParse(input: unknown): SafeParseSuccess<T> | SafeParseFailure;
}

/** Parser accepted by host-owned tool config readers. */
export type ToolConfigParser<T> = SafeToolConfigParser<T> | ((input: unknown) => T);

/** @throws ConfigurationError when the tool namespace block fails parser validation. */
function parseToolConfig<T>(namespace: string, raw: unknown, parser: ToolConfigParser<T>): T {
  try {
    if (typeof parser === 'function') return parser(raw);
    const parsed = parser.safeParse(raw);
    if (parsed.success) return parsed.data;
    throw new ConfigurationError(`Invalid ${namespace} configuration block`, {
      cause: parsed.error,
    });
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(`Invalid ${namespace} configuration block`, { cause: error });
  }
}

/** Read and validate an optional tool namespace block from the current RunScope config. */
export function readOptionalToolConfig<T>(
  cli: ToolCliContext,
  namespace: string,
  parser: ToolConfigParser<T>,
): T | undefined {
  const raw = cli.scope.toolConfig?.[namespace];
  if (raw === undefined) {
    emitAnalysisLifecycleEvent(
      cli,
      configLifecycleEvent('analysis.config.defaulted', { namespace }),
    );
    return undefined;
  }
  if (!isPlainRecord(raw)) {
    emitAnalysisLifecycleEvent(
      cli,
      configLifecycleEvent('analysis.config.rejected', { namespace }),
    );
    throw new ConfigurationError(`Invalid ${namespace} configuration block`);
  }
  const parsed = parseToolConfig(namespace, raw, parser);
  emitAnalysisLifecycleEvent(cli, configLifecycleEvent('analysis.config.read', { namespace }));
  return parsed;
}

/** Read and validate a tool namespace block, falling back to the supplied default. */
export function readToolConfig<T>(
  cli: ToolCliContext,
  namespace: string,
  parser: ToolConfigParser<T>,
  defaultValue: T,
): T {
  return readOptionalToolConfig(cli, namespace, parser) ?? defaultValue;
}
