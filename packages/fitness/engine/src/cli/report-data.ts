// @fitness-ignore-file error-handling-quality -- report-data collection is a best-effort UX action: signalers-config load failures degrade gracefully to ungoverned mode (surfaced separately by the fitness run). The CLI composition root owns file-writing and browser launch; this module only contributes fitness's catalog inputs.
/**
 * report-data contribution — fitness's inputs to the cross-tool HTML
 * report.
 *
 * Audit 2026-05-29 (L2): the CLI is now the report composition root.
 * Fitness no longer loads sessions, the graph catalog, writes the file,
 * or opens the browser. It just returns ITS OWN dashboard inputs (the
 * check + recipe catalogs and the editor protocol) keyed by the field
 * names `generateDashboardHtml` consumes. The CLI walks every tool's
 * `collectReportData` and merges the contributions into one
 * `DashboardInput`. This decouples fitness from graph entirely.
 */

import { currentCheckRegistry, currentRecipeRegistry } from '../framework/scope-registry.js';
import { loadSignalersConfig } from '../signalers/index.js';

import { ensureChecksLoaded, getDisplayName, getIcon } from './fit.js';

import type { ToolScope } from '@opensip-cli/core';

// ---------------------------------------------------------------------------
// Dashboard catalog entries (fitness-owned)
//
// Audit 2026-05-29 (L1): these describe fitness's check/recipe catalogs
// rendered on the dashboard. They are fitness domain vocabulary, so they
// live here rather than in @opensip-cli/contracts. The dashboard, as
// the presentation owner, consumes them structurally via DashboardInput
// (typed `readonly unknown[]`) — the same opaque-payload model used for
// session detail and the graph catalog.
// ---------------------------------------------------------------------------

/** Check catalog entry for dashboard display. */
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

/** Recipe catalog entry for dashboard display. */
export interface RecipeCatalogEntry {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly selectorType: string;
  readonly mode: string;
  readonly timeout: number;
}

// ---------------------------------------------------------------------------
// collectFitnessReportData
// ---------------------------------------------------------------------------

/**
 * "built-in" vs "community" classification for the dashboard catalog.
 * Anything registered under the @opensip-cli/ scope is first-party;
 * anything else (loose plugin file, third-party npm package) is
 * community. We no longer match a single magic package name — the
 * scope rule keeps working when checks-builtin is split into multiple
 * first-party packages (checks-typescript, checks-universal, etc).
 */
const FIRST_PARTY_SCOPE = '@opensip-cli/';

function classifyCheckSource(namespace: string | undefined): 'built-in' | 'community' {
  return namespace?.startsWith(FIRST_PARTY_SCOPE) ? 'built-in' : 'community';
}

/**
 * Read the project's `dashboard.editor` value (if any) via the shared
 * signalers loader. The Code Paths panel embeds it as a JS constant so
 * the Function Card can produce vscode://, cursor://, etc. deep links.
 *
 * Returns `null` when no config file exists or the value is unset —
 * the dashboard renders without a deep-link editor protocol in that
 * case (graceful degradation; the panel falls back to plain paths).
 */
function loadEditorProtocol(projectDir?: string): string | null {
  try {
    const config = loadSignalersConfig(projectDir ?? process.cwd());
    return config.dashboard?.editor ?? null;
  } catch {
    // No config / parse error — dashboard runs ungoverned. The fitness
    // run itself surfaces a config-load failure separately.
    return null;
  }
}

/**
 * Fitness's report-data contribution (audit 2026-05-29, L2). Returns
 * the check catalog, recipe catalog, and editor protocol under the keys
 * `generateDashboardHtml` consumes. Best-effort: a missing signalers
 * config degrades the editor protocol to null; catalog building always
 * succeeds once checks are loaded. The CLI merges this onto the shared
 * `DashboardInput` alongside other tools' contributions.
 */
export async function collectFitnessReportData(scope: ToolScope): Promise<Record<string, unknown>> {
  const projectDir = scope.projectContext?.projectRoot;
  await ensureChecksLoaded(projectDir);

  const checkRegistry = currentCheckRegistry();
  const checkCatalog: CheckCatalogEntry[] = checkRegistry.list().map((check) => {
    const namespace = checkRegistry.getNamespace(check.config.slug);
    return {
      slug: check.config.slug,
      name: getDisplayName(check.config.slug),
      icon: getIcon(check.config.slug),
      description: check.config.description,
      longDescription: check.config.longDescription,
      tags: [...(check.config.tags ?? [])],
      confidence: check.config.confidence ?? 'medium',
      source: classifyCheckSource(namespace),
    };
  });

  const recipeCatalog: RecipeCatalogEntry[] = [...currentRecipeRegistry().getAllRecipes()].map(
    (r) => ({
      name: r.name,
      displayName: r.displayName,
      description: r.description,
      tags: [...(r.tags ?? [])],
      selectorType: r.checks.type,
      mode: r.execution.mode,
      timeout: r.execution.timeout ?? 30_000,
    }),
  );

  const editorProtocol = loadEditorProtocol(projectDir);

  return { checkCatalog, recipeCatalog, editorProtocol };
}
