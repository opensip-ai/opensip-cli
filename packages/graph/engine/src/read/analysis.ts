/**
 * Public analysis wrappers over canonical graph algorithms.
 */

import { classifyCatalog, computeFilesFingerprint } from '../cache/invalidate.js';
import { buildFeatures } from '../pipeline/features.js';
import { buildIndexes } from '../pipeline/indexes.js';
import { orphanSubtreeRule } from '../rules/orphan-subtree.js';

import type {
  Catalog,
  CatalogVerdict,
  FeatureColumn,
  GraphConfig,
  Indexes,
  ValidationContext,
} from './types.js';
import type { FeatureTable } from '../types.js';
import type { Signal } from '@opensip-cli/core';

export function buildGraphReadIndexes(catalog: Catalog): Indexes {
  return buildIndexes(catalog);
}

export function deriveGraphReadFeatures(
  catalog: Catalog,
  indexes: Indexes,
  config: GraphConfig,
  columns: readonly FeatureColumn[] = ['blast'],
): FeatureTable {
  return buildFeatures(catalog, indexes, config, columns);
}

export function evaluateGraphOrphans(
  catalog: Catalog,
  indexes: Indexes,
  config: GraphConfig,
  features: FeatureTable,
): readonly Signal[] {
  return orphanSubtreeRule.evaluate(catalog, indexes, config, undefined, features);
}

export function classifyGraphReadCatalog(catalog: Catalog, ctx: ValidationContext): CatalogVerdict {
  return classifyCatalog(catalog, ctx);
}

export function computeGraphReadFilesFingerprint(files: readonly string[]): string {
  return computeFilesFingerprint(files);
}
