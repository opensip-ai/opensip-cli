// FIXTURE — CLEAN: per-run scope read.
//
// The sanctioned production shape: resolve the cache from the scope via the
// member access `currentScope()?.fitness?.fileCache`. The trailing `.fileCache`
// is a property read, not an imported/bare binding, so the check never matches
// it. The check must stay SILENT.

import { currentScope } from '@opensip-cli/core';

export function getCache() {
  const fc = currentScope()?.fitness?.fileCache;
  return fc;
}
