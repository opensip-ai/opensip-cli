/**
 * Session persistence types.
 *
 * v2: storage moved from JSON files to SQLite (see `SessionRepo`).
 * This module is now a type-only facade — `StoredSession` and the
 * dashboard catalog entries stay here as the contract surface tools
 * use; runtime behavior lives in `session-repo.ts`.
 */

import { randomUUID } from 'node:crypto';

import type { ToolShortId } from '@opensip-tools/core';

/**
 * A persisted tool-run session.
 *
 * Holds only **generic** columns every tool shares — score, pass/fail,
 * timing, provenance. Per-session detail is tool-specific and lives in
 * the opaque {@link StoredSession.payload}: `contracts` (and the
 * persistence layer) hold ZERO tool vocabulary. Each tool owns the shape
 * of its own payload (`FitnessSessionPayload`, `GraphSessionPayload`,
 * …); the dashboard, as the presentation owner, reads the payload and
 * renders it — the same producer/consumer split already used for
 * `GraphCatalog`. (Audit 2026-05-29, session split.)
 */
export interface StoredSession {
  readonly id: string;
  readonly tool: ToolShortId;
  readonly timestamp: string;
  readonly cwd: string;
  readonly recipe?: string;
  readonly score: number;
  readonly passed: boolean;
  readonly durationMs: number;
  /**
   * Tool-owned opaque per-session detail. `contracts` treats this as
   * `unknown` and never inspects it; the producing tool owns and
   * validates its shape. Absent for tools that persist no detail.
   */
  readonly payload?: unknown;
}

// CheckCatalogEntry / RecipeCatalogEntry moved to fitness (audit
// 2026-05-29, L1) — they are fitness check/recipe catalog vocabulary,
// not a cross-cutting contract. The dashboard consumes them structurally
// via DashboardInput. See packages/fitness/engine/src/cli/dashboard.ts.

/** Generate a unique session ID */
export function generateSessionId(): string {
  return randomUUID();
}

/** Sanitize a string for use in a filename — strip path separators and special chars */
export function sanitizeForFilename(s: string): string {
  return s.replaceAll('..', '-').replaceAll(/[/\\:*?"<>|.]/g, '-');
}
