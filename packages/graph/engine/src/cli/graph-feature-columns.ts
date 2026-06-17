import type { FeatureColumn } from '../types.js';

/**
 * Feature columns materialized into the persisted graph catalog for dashboard
 * rendering (ADR-0006). Export/carry-only paths stay lean by opting out.
 */
export const DASHBOARD_FEATURE_COLUMNS: readonly FeatureColumn[] = [
  'blast',
  'scc',
  'packageCoupling',
];
