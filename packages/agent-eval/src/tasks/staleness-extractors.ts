import { isUnknownRecord as isRecord, uniqueFacts } from '../model/value-helpers.js';

import { extractSymbolSearch } from './task-response-extractors.js';

import type { AnswerFact, ResponseExtractor } from '../model/task.js';

function nestedArray(payload: unknown, parent: string, child: string): readonly unknown[] {
  if (!isRecord(payload) || !isRecord(payload[parent])) return [];
  const value = payload[parent][child];
  return Array.isArray(value) ? value : [];
}

/** Normalize only native search payload bytes; task truth never enters extraction. */
export const extractNativeMatchFacts: ResponseExtractor = (payload) => {
  if (!isRecord(payload) || !Array.isArray(payload.matches)) return [];
  return uniqueFacts(
    payload.matches.flatMap((candidate): readonly AnswerFact[] => {
      if (!isRecord(candidate) || typeof candidate.path !== 'string') return [];
      return [{ kind: 'file', path: candidate.path, role: 'match' }];
    }),
  );
};

/** Normalize only native glob payload bytes; an empty complete page stays empty. */
export const extractNativePathFacts: ResponseExtractor = (payload) => {
  if (!isRecord(payload) || !Array.isArray(payload.paths)) return [];
  return uniqueFacts(
    payload.paths.flatMap((path): readonly AnswerFact[] =>
      typeof path === 'string' ? [{ kind: 'file', path }] : [],
    ),
  );
};

function symbolName(symbol: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof symbol.simpleName === 'string') return symbol.simpleName;
  if (typeof symbol.name === 'string') return symbol.name;
  return undefined;
}

function symbolHandleFact(
  symbol: Readonly<Record<string, unknown>>,
  name: string | undefined,
  filePath: string | undefined,
): AnswerFact | undefined {
  if (typeof symbol.symbolId !== 'string') return undefined;
  return {
    ...(typeof symbol.bodyHash === 'string' ? { bodyHash: symbol.bodyHash } : {}),
    ...(typeof symbol.column === 'number' ? { column: symbol.column } : {}),
    ...(filePath === undefined ? {} : { filePath }),
    ...(typeof symbol.inTestFile === 'boolean' ? { inTestFile: symbol.inTestFile } : {}),
    kind: 'symbol-handle',
    ...(typeof symbol.line === 'number' ? { line: symbol.line } : {}),
    ...(name === undefined ? {} : { name }),
    ...(typeof symbol.package === 'string' ? { package: symbol.package } : {}),
    ...(typeof symbol.qualifiedName === 'string' ? { qualifiedName: symbol.qualifiedName } : {}),
    symbolId: symbol.symbolId,
  };
}

function symbolFacts(symbol: Readonly<Record<string, unknown>>): readonly AnswerFact[] {
  const name = symbolName(symbol);
  const filePath = typeof symbol.filePath === 'string' ? symbol.filePath : undefined;
  const facts: AnswerFact[] = [];
  const handle = symbolHandleFact(symbol, name, filePath);
  if (handle !== undefined) facts.push(handle);
  if (name !== undefined) {
    facts.push({
      ...(filePath === undefined ? {} : { filePath }),
      kind: 'symbol',
      name,
    });
  }
  if (filePath !== undefined) {
    facts.push({ kind: 'file', path: filePath, role: 'symbol-definition' });
  }
  return facts;
}

/** Normalize search_symbols through the shared exact public-symbol projection. */
export const extractSearchSymbolFacts: ResponseExtractor = extractSymbolSearch;

function evidenceSubject(symbol: Readonly<Record<string, unknown>>): string {
  if (typeof symbol.symbolId === 'string') return symbol.symbolId;
  if (typeof symbol.simpleName === 'string') return symbol.simpleName;
  return 'caller';
}

function callerEvidenceFact(
  symbol: Readonly<Record<string, unknown>>,
  evidence: Readonly<Record<string, unknown>>,
  filePath: string | undefined,
): AnswerFact {
  return {
    ...(typeof evidence.confidence === 'string' ? { confidence: evidence.confidence } : {}),
    ...(typeof evidence.kind === 'string' ? { evidenceKind: evidence.kind } : {}),
    ...(filePath === undefined ? {} : { filePath }),
    kind: 'evidence',
    ...(typeof evidence.resolution === 'string' ? { resolution: evidence.resolution } : {}),
    subject: evidenceSubject(symbol),
  };
}

function callerFacts(node: Readonly<Record<string, unknown>>): readonly AnswerFact[] {
  if (typeof node.depth !== 'number' || node.depth <= 0 || !isRecord(node.symbol)) return [];
  const facts = [...symbolFacts(node.symbol)];
  const filePath = typeof node.symbol.filePath === 'string' ? node.symbol.filePath : undefined;
  if (filePath !== undefined) facts.push({ kind: 'file', path: filePath, role: 'caller' });
  if (isRecord(node.incomingEvidence)) {
    facts.push(callerEvidenceFact(node.symbol, node.incomingEvidence, filePath));
  }
  return facts;
}

/** Normalize who_calls' public `data.nodes[].symbol` projection and edge evidence. */
export const extractCallerFacts: ResponseExtractor = (payload) =>
  uniqueFacts(
    nestedArray(payload, 'data', 'nodes').flatMap((candidate) =>
      isRecord(candidate) ? callerFacts(candidate) : [],
    ),
  );

/** Normalize refresh action/freshness without assuming a recovery outcome. */
export const extractRefreshFacts: ResponseExtractor = (payload) => {
  if (!isRecord(payload)) return [];
  const facts: AnswerFact[] = [];
  if (isRecord(payload.data) && typeof payload.data.action === 'string') {
    facts.push({
      kind: 'text',
      label: 'refresh-action',
      value: payload.data.action,
    });
  }
  if (isRecord(payload.freshness) && typeof payload.freshness.fresh === 'boolean') {
    facts.push({
      ...(isRecord(payload.context) &&
      isRecord(payload.context.catalog) &&
      typeof payload.context.catalog.identity === 'string'
        ? { catalogIdentity: payload.context.catalog.identity }
        : {}),
      fresh: payload.freshness.fresh,
      kind: 'freshness',
      ...(typeof payload.freshness.reasonCode === 'string'
        ? { reasonCode: payload.freshness.reasonCode }
        : {}),
      ...(payload.freshness.verification === 'complete' ||
      payload.freshness.verification === 'missing' ||
      payload.freshness.verification === 'partial'
        ? { verification: payload.freshness.verification }
        : {}),
    });
  }
  return facts;
};
