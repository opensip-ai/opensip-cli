#!/usr/bin/env node
/**
 * Load the catalogued ToolCliContext seam exemptions (single source for ESLint
 * ignores and project-local fitness checks).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST_PATH = join(REPO_ROOT, 'opensip-cli', 'seam-exemptions.json');

/** @returns {import('./load-seam-exemptions.mjs').SeamExemptionsManifest} */
export function loadSeamExemptions() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

/**
 * @param {string} filePath
 * @param {string} checkSlug
 * @param {ReturnType<typeof loadSeamExemptions>} [manifest]
 */
export function isSeamExempt(filePath, checkSlug, manifest = loadSeamExemptions()) {
  const normalized = filePath.replaceAll('\\', '/');
  for (const entry of manifest.exemptions) {
    if (entry.checks && !entry.checks.includes(checkSlug)) continue;
    if (entry.path && normalized.endsWith(entry.path)) return true;
    if (entry.pathSuffix && normalized.endsWith(entry.pathSuffix)) return true;
    if (entry.pathPattern && new RegExp(entry.pathPattern).test(normalized)) return true;
  }
  return false;
}

/** Paths that ESLint should ignore for no-restricted-properties stdout rules. */
export function eslintStdoutIgnorePaths(manifest = loadSeamExemptions()) {
  return manifest.exemptions
    .filter((entry) => entry.eslintIgnore === true && typeof entry.path === 'string')
    .map((entry) => entry.path);
}
