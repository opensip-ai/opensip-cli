// @fitness-ignore-file error-handling-quality -- dashboard is a best-effort UX action: signalers-config load failures degrade gracefully to ungoverned mode (surfaced separately by the fitness run), and browser launch failures fall through to "open manually" (the report file path is already returned to the user).
/**
 * dashboard command — generate HTML report and open in browser
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync , mkdirSync } from 'node:fs';
import { join } from 'node:path';


import {
  SessionRepo,
  type CheckCatalogEntry,
  type GraphCatalog,
  type RecipeCatalogEntry,
  type DashboardResult,
} from '@opensip-tools/contracts';
import { logger, resolveProjectPaths } from '@opensip-tools/core';
import { generateDashboardHtml } from '@opensip-tools/dashboard';
import { sql } from 'drizzle-orm';


import { defaultRegistry } from '../framework/registry.js';
import { defaultRecipeRegistry } from '../recipes/registry.js';
import { loadSignalersConfig } from '../signalers/index.js';

import { ensureChecksLoaded, getDisplayName, getIcon } from './fit.js';

import type { DataStore } from '@opensip-tools/datastore';

// ---------------------------------------------------------------------------
// openDashboard
// ---------------------------------------------------------------------------

/**
 * "built-in" vs "community" classification for the dashboard catalog.
 * Anything registered under the @opensip-tools/ scope is first-party;
 * anything else (loose plugin file, third-party npm package) is
 * community. We no longer match a single magic package name — the
 * scope rule keeps working when checks-builtin is split into multiple
 * first-party packages (checks-typescript, checks-universal, etc).
 */
const FIRST_PARTY_SCOPE = '@opensip-tools/';

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
 * Read the graph catalog from the datastore's `graph_catalog` table.
 * Returns null when no datastore is available (e.g. the auto-open flow
 * that doesn't pass one) or when the catalog table is empty — the
 * dashboard renders the Code Paths panel in a no-data state.
 *
 * Why raw SQL instead of importing `CatalogRepo` from `@opensip-tools/graph`:
 * graph already depends on fitness (the SARIF helpers — DEC-3), so a
 * fitness → graph dep would create a build cycle. The graph_catalog
 * table schema is stable and documented in
 * `packages/graph/engine/src/persistence/schema.ts`. The dashboard
 * reads `payload` (typed columns aren't needed for rendering) and
 * deserializes it as the `GraphCatalog` shape the renderer expects.
 *
 * If a non-cyclic seam ever becomes available (e.g. SARIF helpers
 * relocated to a lower layer breaking the graph → fitness edge), this
 * function should switch to importing the repo class.
 */
interface GraphCatalogRow {
  readonly payload: string;
}

function loadGraphCatalog(datastore?: DataStore): GraphCatalog | null {
  if (!datastore) return null;
  try {
    const row = datastore.db
      .get<GraphCatalogRow>(sql`SELECT payload FROM graph_catalog WHERE id = 1`);
    if (!row) {
      logger.info({
        evt: 'graph.dashboard.catalog.miss',
        module: 'fitness:dashboard',
        msg: 'No graph_catalog row in datastore; rendering panel without it',
      });
      return null;
    }
    const parsed = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as GraphCatalog;
    logger.info({
      evt: 'graph.dashboard.catalog.load',
      module: 'fitness:dashboard',
      msg: 'Loaded graph catalog from datastore',
      functions: Object.keys(parsed.functions).length,
    });
    return parsed;
  } catch (error) {
    logger.warn({
      evt: 'graph.dashboard.catalog.read-error',
      module: 'fitness:dashboard',
      msg: 'Failed to read graph catalog from datastore; rendering panel without it',
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function openDashboard(
  projectDir?: string,
  datastore?: DataStore,
): Promise<DashboardResult> {
  await ensureChecksLoaded(projectDir);

  const sessions = datastore ? [...new SessionRepo(datastore).list({ limit: 20 })] : [];

  const catalog: CheckCatalogEntry[] = defaultRegistry.list().map(check => {
    const namespace = defaultRegistry.getNamespace(check.config.slug);
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

  // Collect recipe catalog
  const recipes: RecipeCatalogEntry[] = [...defaultRecipeRegistry.getAllRecipes()].map(r => ({
    name: r.name,
    displayName: r.displayName,
    description: r.description,
    tags: [...(r.tags ?? [])],
    selectorType: r.checks.type,
    mode: r.execution.mode,
    timeout: r.execution.timeout ?? 30_000,
  }));

  const graphCatalog = loadGraphCatalog(datastore);
  const editorProtocol = loadEditorProtocol(projectDir);

  const html = generateDashboardHtml({
    sessions,
    checkCatalog: catalog,
    recipeCatalog: recipes,
    graphCatalog,
    editorProtocol,
  });
  const paths = resolveProjectPaths(projectDir ?? process.cwd());
  mkdirSync(paths.reportsDir, { recursive: true });
  const reportPath = join(paths.reportsDir, 'latest.html');
  writeFileSync(reportPath, html, 'utf8');

  // Try to open in browser
  let opened = false;
  try {
    const platform = process.platform;
    // @fitness-ignore-next-line no-hardcoded-timeouts -- 5s ceiling for the synchronous browser-opener (open/xdg-open/cmd start); the OS shell call should return immediately, so a fixed safety timeout is preferable to a configurable knob users would never tune
    const execOpts = { timeout: 5000 };
    if (platform === 'darwin') execFileSync('open', [reportPath], execOpts);
    else if (platform === 'linux') execFileSync('xdg-open', [reportPath], execOpts);
    else if (platform === 'win32') execFileSync('cmd', ['/c', 'start', '', reportPath], execOpts);
    opened = true;
  } catch {
    // Could not open — user will need to open manually
  }

  return {
    type: 'dashboard',
    path: reportPath,
    opened,
  };
}
