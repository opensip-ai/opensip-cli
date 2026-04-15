/**
 * dashboard command — generate HTML report and open in browser
 */

import { defaultRegistry, defaultRecipeRegistry } from '@opensip-tools/core';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadSessions, getReportsDir, type CheckCatalogEntry, type RecipeCatalogEntry } from '../persistence/store.js';
import { generateDashboardHtml } from '../persistence/dashboard/index.js';
import { ensureChecksLoaded } from './fit.js';
import type { DashboardResult } from '../types.js';

// We need access to getCheckDisplayName and getCheckIcon after loading
let getCheckDisplayName: (slug: string) => string = (slug) =>
  slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
let getCheckIcon: (slug: string) => string = () => '\uD83D\uDD0D';

// ---------------------------------------------------------------------------
// openDashboard
// ---------------------------------------------------------------------------

export async function openDashboard(): Promise<DashboardResult> {
  await ensureChecksLoaded();

  // After loading, pull display helpers from checks-builtin
  try {
    const builtin = await import('@opensip-tools/checks-builtin');
    getCheckDisplayName = builtin.getCheckDisplayName;
    getCheckIcon = builtin.getCheckIcon;
  } catch { /* use defaults */ }

  const sessions = loadSessions(20);

  // Collect check catalog from registry — determine source from namespace
  const BUILTIN_NAMESPACE = '@opensip-tools/checks-builtin';
  const catalog: CheckCatalogEntry[] = defaultRegistry.list().map(check => {
    const namespace = defaultRegistry.getNamespace(check.config.slug);
    const source = (namespace === BUILTIN_NAMESPACE ? 'built-in' : 'community') as 'built-in' | 'community';
    return {
      slug: check.config.slug,
      name: getCheckDisplayName(check.config.slug),
      icon: getCheckIcon(check.config.slug),
      description: check.config.description,
      longDescription: check.config.longDescription,
      tags: [...(check.config.tags ?? [])],
      confidence: check.config.confidence ?? 'medium',
      source,
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
  writeFileSync(reportPath, html, 'utf-8');

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
