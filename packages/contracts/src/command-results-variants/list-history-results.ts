import type { StoredSession } from '../session-types.js';

export interface ListChecksResult {
  type: 'list-checks';
  checks: { slug: string; description: string; tags: string[] }[];
  totalCount: number;
  /**
   * Optional heading for the rendered list (tool-command-surface-taxonomy Task
   * 3.4). Lets a non-fitness producer reuse the shared `list-checks` shape +
   * `viewListChecks` renderer with an accurate title (e.g. `graph list` →
   * "Available Graph Rules"). Omitted ⇒ the renderer's default
   * "Available Fitness Checks" (the fit-list surface is unchanged).
   */
  title?: string;
}

export interface ListRecipesResult {
  type: 'list-recipes';
  recipes: { name: string; description: string; checkCount: string }[];
}

export interface HistorySession extends StoredSession {
  readonly summary?: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly errors: number;
    readonly warnings: number;
  };
  readonly showCommand: string;
}

export interface HistoryResult {
  type: 'history';
  sessions: HistorySession[];
}

export interface ReportResult {
  type: 'report';
  path: string;
  opened: boolean;
}