// FIXTURE — CLEAN: a non-tool-engine path.
//
// The check is path-gated to `packages/(fitness|graph|simulation)/engine/src/`.
// A CLI (or output/dashboard/core) file is OUTSIDE that gate, so the check is
// inert here even if it imported the lowercase value. The check must stay
// SILENT on non-engine paths.

import { fileCache } from './file-cache.js';

export function host(): unknown {
  return fileCache;
}
