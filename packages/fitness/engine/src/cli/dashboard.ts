/**
 * dashboard command — generate HTML report and open in browser
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  loadSessions,
  getReportsDir,
  type CheckCatalogEntry,
  type GraphCatalog,
  type RecipeCatalogEntry,
  type DashboardResult,
} from '@opensip-tools/contracts';
import { logger, resolveProjectPaths } from '@opensip-tools/core';
import { generateDashboardHtml } from '@opensip-tools/dashboard';

import { defaultRegistry } from '../framework/registry.js';
import { defaultRecipeRegistry } from '../recipes/registry.js';

import { ensureChecksLoaded, getDisplayName, getIcon } from './fit.js';

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
 * Read the project's `dashboard.editor` value (if any) from
 * opensip-tools.config.yml. The Code Paths panel embeds it as a JS
 * constant so the Function Card can produce vscode://, cursor://, etc.
 * deep links.
 */
function loadEditorProtocol(projectDir?: string): string | null {
  const candidates = [
    join(projectDir ?? process.cwd(), 'opensip-tools.config.yml'),
    join(projectDir ?? process.cwd(), 'opensip-tools.config.yaml'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const raw = readFileSync(candidate, 'utf8');
      const value = extractDashboardEditor(raw);
      if (value) return value;
    } catch {
      // ignore — config absence is normal
    }
  }
  return null;
}

/**
 * Linear-time line-walker that finds `dashboard.editor` in a YAML file
 * without pulling in js-yaml. Scans for a top-level `dashboard:` key,
 * then within its indented block looks for an `editor:` key.
 */
function extractDashboardEditor(raw: string): string | null {
  const lines = raw.split('\n');
  let inDashboardBlock = false;
  let dashboardIndent = -1;
  for (const line of lines) {
    if (line.trim().length === 0 || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (!inDashboardBlock) {
      if (/^dashboard\s*:\s*$/.test(line)) {
        inDashboardBlock = true;
        dashboardIndent = indent;
      }
      continue;
    }
    // Exited the dashboard block (dedent to or below the dashboard line).
    if (indent <= dashboardIndent) break;
    const m = /^\s*editor\s*:\s*['"]?([\w-]+)['"]?\s*$/.exec(line);
    if (m?.[1]) return m[1];
  }
  return null;
}

/**
 * Read the v0.2 graph catalog if it exists, otherwise return null. Parse
 * errors are logged and treated as "no catalog" — never fatal.
 */
function loadGraphCatalog(projectDir?: string): GraphCatalog | null {
  const paths = resolveProjectPaths(projectDir ?? process.cwd());
  const catalogPath = paths.graphCatalogPath;
  if (!existsSync(catalogPath)) return null;
  try {
    const raw = readFileSync(catalogPath, 'utf8');
    const parsed = JSON.parse(raw) as GraphCatalog;
    logger.info({ evt: 'graph.dashboard.catalog.load', module: 'fitness:dashboard', msg: 'Loaded graph catalog', catalogPath });
    return parsed;
  } catch (error) {
    logger.warn({
      evt: 'graph.dashboard.catalog.parse-error',
      module: 'fitness:dashboard',
      msg: 'Failed to parse graph catalog; rendering panel without it',
      catalogPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function openDashboard(projectDir?: string): Promise<DashboardResult> {
  await ensureChecksLoaded(projectDir);

  const sessions = loadSessions(20);

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

  const graphCatalog = loadGraphCatalog(projectDir);
  const editorProtocol = loadEditorProtocol(projectDir);

  const html = generateDashboardHtml(sessions, catalog, recipes, graphCatalog, editorProtocol);
  const reportPath = join(getReportsDir(), 'latest.html');
  writeFileSync(reportPath, html, 'utf8');

  // Try to open in browser
  let opened = false;
  try {
    const platform = process.platform;
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
