// FIXTURE — CLEAN: doc-comment / string mention only.
//
// The check runs on `strip-strings`-filtered content, so a `fileCache` /
// `globalFileCache` mention that lives ONLY inside a comment or a string
// literal is stripped before analysis and must NOT false-fire. There is no
// real import or identifier use here — only prose and a string. The check must
// stay SILENT.
//
// Prose mention (a comment): "import { fileCache } from './file-cache.js'"
// and the old "globalFileCache" alias — both are documentation, not code.

export const NOTE = "historically read the global fileCache / globalFileCache";

export function describe(): string {
  return "the per-run cache lives on scope.fitness.fileCache, not globalFileCache";
}
