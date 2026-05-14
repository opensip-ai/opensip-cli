/**
 * dashboard command — generate HTML report and open in browser
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  loadSessions,
  getReportsDir,
  generateDashboardHtml,
  type CheckCatalogEntry,
  type RecipeCatalogEntry,
  type DashboardResult,
} from '@opensip-tools/cli-shared';

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

  const html = generateDashboardHtml(sessions, catalog, recipes);
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
