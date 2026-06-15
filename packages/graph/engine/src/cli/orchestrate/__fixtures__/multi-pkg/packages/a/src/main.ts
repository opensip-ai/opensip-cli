// @fixture/a — the caller package.
//
// Three call edges the equivalence gate pins down:
//   1. main -> @fixture/foundation.canonicalize  (GENUINE cross-package edge,
//      bare workspace specifier). Must resolve to FOUNDATION's canonicalize.
//   2. main -> ./local.formatLocal               (relative INTRA-package edge,
//      path-pinned — the pinBySpecifier regression case).
//   3. NO edge main -> @fixture/b.canonicalize   (the phantom trap: pkg-a does
//      NOT import @fixture/b, so its same-named canonicalize must never link).

import { canonicalize } from '@fixture/foundation';

import { formatLocal } from './local.js';

export function main(input: unknown): string {
  const normalized = canonicalize(input);
  return formatLocal(normalized);
}
