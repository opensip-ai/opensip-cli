// FIXTURE — CLEAN: the package barrel re-export (path-excluded).
//
// `index.ts` is the sanctioned test-only re-export site: `export { fileCache }`
// keeps the barrel symbol available to isolated unit tests. The check excludes
// `index.ts` (EXEMPT_PATH), so this re-export does not trip it even though it
// names the lowercase value. The check must stay SILENT here.

export { fileCache } from './framework/file-cache.js';
