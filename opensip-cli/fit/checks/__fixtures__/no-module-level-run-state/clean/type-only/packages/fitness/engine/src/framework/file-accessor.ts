// FIXTURE — CLEAN: type-only import.
//
// `import type { FileCache }` pulls in the TYPE, not the lowercase `fileCache`
// value binding. Allowed: a type-only import never creates a runtime read of
// the module singleton. The check must stay SILENT.

import type { FileCache } from './file-cache.js';

export interface AccessorOptions {
  readonly cache: FileCache;
}
