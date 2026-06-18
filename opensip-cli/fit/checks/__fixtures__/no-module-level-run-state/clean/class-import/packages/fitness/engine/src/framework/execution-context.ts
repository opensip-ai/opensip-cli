// FIXTURE — CLEAN: FileCache CLASS value import.
//
// Importing the `FileCache` CLASS (uppercase) is allowed: production constructs
// the per-run cache inside contributeScope() / the recipe service. The check
// matches the lowercase `fileCache` value binding specifically, never the
// `FileCache` class. The check must stay SILENT.

import { FileCache } from './file-cache.js';

export function makeCache(): FileCache {
  return new FileCache();
}
