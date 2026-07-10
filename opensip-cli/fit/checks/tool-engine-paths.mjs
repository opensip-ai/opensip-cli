/**
 * tool-engine-paths — production Tool path predicates derived from workspace
 * package manifests (opensipTools.kind === 'tool'), not hardcoded lists.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const { createToolPathPredicates, readProductionToolPackageInventory } = require(
  join(REPO_ROOT, 'scripts/lib/workspace-tool-package-inventory.cjs'),
);

const predicates = createToolPathPredicates(REPO_ROOT);
const inventory = readProductionToolPackageInventory(REPO_ROOT);

export const productionToolInventory = inventory;
export const bundledToolPackageSegments = Object.freeze(
  inventory
    .filter((t) => t.bundled)
    .map((t) => {
      const m = /^@opensip-cli\/(.+)$/.exec(t.name);
      return m?.[1] ?? t.name;
    }),
);

export const toolSeamPackageSegments = Object.freeze(
  inventory.map((t) => {
    const m = /^@opensip-cli\/(.+)$/.exec(t.name);
    return m?.[1] ?? t.name;
  }),
);

export function toolEnginePathRe(suffix = '') {
  return predicates.toolEnginePathRe(suffix);
}

export function toolSeamPathRe(suffix = '') {
  return predicates.toolSeamPathRe(suffix);
}

export function toolEngineCliPathRe(suffix = '') {
  return predicates.toolEnginePathRe(`cli/${suffix}`);
}

export function toolDescriptorPathRe() {
  // Match absolute or relative paths ending at a tool descriptor (test fixtures
  // use `/repo/packages/.../tool.ts`; production fit uses repo-relative paths).
  const descriptors = predicates.inventory
    .filter((t) => !t.adapterSubstrate && typeof t.descriptorRelative === 'string')
    .map((t) => t.descriptorRelative.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'));
  if (descriptors.length === 0) return /$^/;
  return new RegExp(`(?:${descriptors.join('|')})$`);
}

export function toolPackagePathRe(suffix = '') {
  // Match any production tool package root (engine or package-root src).
  const roots = inventory.filter((t) => !t.adapterSubstrate).map((t) => t.relativeDir + '/');
  if (roots.length === 0) return /$^/;
  const escapeRe = (value) => value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  return new RegExp(`(?:${roots.map(escapeRe).join('|')})${suffix}`);
}

export function toolPackageSegmentForPath(filePath) {
  const norm = String(filePath).replaceAll('\\', '/');
  for (const tool of inventory) {
    if (norm.includes(tool.sourceRoot) || norm.includes(tool.relativeDir + '/')) {
      const m = /^@opensip-cli\/(.+)$/.exec(tool.name);
      return m?.[1] ?? tool.name;
    }
  }
  return undefined;
}
