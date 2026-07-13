/** Captured, read-only project inventory boundary for MCP handlers. */

import type { McpReadError } from './mcp-error.js';
import type {
  ContextCoverage,
  FileFact,
  PackageFact,
  ProjectFact,
  ProjectInventorySnapshot,
} from '@opensip-cli/contracts';
import type { Result } from '@opensip-cli/core';

export interface CodebaseFreshness {
  readonly fresh: boolean;
  readonly capturedAt: string;
  readonly verification: 'complete' | 'partial' | 'missing';
  readonly reasonCodes: readonly string[];
}

export interface CodebaseInventoryStatus {
  readonly snapshot: ProjectInventorySnapshot;
  readonly identity: string;
  readonly coverage: ContextCoverage;
  readonly freshness: CodebaseFreshness;
  readonly nextActions: readonly string[];
}

export interface FileContextDto {
  readonly status: 'found' | 'excluded' | 'unknown' | 'unavailable';
  readonly file?: FileFact;
  readonly package?: PackageFact;
  readonly project: ProjectFact;
  readonly inventoryIdentity: string;
  readonly coverage: ContextCoverage;
  readonly freshness: CodebaseFreshness;
  readonly reasonCodes: readonly string[];
  readonly nextActions: readonly string[];
}

/** Freshness policy for a bounded inventory status read. */
export interface InventoryStatusOptions {
  /** Bypass the completed two-second read-burst cache. In-flight work may still be coalesced. */
  readonly forceFresh?: boolean;
}

export interface CodebaseReadPort {
  /** Build or reuse the one bounded inventory captured by this served project. */
  inventoryStatus(
    signal?: AbortSignal,
    options?: InventoryStatusOptions,
  ): Promise<Result<CodebaseInventoryStatus, McpReadError>>;
  /** Project metadata for one exact path; never returns source text. */
  fileContext(file: string, signal?: AbortSignal): Promise<Result<FileContextDto, McpReadError>>;
}
