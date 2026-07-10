/**
 * @opensip-cli/graph/read — stable public read/rebuild facade (ADR-0147).
 *
 * Free functions returning Result / canonical DTOs. Repositories, rules, and
 * orchestration remain private. MCP and other consumers import this subpath only.
 */

export { readCatalogIdentity, loadCatalogGeneration } from './catalog.js';
export {
  buildGraphReadIndexes,
  deriveGraphReadFeatures,
  evaluateGraphOrphans,
  classifyGraphReadCatalog,
  computeGraphReadFilesFingerprint,
} from './analysis.js';
export { rebuildCatalog } from './rebuild.js';

export type {
  GraphReadError,
  GraphReadOperation,
  CatalogIdentity,
  RebuildCatalogInput,
  CatalogVerdict,
  ValidationContext,
  Catalog,
  Indexes,
  FeatureColumn,
  GraphConfig,
} from './types.js';
