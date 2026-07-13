import { isUnknownRecord as isRecord } from '../model/value-helpers.js';

export interface NativeReadPayload {
  readonly content: string;
  readonly path: string;
}

export interface NativeSearchMatch {
  readonly context?: string;
  readonly contextStartLine?: number;
  readonly line?: number;
  readonly path: string;
  readonly text: string;
}

/** Validate the stable payload returned by the native read-file adapter. */
export function asNativeReadPayload(payload: unknown): NativeReadPayload | undefined {
  if (
    !isRecord(payload) ||
    typeof payload.content !== 'string' ||
    typeof payload.path !== 'string'
  ) {
    return undefined;
  }
  return { content: payload.content, path: payload.path };
}

/** Validate the stable match list returned by the native content-search adapter. */
export function nativeSearchMatches(payload: unknown): readonly NativeSearchMatch[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.matches)) return undefined;
  if (
    !payload.matches.every(
      (candidate) =>
        isRecord(candidate) &&
        typeof candidate.path === 'string' &&
        typeof candidate.text === 'string' &&
        (candidate.context === undefined || typeof candidate.context === 'string') &&
        (candidate.contextStartLine === undefined ||
          (typeof candidate.contextStartLine === 'number' &&
            Number.isSafeInteger(candidate.contextStartLine))) &&
        (candidate.line === undefined ||
          (typeof candidate.line === 'number' && Number.isSafeInteger(candidate.line))),
    )
  ) {
    return undefined;
  }
  return payload.matches as readonly NativeSearchMatch[];
}
