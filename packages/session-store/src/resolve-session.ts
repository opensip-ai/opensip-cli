import { SessionRepo } from './session-repo.js';

import type { StoredSession } from '@opensip-tools/contracts';
import type { ToolShortId } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

/**
 * A reference to one stored session: an explicit `ref` id, or the sentinel
 * `'latest'` (which requires a `tool` to disambiguate across tools).
 */
export type SessionReference =
  | { readonly ref: 'latest'; readonly tool?: ToolShortId }
  | { readonly ref: string; readonly tool?: ToolShortId };

/**
 * The outcome of {@link resolveSession}: either the resolved `session`, or a
 * failure carrying a machine-readable `reason` and a human `detail`.
 */
export type SessionResolveResult =
  | { readonly ok: true; readonly session: StoredSession }
  | {
      readonly ok: false;
      readonly reason: 'not-found' | 'wrong-tool' | 'ambiguous-latest';
      readonly detail: string;
    };

/**
 * Resolve a {@link SessionReference} against the datastore. `'latest'` returns
 * the most recent session for the given `tool` (and is ambiguous without one);
 * an explicit id is looked up directly and optionally tool-checked. Never
 * throws — every failure is a `{ ok: false, reason, detail }` result.
 */
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
