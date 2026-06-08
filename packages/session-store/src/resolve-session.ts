import { SessionRepo } from './session-repo.js';

import type { StoredSession } from '@opensip-tools/contracts';
import type { ToolShortId } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

export type SessionReference =
  | { readonly ref: 'latest'; readonly tool?: ToolShortId }
  | { readonly ref: string; readonly tool?: ToolShortId };

export type SessionResolveResult =
  | { readonly ok: true; readonly session: StoredSession }
  | {
      readonly ok: false;
      readonly reason: 'not-found' | 'wrong-tool' | 'ambiguous-latest';
      readonly detail: string;
    };

export function resolveSession(
  datastore: DataStore,
  reference: SessionReference,
): SessionResolveResult {
  const repo = new SessionRepo(datastore);
  if (reference.ref === 'latest') {
    if (reference.tool === undefined) {
      return {
        ok: false,
        reason: 'ambiguous-latest',
        detail: 'latest requires --tool fit|graph|sim',
      };
    }
    const session = repo.latest({ tool: reference.tool });
    if (session === null) {
      return {
        ok: false,
        reason: 'not-found',
        detail: `no ${reference.tool} session found; run opensip-tools ${reference.tool} first`,
      };
    }
    return { ok: true, session };
  }

  const session = repo.get(reference.ref);
  if (session === null) {
    return {
      ok: false,
      reason: 'not-found',
      detail: `session ${reference.ref} was not found`,
    };
  }
  if (reference.tool !== undefined && session.tool !== reference.tool) {
    return {
      ok: false,
      reason: 'wrong-tool',
      detail: `session ${session.id} is a ${session.tool} session, not ${reference.tool}`,
    };
  }
  return { ok: true, session };
}
