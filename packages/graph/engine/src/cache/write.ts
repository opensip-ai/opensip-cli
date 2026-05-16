/**
 * Cache write (skeleton; implemented in P6).
 *
 * Atomic write via tmp + rename so concurrent runs can't tear the
 * catalog file.
 */

import type { Catalog } from '../types.js';

export function writeCatalog(_catalogPath: string, _catalog: Catalog): void {
  // Implemented in Phase P6.
}
