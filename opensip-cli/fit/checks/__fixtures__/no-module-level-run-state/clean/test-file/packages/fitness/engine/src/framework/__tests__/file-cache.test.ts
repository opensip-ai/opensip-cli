// FIXTURE — CLEAN: a test file.
//
// Isolated unit tests are allowed to seed/clear the barrel `fileCache`
// singleton directly — that is precisely why the barrel export is retained.
// The check excludes `*.test.ts` / `__tests__` (TEST_PATH), so this import
// does not trip it. The check must stay SILENT here.

import { fileCache } from '../file-cache.js';

export function seed(p: string, c: string): void {
  void fileCache;
  void p;
  void c;
}
