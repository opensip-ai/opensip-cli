import { normalizeAccount } from '@fixture/ws-core';

import type { AccountInput, NormalizedAccount } from '@fixture/ws-core';

export function normalizeRequest(input: AccountInput): NormalizedAccount {
  return normalizeAccount(input);
}
