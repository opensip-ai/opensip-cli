// FIXTURE — CLEAN: the FileCache DEFINITION file (path-excluded).
//
// `framework/file-cache.ts` is the one file that legitimately declares
// `export const fileCache = new FileCache()` — it OWNS the test-only singleton.
// The check excludes this path (EXEMPT_PATH) so the definition does not trip it
// (no-module-singleton.mjs exempts the same file). Even though this file
// contains the forbidden lowercase value, the check must stay SILENT here.

export class FileCache {}

export const fileCache = new FileCache();
