/**
 * graph-specific typed errors (AC-7).
 *
 * Most failures use the existing core error subclasses
 * (ConfigurationError, SystemError, ValidationError). A graph-specific
 * domain (catalog corruption) gets its own subclass so callers can
 * narrow on it without string-matching messages.
 */

import { SystemError } from '@opensip-tools/core';

/** Raised when a catalog file fails integrity checks during cache read. */
export class CatalogIntegrityError extends SystemError {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogIntegrityError';
  }
}
