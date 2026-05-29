// @fitness-ignore-file error-handling-quality -- dashboard is a best-effort UX action: signalers-config load failures degrade gracefully to ungoverned mode (surfaced separately by the fitness run), and browser launch failures fall through to "open manually" (the report file path is already returned to the user).
/**
 * dashboard command — generate HTML report and open in browser
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync , mkdirSync } from 'node:fs';
import { join } from 'node:path';


import {
  SessionRepo,
  type GraphCatalog,
  type DashboardResult,
} from '@opensip-tools/contracts';
import { logger, resolveProjectPaths } from '@opensip-tools/core';
import { generateDashboardHtml } from '@opensip-tools/dashboard';
import { CatalogRepo } from '@opensip-tools/graph';


import { defaultRegistry } from '../framework/registry.js';
import { defaultRecipeRegistry } from '../recipes/registry.js';
import { loadSignalersConfig } from '../signalers/index.js';

import { ensureChecksLoaded, getDisplayName, getIcon } from './fit.js';

import type { DataStore } from '@opensip-tools/datastore';

// ---------------------------------------------------------------------------
// Dashboard catalog entries (fitness-owned)
//
// Audit 2026-05-29 (L1): these describe fitness's check/recipe catalogs
// rendered on the dashboard. They are fitness domain vocabulary, so they
// live here rather than in @opensip-tools/contracts. The dashboard, as
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
 * Read the graph catalog for the dashboard's Code Paths panel via graph's
 * typed {@link CatalogRepo}. Returns null when no datastore is available
 * (e.g. the auto-open flow that doesn't pass one) or when the catalog is
 * empty — the dashboard renders the panel in a no-data state.
 *
 * History (audit 2026-05-29, H1): this used to read `graph_catalog` with
 * raw SQL because a `fitness → graph` import would have closed a cycle
 * (graph → fitness existed via reportToCloud). That cycle was removed by
 * relocating the SARIF/reportToCloud module to @opensip-tools/contracts
 * (M1), so fitness now consumes graph's catalog through the supported
 * `CatalogRepo.loadCatalogContract()` seam — typed, no hardcoded table
 * name, and it can't silently drift from graph's schema.
 */
function loadGraphCatalog(datastore?: DataStore): GraphCatalog | null {
  if (!datastore) return null;
  try {
    const catalog = new CatalogRepo(datastore).loadCatalogContract();
    if (!catalog) {
      logger.info({
        evt: 'graph.dashboard.catalog.miss',
        module: 'fitness:dashboard',
        msg: 'No graph catalog in datastore; rendering panel without it',
      });
      return null;
    }
    logger.info({
      evt: 'graph.dashboard.catalog.load',
      module: 'fitness:dashboard',
      msg: 'Loaded graph catalog from datastore',
      functions: Object.keys(catalog.functions).length,
    });
    return catalog;
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

/** Renders the fitness HTML dashboard to a temp file and returns its path + URL. */
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
