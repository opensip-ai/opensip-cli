/**
 * Session persistence types.
 *
 * v2: storage moved from JSON files to SQLite (see `SessionRepo`).
 * This module is now a type-only facade — `StoredSession` and the
 * dashboard catalog entries stay here as the contract surface tools
 * use; runtime behavior lives in `session-repo.ts`.
 */

import { randomUUID } from 'node:crypto';

export interface StoredSession {
  readonly id: string;
  readonly tool: 'fit' | 'sim' | 'graph';
  readonly timestamp: string;
  readonly cwd: string;
  readonly recipe?: string;
  readonly score: number;
  readonly passed: boolean;
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly errors: number;
    readonly warnings: number;
  };
  readonly checks: readonly {
    readonly checkSlug: string;
    readonly passed: boolean;
    readonly violationCount?: number;
    readonly findings: readonly {
      readonly ruleId: string;
      readonly message: string;
      readonly severity: string;
      readonly filePath?: string;
      readonly line?: number;
      readonly column?: number;
      readonly suggestion?: string;
      readonly category?: string;
    }[];
    readonly durationMs: number;
  }[];
  readonly durationMs: number;
}

/** Check catalog entry for dashboard display */
export interface CheckCatalogEntry {
  readonly slug: string;
  readonly name: string;
  readonly icon: string;
  readonly description: string;
  readonly longDescription?: string;
  readonly tags: readonly string[];
  readonly confidence: 'high' | 'medium' | 'low';
  readonly source: 'built-in' | 'community';
}

/** Recipe catalog entry for dashboard display */
export interface RecipeCatalogEntry {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly selectorType: string;
  readonly mode: string;
  readonly timeout: number;
}

/** Generate a unique session ID */
export function generateSessionId(): string {
  return randomUUID();
}

/** Sanitize a string for use in a filename — strip path separators and special chars */
export function sanitizeForFilename(s: string): string {
  return s.replaceAll('..', '-').replaceAll(/[/\\:*?"<>|.]/g, '-');
}
