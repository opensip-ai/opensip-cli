/** Bounded detail projection for one exact callable occurrence. */

import { err, ok, type Result } from '@opensip-cli/core';

import { makeFacet, rollupFacets, UNREQUESTED_FACET } from './bounded-view.js';
import { toGraphSymbolRef } from './query-contracts.js';
import { failGraphRead } from './read-boundary-failure.js';

import type { GraphReadFacetCoverage, GraphSymbolRef } from './query-contracts.js';
import type { Catalog, FeatureTable, GraphReadError, Indexes, GraphReadReason } from './types.js';

const MAX_PARAMETERS = 64;
const MAX_DECORATORS = 32;
const MAX_DETAIL_TEXT = 512;
const DECORATOR_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|::)[A-Za-z_$][A-Za-z0-9_$]*)*/u;
const QUALIFIED_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|::)[A-Za-z_$][A-Za-z0-9_$]*)*$/u;
const PARAMETER_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const TYPE_TEXT = /^[A-Za-z0-9_$.:<>,[\]()|&?*\-\s]+$/u;
const NUMERIC_TYPE_LITERAL = /(?:^|[^A-Za-z0-9_$])[-+]?\d+(?:\.\d+)?(?:$|[^A-Za-z0-9_$])/u;
const MALFORMED_DECORATOR_REASON = 'entity-detail-malformed-decorator';

/** Source-free callable parameter metadata safe for graph/read consumers. */
export interface GraphEntityParameter {
  readonly name: string;
  readonly optional: boolean;
  readonly rest: boolean;
}

/** Exact, source-free detail for one callable occurrence. */
export interface GraphEntityDetail {
  readonly symbol: GraphSymbolRef;
  readonly endLine: number;
  readonly parameters: readonly GraphEntityParameter[];
  readonly returnType: string | null;
  readonly enclosingClass: string | null;
  readonly decorators: readonly string[];
  readonly testReachability: {
    readonly testReachable?: boolean;
    readonly reachableOnlyFromTests?: boolean;
  };
  readonly coverage: GraphReadFacetCoverage;
}

function detailError(code: GraphReadReason, message: string): GraphReadError {
  return { code, operation: 'analysis', message };
}

function safeOptionalText(value: unknown, reasons: Set<string>): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    reasons.add('entity-detail-malformed-text');
    return null;
  }
  if (value.length === 0 || value.length > MAX_DETAIL_TEXT || /\p{Cc}/u.test(value)) {
    reasons.add('entity-detail-malformed-text');
    return null;
  }
  return value;
}

function safeReturnType(value: unknown, reasons: Set<string>): string | null {
  const safe = safeOptionalText(value, reasons);
  if (safe === null) return null;
  const normalized = safe.trim();
  if (
    normalized.length === 0 ||
    !TYPE_TEXT.test(normalized) ||
    /['"`{};=\\]/u.test(normalized) ||
    NUMERIC_TYPE_LITERAL.test(normalized)
  ) {
    reasons.add('entity-detail-literal-type-redacted');
    return null;
  }
  return normalized;
}

function safeEnclosingClass(value: unknown, reasons: Set<string>): string | null {
  const safe = safeOptionalText(value, reasons);
  if (safe === null) return null;
  const normalized = safe.trim();
  if (!QUALIFIED_NAME.test(normalized)) {
    reasons.add('entity-detail-malformed-class-name');
    return null;
  }
  return normalized;
}

/** Project only an annotation/decorator/attribute name, never its source arguments. */
function decoratorName(value: string, reasons: Set<string>): string | undefined {
  if (value.length === 0 || value.length > MAX_DETAIL_TEXT || /\p{Cc}/u.test(value)) {
    reasons.add(MALFORMED_DECORATOR_REASON);
    return;
  }
  let candidate = value.trim();
  if (candidate.startsWith('#![') || candidate.startsWith('#[')) {
    if (!candidate.endsWith(']')) {
      reasons.add(MALFORMED_DECORATOR_REASON);
      return;
    }
    candidate = candidate.slice(candidate.startsWith('#![') ? 3 : 2, -1).trim();
  } else if (candidate.startsWith('@')) {
    candidate = candidate.slice(1).trimStart();
  }
  const match = DECORATOR_NAME.exec(candidate);
  if (match === null) {
    reasons.add(MALFORMED_DECORATOR_REASON);
    return;
  }
  const remainder = candidate.slice(match[0].length).trimStart();
  if (remainder.length > 0 && !remainder.startsWith('(')) {
    reasons.add(MALFORMED_DECORATOR_REASON);
    return;
  }
  // Rust attributes were required to close above; ordinary decorators may be a
  // bare name or a call expression. In both cases the returned value is only
  // the bounded syntactic name, never arguments, literals, or source snippets.
  return match[0];
}

/** Project exact entity detail from one immutable catalog generation. */
export function projectEntityDetail(
  catalog: Catalog,
  indexes: Indexes,
  symbolId: string,
  features?: FeatureTable,
): Result<GraphEntityDetail | null, GraphReadError> {
  if (symbolId.length === 0 || symbolId.length > 2048 || /\p{Cc}/u.test(symbolId)) {
    return err(detailError('entity-id-invalid', 'Entity symbol ID is invalid or oversized'));
  }
  try {
    const occurrence = indexes.byOccId.get(symbolId);
    if (occurrence === undefined) return ok(null);
    const symbol = toGraphSymbolRef(occurrence);
    if (symbol === undefined) {
      return err(detailError('entity-malformed', 'Entity identity cannot be projected safely'));
    }
    const reasons = new Set<string>();
    const rawParameters: readonly unknown[] = Array.isArray(occurrence.params)
      ? occurrence.params
      : [];
    if (!Array.isArray(occurrence.params)) reasons.add('entity-detail-malformed-parameter');
    const parameters = rawParameters.slice(0, MAX_PARAMETERS).flatMap((parameter) => {
      if (typeof parameter !== 'object' || parameter === null) {
        reasons.add('entity-detail-malformed-parameter');
        return [];
      }
      const value = parameter as Record<string, unknown>;
      if (
        typeof value.name !== 'string' ||
        value.name.length === 0 ||
        value.name.length > MAX_DETAIL_TEXT ||
        /\p{Cc}/u.test(value.name) ||
        !PARAMETER_NAME.test(value.name) ||
        typeof value.optional !== 'boolean' ||
        typeof value.rest !== 'boolean'
      ) {
        reasons.add('entity-detail-malformed-parameter');
        return [];
      }
      return [
        {
          name: value.name,
          optional: value.optional,
          rest: value.rest,
        },
      ];
    });
    if (rawParameters.length > MAX_PARAMETERS) reasons.add('entity-parameter-cap');
    const rawDecorators: readonly unknown[] = Array.isArray(occurrence.decorators)
      ? occurrence.decorators
      : [];
    if (!Array.isArray(occurrence.decorators)) reasons.add(MALFORMED_DECORATOR_REASON);
    const decorators = rawDecorators.slice(0, MAX_DECORATORS).flatMap((decorator) => {
      if (typeof decorator !== 'string') {
        reasons.add(MALFORMED_DECORATOR_REASON);
        return [];
      }
      const name = decoratorName(decorator, reasons);
      return name === undefined ? [] : [name];
    });
    if (rawDecorators.length > MAX_DECORATORS) reasons.add('entity-decorator-cap');
    const feature =
      features?.function.get(occurrence.bodyHash) ??
      catalog.features?.function?.[occurrence.bodyHash];
    const testReachable = feature?.testReachable;
    const reachableOnlyFromTests = feature?.reachableOnlyFromTests;
    if (
      (testReachable !== undefined && typeof testReachable !== 'boolean') ||
      (reachableOnlyFromTests !== undefined && typeof reachableOnlyFromTests !== 'boolean')
    ) {
      reasons.add('entity-detail-malformed-feature');
    }
    return ok({
      symbol,
      endLine: occurrence.endLine,
      parameters,
      returnType: safeReturnType(occurrence.returnType, reasons),
      enclosingClass: safeEnclosingClass(occurrence.enclosingClass, reasons),
      decorators,
      testReachability: {
        ...(typeof testReachable === 'boolean' ? { testReachable } : {}),
        ...(typeof reachableOnlyFromTests === 'boolean' ? { reachableOnlyFromTests } : {}),
      },
      coverage: rollupFacets({
        inventory: makeFacet(true, new Set()),
        evidence: makeFacet(true, reasons),
        grouping: UNREQUESTED_FACET,
        projection: makeFacet(true, reasons),
      }),
    });
  } catch (error) {
    return failGraphRead(error, {
      boundary: 'projection',
      condition: 'entity-detail',
      module: 'graph:read:entity-detail',
      reason: 'entity-failed',
      operation: 'analysis',
      message: 'Failed to project graph entity detail',
    });
  }
}
