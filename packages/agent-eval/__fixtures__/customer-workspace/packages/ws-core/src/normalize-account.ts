import type { AccountInput, NormalizedAccount } from './account-types.js';

/** Cross-package impact target for workspace gold tasks. */
export function normalizeAccount(input: AccountInput): NormalizedAccount {
  return {
    displayName: input.displayName.trim(),
    id: input.id.toLowerCase(),
  };
}
