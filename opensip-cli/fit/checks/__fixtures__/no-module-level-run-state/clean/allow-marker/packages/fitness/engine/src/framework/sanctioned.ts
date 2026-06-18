// FIXTURE — CLEAN: sanctioned exception via the inline escape hatch.
//
// A deliberate, reviewable exception carries `@allow-module-level-run-state
// <reason>` on the import line (or the line directly above). The marker
// suppresses the finding so the exception is visible in the diff rather than
// hidden behind a blanket config disable. The check must stay SILENT here.

// @allow-module-level-run-state fixture: demonstrates the sanctioned escape hatch
import { fileCache } from './file-cache.js';

export function legacy(): unknown {
  return fileCache;
}
