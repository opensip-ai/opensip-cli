/**
 * Inventory completeness gate (§8.1).
 *
 * Asserts the catalog produced by stage 0 + stage 1 against
 * packages/fitness/engine has the required scale plus the
 * spot-check assertions for src/gate.ts and src/framework/define-check.ts.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

import { discoverFiles } from '../../discover.js';
import { buildCatalog } from '../_pipeline.js';

import type { Catalog } from '@opensip-tools/graph';

function loadFitnessCatalog(): Catalog {
  const projectDir = resolve(HERE, '../../../../../fitness/engine');
  const discovery = discoverFiles({ projectDir });
  const inventory = buildCatalog({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    compilerOptions: discovery.compilerOptions,
    tsConfigPathAbs: discovery.tsConfigPathAbs,
  });
  return inventory.catalog;
}

function namesInFile(catalog: Catalog, filePath: string): string[] {
  const out: string[] = [];
  for (const occs of Object.values(catalog.functions)) {
    for (const o of occs) {
      if (o.filePath === filePath) out.push(o.simpleName);
    }
  }
  return out;
}

describe('inventory completeness (§8.1) against fitness/engine', () => {
  const catalog = loadFitnessCatalog();
  const fileSet = new Set<string>();
  let occurrenceCount = 0;
  for (const occs of Object.values(catalog.functions)) {
    for (const o of occs) {
      fileSet.add(o.filePath);
      occurrenceCount++;
    }
  }

  it('contains at least 91 files', () => {
    expect(fileSet.size).toBeGreaterThanOrEqual(91);
  });

  it('contains at least 200 function occurrences', () => {
    expect(occurrenceCount).toBeGreaterThanOrEqual(200);
  });

  it('captures the renderGateCompareOutput function in src/cli/fit/gate-compare-render.ts', () => {
    // (Was src/gate.ts's saveBaseline/compareToBaseline — gate.ts was deleted when
    // fitness moved onto the host baseline plane, ADR-0036. This file's exported
    // function declarations demonstrate the same inventory-completeness property.)
    const names = namesInFile(catalog, 'src/cli/fit/gate-compare-render.ts');
    expect(names).toContain('renderGateCompareOutput');
  });

  it('captures the defineCheck function in src/framework/define-check.ts', () => {
    const names = namesInFile(catalog, 'src/framework/define-check.ts');
    expect(names).toContain('defineCheck');
  });

  it('synthesizes a module-init occurrence for every file', () => {
    let modInits = 0;
    for (const occs of Object.values(catalog.functions)) {
      for (const o of occs) if (o.kind === 'module-init') modInits++;
    }
    expect(modInits).toBe(fileSet.size);
  });
});
