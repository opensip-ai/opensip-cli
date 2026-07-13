/** Captured read-only replay boundary for an `agent-context` parent Run. */

import type { ContextPointerStatus } from './graph-read-port.js';
import type { McpReadError } from './mcp-error.js';
import type {
  RunStepReference,
  StoredRunAggregate,
  StoredRunSource,
  TaskContextFileScope,
  TaskContextManifest,
} from '@opensip-cli/contracts';
import type { Result } from '@opensip-cli/core';

export interface ContextRunReference {
  readonly runId?: string;
  readonly files?: readonly string[];
}

export interface ContextRunMetadata {
  readonly id: string;
  readonly name: string;
  readonly source: StoredRunSource;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly aggregate: StoredRunAggregate;
  readonly cliVersion?: string;
}

export interface ContextStatusDto {
  readonly status: 'available' | 'missing' | 'unavailable';
  readonly run?: ContextRunMetadata;
  readonly manifest?: TaskContextManifest;
  readonly fileScope: {
    readonly status: 'matched' | 'mismatched' | 'not-requested';
    readonly requested?: TaskContextFileScope;
    readonly recorded?: TaskContextFileScope;
  };
  readonly steps: readonly RunStepReference[];
  readonly pointers: readonly ContextPointerStatus[];
  readonly reasonCodes: readonly string[];
  readonly nextActions: readonly string[];
}

export interface ContextReadPort {
  /** Replay latest project context or one exact Run ID; never starts producers. */
  contextStatus(
    ref?: ContextRunReference,
    signal?: AbortSignal,
  ): Promise<Result<ContextStatusDto, McpReadError>>;
}
