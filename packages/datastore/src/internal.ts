/**
 * @fileoverview `@opensip-cli/datastore/internal` — raw Drizzle handle access
 * for sibling persistence packages (`session-store`, `graph/engine` persistence).
 *
 * This is NOT public API. Tool packages and CLI command handlers must not import
 * from `@opensip-cli/datastore/internal` (ADR-0107, `restrict-raw-db-access`).
 * General consumers stay on the public barrel's repository-only surface.
 */

export { isDrizzleDataStore, requireDrizzleHandle } from './data-store.js';

export type { DrizzleDataStore, DrizzleHandle } from './data-store.js';
