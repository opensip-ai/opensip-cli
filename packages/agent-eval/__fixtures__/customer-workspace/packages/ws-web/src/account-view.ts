import { normalizeAccount } from '@fixture/ws-api';

export function renderAccount(displayName: string, id: string): string {
  const account = normalizeAccount({ displayName, id });
  return `${account.displayName} (${account.id})`;
}
